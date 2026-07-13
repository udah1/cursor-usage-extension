import * as vscode from "vscode";
import { UsageResult } from "./usage";

/**
 * Renders the usage badge as a SINGLE status-bar item showing both requests and
 * spend. VS Code can't multi-color one item, so the whole badge takes the color
 * of whichever segment is most severe (requests or spend).
 */
export class StatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = "cursorUsage.show";
  }

  update(result: UsageResult, show: boolean): void {
    if (!show) {
      this.item.hide();
      return;
    }

    if (result.state === "needsAuth") {
      this.item.text = "$(warning) Cursor Usage: reconnect";
      this.item.tooltip = "Couldn't read a valid Cursor session token. Click to open.";
      this.item.color = warnColor();
      this.item.show();
      return;
    }

    if (result.state === "error") {
      this.item.text = "$(watch) Cursor Usage: —";
      this.item.tooltip = `Couldn't refresh usage: ${result.error}\nClick to open.`;
      this.item.color = undefined;
      this.item.show();
      return;
    }

    const reqPct = result.limit > 0 ? (result.used / result.limit) * 100 : 0;
    const spendPct =
      result.onDemandLimit > 0 ? (result.onDemandUsed / result.onDemandLimit) * 100 : 0;
    const worst = Math.max(reqPct, spendPct);

    const usedStr = formatMoney(result.onDemandUsed);
    const limitStr = formatMoney(result.onDemandLimit);
    this.item.text = `$(watch) ${result.used}/${result.limit} · ${usedStr}/${limitStr}`;
    this.item.color = severityColor(worst);
    this.item.tooltip = buildTooltip(result);
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}

function severityColor(pct: number): vscode.ThemeColor | undefined {
  if (pct >= 100) {
    // `editorError.foreground` is a real text color (readable in light & dark);
    // `statusBarItem.errorForeground` defaults to white and is meant for a red pill.
    return new vscode.ThemeColor("editorError.foreground");
  }
  if (pct >= 80) {
    return warnColor();
  }
  return undefined;
}

function warnColor(): vscode.ThemeColor {
  return new vscode.ThemeColor("editorWarning.foreground");
}

function formatMoney(dollars: number): string {
  const rounded = Math.round(dollars * 100) / 100;
  if (Number.isInteger(rounded)) {
    return `$${rounded}`;
  }
  return `$${rounded.toFixed(2)}`;
}

function buildTooltip(r: Extract<UsageResult, { state: "ok" }>): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.appendMarkdown(`**Cursor Usage** — ${r.membershipType}\n\n`);
  md.appendMarkdown(`Requests: **${r.used} / ${r.limit}** (${r.pct}%), ${r.remaining} left\n\n`);
  md.appendMarkdown(
    `On-demand: **${formatMoney(r.onDemandUsed)} / ${formatMoney(r.onDemandLimit)}**\n\n`
  );
  if (r.daysLeft != null) {
    md.appendMarkdown(`Resets in ${r.daysLeft.toFixed(1)}d\n\n`);
  }
  md.appendMarkdown(`_Click to open details_`);
  return md;
}
