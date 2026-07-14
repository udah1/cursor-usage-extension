import * as vscode from "vscode";
import { UsageResult } from "./usage";

/**
 * Renders the usage badge as TWO status-bar items so requests and spend can be
 * colored independently (VS Code can't multi-color one item).
 *
 * They're kept adjacent by using fractional priorities with a tiny gap
 * (REQ_PRIORITY / SPEND_PRIORITY): nothing else occupies that slot, so no other
 * extension's item can slip between them. Higher priority renders further left.
 */
const REQ_PRIORITY = 100.02;
const SPEND_PRIORITY = 100.01;

export class StatusBar implements vscode.Disposable {
  private readonly requests: vscode.StatusBarItem;
  private readonly spend: vscode.StatusBarItem;

  constructor() {
    this.requests = vscode.window.createStatusBarItem(
      "cursorUsage.requests",
      vscode.StatusBarAlignment.Right,
      REQ_PRIORITY
    );
    this.spend = vscode.window.createStatusBarItem(
      "cursorUsage.spend",
      vscode.StatusBarAlignment.Right,
      SPEND_PRIORITY
    );
    this.requests.name = "Cursor Usage — Requests";
    this.spend.name = "Cursor Usage — Spend";
    this.requests.command = "cursorUsage.show";
    this.spend.command = "cursorUsage.show";
  }

  update(result: UsageResult, show: boolean): void {
    if (!show) {
      this.requests.hide();
      this.spend.hide();
      return;
    }

    if (result.state === "needsAuth") {
      this.requests.text = "$(warning) Cursor Usage: reconnect";
      this.requests.tooltip = "Couldn't read a valid Cursor session token. Click to open.";
      this.requests.color = warnColor();
      this.spend.hide();
      this.requests.show();
      return;
    }

    if (result.state === "error") {
      this.requests.text = "$(watch) Cursor Usage: —";
      this.requests.tooltip = `Couldn't refresh usage: ${result.error}\nClick to open.`;
      this.requests.color = undefined;
      this.spend.hide();
      this.requests.show();
      return;
    }

    const reqPct = result.limit > 0 ? (result.used / result.limit) * 100 : 0;
    const spendPct =
      result.onDemandLimit > 0 ? (result.onDemandUsed / result.onDemandLimit) * 100 : 0;

    this.requests.text = `$(watch) ${result.used}/${result.limit}`;
    this.requests.color = severityColor(reqPct);
    this.requests.tooltip = buildTooltip(result);

    const usedStr = formatMoney(result.onDemandUsed);
    const limitStr = formatMoney(result.onDemandLimit);
    this.spend.text = `${usedStr}/${limitStr}`;
    this.spend.color = severityColor(spendPct);
    this.spend.tooltip = this.requests.tooltip;

    this.requests.show();
    this.spend.show();
  }

  dispose(): void {
    this.requests.dispose();
    this.spend.dispose();
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
