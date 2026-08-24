import * as vscode from "vscode";
import * as fs from "node:fs";
import { fetchUsage, getCached, UsageResult } from "./usage";
import { StatusBar } from "./statusbar";
import { UsageViewProvider } from "./view";
import { downloadVsix, fetchLatestRelease, isNewer, UpdateInfo } from "./update";

const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const LAST_CHECK_KEY = "cursorUsage.lastUpdateCheck";
const SKIPPED_VERSION_KEY = "cursorUsage.skippedVersion";
/** After a failed refresh, try again well before the next regular poll. */
const RETRY_AFTER_FAILURE_MS = 65_000;

let statusBar: StatusBar | undefined;
let viewProvider: UsageViewProvider | undefined;
let pollTimer: ReturnType<typeof setInterval> | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let refreshing = false;

export function activate(context: vscode.ExtensionContext): void {
  const cfg = () => vscode.workspace.getConfiguration("cursorUsage");

  const version = (context.extension.packageJSON as { version?: string }).version ?? "0.0.0";

  statusBar = new StatusBar(version);
  context.subscriptions.push(statusBar);

  viewProvider = new UsageViewProvider(context.extensionUri, version, () => void refresh(true));
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(UsageViewProvider.viewType, viewProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorUsage.show", async () => {
      await viewProvider?.reveal();
    }),
    vscode.commands.registerCommand("cursorUsage.refresh", () => void refresh(true)),
    vscode.commands.registerCommand("cursorUsage.checkForUpdates", () =>
      void checkForUpdates(context, true)
    )
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("cursorUsage")) {
        return;
      }
      applyEnabled(cfg().get<boolean>("enable", true));
      // Re-render with current data (detailLevel / showStatusBar may have changed).
      const cached = getCached();
      if (cached) {
        render(cached);
      }
      restartPolling();
    })
  );

  applyEnabled(cfg().get<boolean>("enable", true));

  // Background update check shortly after startup (throttled to once/day).
  setTimeout(() => void checkForUpdates(context, false), 8000);
}

/**
 * Check GitHub for a newer release. `manual` = true always reports the result
 * (even when up to date) and ignores the daily throttle / skipped version.
 */
async function checkForUpdates(context: vscode.ExtensionContext, manual: boolean): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("cursorUsage");
  if (!manual && !cfg.get<boolean>("checkForUpdates", true)) {
    return;
  }

  if (!manual) {
    const last = context.globalState.get<number>(LAST_CHECK_KEY, 0);
    if (Date.now() - last < UPDATE_CHECK_INTERVAL_MS) {
      return;
    }
  }
  await context.globalState.update(LAST_CHECK_KEY, Date.now());

  const current = (context.extension.packageJSON as { version?: string }).version ?? "0.0.0";
  const latest = await fetchLatestRelease();

  if (!latest) {
    if (manual) {
      void vscode.window.showInformationMessage("Cursor Usage: couldn't check for updates right now.");
    }
    return;
  }

  if (!isNewer(latest.version, current)) {
    if (manual) {
      void vscode.window.showInformationMessage(
        `Cursor Usage is up to date (v${current}).`
      );
    }
    return;
  }

  if (!manual && context.globalState.get<string>(SKIPPED_VERSION_KEY) === latest.version) {
    return;
  }

  const install = "Update Now";
  const notes = "Release Notes";
  const skip = "Skip This Version";
  const picked = await vscode.window.showInformationMessage(
    `Cursor Usage v${latest.version} is available (you have v${current}).`,
    install,
    notes,
    skip
  );

  if (picked === install) {
    await installUpdate(latest);
  } else if (picked === notes) {
    void vscode.env.openExternal(vscode.Uri.parse(latest.htmlUrl));
  } else if (picked === skip) {
    await context.globalState.update(SKIPPED_VERSION_KEY, latest.version);
  }
}

/** Download the release VSIX and hand it to VS Code's installer directly. */
async function installUpdate(latest: UpdateInfo): Promise<void> {
  const url = latest.vsixUrl;
  if (!url) {
    void vscode.env.openExternal(vscode.Uri.parse(latest.htmlUrl));
    return;
  }

  let vsixPath: string | undefined;
  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Cursor Usage v${latest.version}`,
      },
      async (progress) => {
        progress.report({ message: "Downloading…" });
        vsixPath = await downloadVsix(url, latest.version);
        progress.report({ message: "Installing…" });
        await vscode.commands.executeCommand(
          "workbench.extensions.installExtension",
          vscode.Uri.file(vsixPath)
        );
      }
    );
  } catch (err) {
    const openPage = "Open Release Page";
    const choice = await vscode.window.showErrorMessage(
      `Cursor Usage: couldn't install the update (${
        err instanceof Error ? err.message : String(err)
      }).`,
      openPage
    );
    if (choice === openPage) {
      void vscode.env.openExternal(vscode.Uri.parse(latest.htmlUrl));
    }
    return;
  } finally {
    if (vsixPath) {
      void fs.promises.rm(vsixPath, { force: true }).catch(() => undefined);
    }
  }

  const reload = "Reload Window";
  const choice = await vscode.window.showInformationMessage(
    `Cursor Usage v${latest.version} installed. Reload to start using it.`,
    reload
  );
  if (choice === reload) {
    await vscode.commands.executeCommand("workbench.action.reloadWindow");
  }
}

function applyEnabled(enabled: boolean): void {
  if (!enabled) {
    stopPolling();
    render({ state: "error", error: "Cursor Usage is disabled in settings." });
    statusBar?.update({ state: "error", error: "disabled" }, false);
    return;
  }
  restartPolling();
  void refresh(false);
}

function restartPolling(): void {
  stopPolling();
  const cfg = vscode.workspace.getConfiguration("cursorUsage");
  if (!cfg.get<boolean>("enable", true)) {
    return;
  }
  const sec = Math.max(60, cfg.get<number>("refreshIntervalSec", 300));
  pollTimer = setInterval(() => void refresh(false), sec * 1000);
}

function stopPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
  cancelRetry();
}

function cancelRetry(): void {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = undefined;
  }
}

/**
 * Queue a single follow-up attempt after a failure, so a transient network blip
 * recovers within a minute instead of waiting for the next poll.
 */
function scheduleRetry(): void {
  if (retryTimer || !vscode.workspace.getConfiguration("cursorUsage").get<boolean>("enable", true)) {
    return;
  }
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    void refresh(false);
  }, RETRY_AFTER_FAILURE_MS);
}

async function refresh(force: boolean): Promise<void> {
  if (refreshing) {
    return;
  }
  refreshing = true;
  try {
    // Keep showing the last good result while a refresh is in flight.
    const result = await fetchUsage(force);
    render(result);

    if (result.state === "error" || (result.state === "ok" && result.stale)) {
      scheduleRetry();
    } else {
      cancelRetry();
    }
  } finally {
    refreshing = false;
  }
}

function render(result: UsageResult): void {
  const cfg = vscode.workspace.getConfiguration("cursorUsage");
  const showStatusBar =
    cfg.get<boolean>("enable", true) && cfg.get<boolean>("showStatusBar", true);
  statusBar?.update(result, showStatusBar);
  viewProvider?.setResult(result);
}

export function deactivate(): void {
  stopPolling();
}
