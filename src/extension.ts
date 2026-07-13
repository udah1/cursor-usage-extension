import * as vscode from "vscode";
import { fetchUsage, getCached, UsageResult } from "./usage";
import { StatusBar } from "./statusbar";
import { UsageViewProvider } from "./view";

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
    vscode.commands.registerCommand("cursorUsage.refresh", () => void refresh(true))
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
