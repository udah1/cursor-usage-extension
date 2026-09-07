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

  constructor(private readonly version: string) {
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
      this.requests.text =
        result.reason === "missingCli"
          ? "$(warning) Cursor Usage: sqlite3 missing"
          : "$(warning) Cursor Usage: reconnect";
      this.requests.tooltip = `${result.title}: ${result.message}\nClick to open.`;
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

    this.requests.tooltip = buildTooltip(result, this.version);
    this.spend.tooltip = this.requests.tooltip;

    if (result.meterMode === "spending") {
      const auto = result.autoPercentUsed ?? 0;
      const api = result.apiPercentUsed ?? 0;
      this.requests.name = "Cursor Usage — Models";
      this.requests.text = `$(watch) ${fmtPct(auto)} · ${fmtPct(api)}`;
      this.requests.color = severityColor(Math.max(auto, api));
      this.requests.show();
      if (result.onDemandEnabled) {
        const spendPct =
          result.onDemandLimit > 0 ? (result.onDemandUsed / result.onDemandLimit) * 100 : 0;
        this.spend.text = `${formatMoney(result.onDemandUsed)}/${formatMoney(result.onDemandLimit)}`;
        this.spend.color = severityColor(spendPct);
        this.spend.show();
      } else {
        this.spend.hide();
      }
      return;
    }

    const reqPct = result.limit > 0 ? (result.used / result.limit) * 100 : 0;
    const spendPct =
      result.onDemandLimit > 0 ? (result.onDemandUsed / result.onDemandLimit) * 100 : 0;

    this.requests.name = "Cursor Usage — Requests";
    this.requests.text = `$(watch) ${result.used}/${result.limit}`;
    this.requests.color = severityColor(reqPct);
    this.requests.show();

    if (result.onDemandEnabled) {
      this.spend.text = `${formatMoney(result.onDemandUsed)}/${formatMoney(result.onDemandLimit)}`;
      this.spend.color = severityColor(spendPct);
      this.spend.show();
    } else {
      this.spend.hide();
    }
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

function fmtPct(n: number): string {
  if (n > 0 && n < 1) {
    return `${n.toFixed(1)}%`;
  }
  return `${Math.round(n)}%`;
}

function planLabel(r: Extract<UsageResult, { state: "ok" }>): string {
  if (r.planName && r.planPrice) {
    return `${r.planName} · ${r.planPrice}`;
  }
  return r.planName || r.membershipType;
}

function buildTooltip(
  r: Extract<UsageResult, { state: "ok" }>,
  version: string
): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.appendMarkdown(`**Cursor Usage** — ${planLabel(r)}\n\n`);
  if (r.meterMode === "spending") {
    if (r.autoPercentUsed != null) {
      md.appendMarkdown(`Cursor Models: **${fmtPct(r.autoPercentUsed)}**\n\n`);
    }
    if (r.apiPercentUsed != null) {
      md.appendMarkdown(`Other Models: **${fmtPct(r.apiPercentUsed)}**\n\n`);
    }
    if (r.grokBot) {
      md.appendMarkdown(`Grok Bot: **${fmtPct(r.grokBot.percent)}**\n\n`);
    }
    md.appendMarkdown(
      r.onDemandEnabled
        ? `On-demand: **${formatMoney(r.onDemandUsed)} / ${formatMoney(r.onDemandLimit)}**\n\n`
        : `On-demand: **Disabled**\n\n`
    );
  } else {
    md.appendMarkdown(`Requests: **${r.used} / ${r.limit}** (${r.pct}%), ${r.remaining} left\n\n`);
    md.appendMarkdown(
      r.onDemandEnabled
        ? `On-demand: **${formatMoney(r.onDemandUsed)} / ${formatMoney(r.onDemandLimit)}**\n\n`
        : `On-demand: **Disabled**\n\n`
    );
  }
  if (r.daysLeft != null) {
    md.appendMarkdown(`Resets in ${r.daysLeft.toFixed(1)}d\n\n`);
  }
  if (r.stale) {
    md.appendMarkdown(`$(warning) Couldn't refresh — showing last known values\n\n`);
  }
  md.appendMarkdown(`_Click to open details · v${version}_`);
  return md;
}
