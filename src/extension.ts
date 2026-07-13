import * as vscode from "vscode";
import { fetchUsage, getCached, UsageResult } from "./usage";
import { StatusBar } from "./statusbar";
import { UsageViewProvider } from "./view";
import { fetchLatestRelease, isNewer } from "./update";

const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const LAST_CHECK_KEY = "cursorUsage.lastUpdateCheck";
const SKIPPED_VERSION_KEY = "cursorUsage.skippedVersion";

let statusBar: StatusBar | undefined;
let viewProvider: UsageViewProvider | undefined;
let pollTimer: ReturnType<typeof setInterval> | undefined;
let refreshing = false;

export function activate(context: vscode.ExtensionContext): void {
  const cfg = () => vscode.workspace.getConfiguration("cursorUsage");

  statusBar = new StatusBar();
  context.subscriptions.push(statusBar);

  viewProvider = new UsageViewProvider(context.extensionUri, () => void refresh(true));
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

  const download = "Download";
  const notes = "Release Notes";
  const skip = "Skip This Version";
  const picked = await vscode.window.showInformationMessage(
    `Cursor Usage v${latest.version} is available (you have v${current}).`,
    download,
    notes,
    skip
  );

  if (picked === download && latest.vsixUrl) {
    void vscode.env.openExternal(vscode.Uri.parse(latest.vsixUrl));
  } else if (picked === download || picked === notes) {
    void vscode.env.openExternal(vscode.Uri.parse(latest.htmlUrl));
  } else if (picked === skip) {
    await context.globalState.update(SKIPPED_VERSION_KEY, latest.version);
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
