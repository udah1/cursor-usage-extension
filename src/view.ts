import * as vscode from "vscode";
import { UsageResult } from "./usage";

type DetailLevel = "auto" | "compact" | "full";

/** WebviewView provider for the sidebar detail panel. */
export class UsageViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "cursorUsage.detail";

  private view?: vscode.WebviewView;
  private last?: UsageResult;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onRefresh: () => void
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    webviewView.webview.html = this.html(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((msg: { type?: string }) => {
      if (msg?.type === "refresh" || msg?.type === "reconnect") {
        this.onRefresh();
      } else if (msg?.type === "ready") {
        this.post();
      }
    });

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.post();
      }
    });

    this.post();
  }

  /** Reveal the view if hidden. */
  async reveal(): Promise<void> {
    if (this.view) {
      this.view.show?.(true);
    } else {
      await vscode.commands.executeCommand("cursorUsage.detail.focus");
    }
  }

  setResult(result: UsageResult): void {
    this.last = result;
    this.post();
  }

  private detailLevel(): DetailLevel {
    return vscode.workspace
      .getConfiguration("cursorUsage")
      .get<DetailLevel>("detailLevel", "auto");
  }

  private post(): void {
    if (!this.view) {
      return;
    }
    this.view.webview.postMessage({
      type: "update",
      detailLevel: this.detailLevel(),
      data: this.last ?? null,
    });
  }

  private html(webview: vscode.Webview): string {
    const nonce = getNonce();
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join("; ");

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
  :root {
    /* Text colors: use editor foreground tokens (real, readable text colors in
       both light & dark). charts-* are used only for the solid progress fills. */
    --ok: var(--vscode-charts-green, #2ea043);
    --warn: var(--vscode-editorWarning-foreground, #bf8803);
    --danger: var(--vscode-editorError-foreground, #e51400);
    --ok-fill: var(--vscode-charts-green, #2ea043);
    --warn-fill: var(--vscode-charts-yellow, #d9a441);
    --danger-fill: var(--vscode-charts-red, #e51400);
    --muted: var(--vscode-descriptionForeground, #8c8c8c);
    --border: var(--vscode-widget-border, var(--vscode-panel-border, rgba(128,128,128,.3)));
    --card-bg: var(--vscode-editorWidget-background, rgba(128,128,128,.08));
    /* Neutral, theme-agnostic track so any fill color stays visible. */
    --track: rgba(128,128,128,.25);
    --mono: var(--vscode-editor-font-family, monospace);
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0; padding: 8px;
    color: var(--vscode-foreground);
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size, 13px);
  }
  .card {
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 10px;
    margin-bottom: 8px;
  }
  .card:last-child { margin-bottom: 0; }
  .row { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
  .label {
    font-size: 10px; color: var(--muted); text-transform: uppercase;
    letter-spacing: .5px; font-weight: 600;
  }
  .big { font-family: var(--mono); font-size: 20px; font-weight: 600; }
  .big .unit { font-size: 12px; color: var(--muted); font-weight: 400; }
  .big.warn { color: var(--warn); }
  .big.danger { color: var(--danger); }
  .chip {
    font-family: var(--mono); font-size: 11px; padding: 1px 6px;
    border-radius: 10px; font-weight: 600;
    background: transparent; color: var(--muted);
    border: 1px solid var(--border);
  }
  .chip.ok { color: var(--ok); border-color: var(--ok); }
  .chip.warn { color: var(--warn); border-color: var(--warn); }
  .chip.danger { color: var(--danger); border-color: var(--danger); }
  .meta { font-family: var(--mono); font-size: 11px; color: var(--muted); }
  .meta b { color: var(--vscode-foreground); }
  .track { height: 7px; border-radius: 5px; background: var(--track); overflow: hidden; margin: 8px 0 6px; }
  .fill { height: 100%; border-radius: 5px; background: var(--ok-fill); transition: width .3s ease; min-width: 2px; }
  .fill.ok { background: var(--ok-fill); }
  .fill.warn { background: var(--warn-fill); }
  .fill.danger { background: var(--danger-fill); }
  .sub { display: flex; justify-content: space-between; font-family: var(--mono); font-size: 10px; color: var(--muted); }
  .kv { display: flex; justify-content: space-between; font-size: 11px; padding: 3px 0; }
  .kv .v { font-family: var(--mono); }
  .kv .k { color: var(--muted); }
  .reset { display: flex; align-items: center; gap: 5px; font-family: var(--mono); font-size: 10px; color: var(--muted); margin-top: 2px; }
  .burn { font-family: var(--mono); font-size: 10px; margin-top: 8px; padding-top: 8px; border-top: 1px dashed var(--border); color: var(--muted); }
  .burn.warn { color: var(--warn); }
  table { width: 100%; border-collapse: collapse; font-family: var(--mono); font-size: 10px; }
  th { text-align: right; color: var(--muted); font-weight: 600; padding: 4px 3px; border-bottom: 1px solid var(--border); text-transform: uppercase; }
  th:first-child, td:first-child { text-align: left; }
  td { text-align: right; padding: 4px 3px; border-bottom: 1px solid var(--border); color: var(--muted); }
  td:first-child { color: var(--vscode-foreground); }
  tr:last-child td { border-bottom: none; }
  td.cost { color: var(--ok); }
  .foot { display: flex; align-items: center; justify-content: space-between; margin-top: 8px; }
  .stamp { font-family: var(--mono); font-size: 10px; color: var(--muted); }
  button {
    display: inline-flex; align-items: center; gap: 5px; cursor: pointer;
    font-family: var(--vscode-font-family); font-size: 12px;
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    background: var(--vscode-button-secondaryBackground, transparent);
    border: 1px solid var(--border); border-radius: 4px; padding: 3px 10px;
  }
  button:hover { background: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,.15)); }
  button.primary {
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
    border-color: var(--vscode-button-background);
  }
  button.primary:hover { background: var(--vscode-button-hoverBackground); }
  .center { text-align: center; padding: 10px 6px; }
  .center h3 { margin: 6px 0 4px; font-size: 13px; }
  .center p { margin: 0 0 12px; font-size: 12px; color: var(--muted); line-height: 1.5; }
  .center .ic { font-size: 22px; }
  .center .ic.warn { color: var(--warn); }
  .center .ic.err { color: var(--danger); }
  .loading { color: var(--muted); font-size: 12px; text-align: center; padding: 16px; }
  .clickable { cursor: pointer; }
  .clickable:hover { border-color: var(--vscode-focusBorder, var(--muted)); }
  .hint { display: flex; align-items: center; justify-content: center; gap: 4px;
    margin-top: 4px; font-size: 10px; color: var(--muted); }
  .linkbar { display: flex; justify-content: center; margin-top: 6px; }
  .link { background: none; border: none; padding: 2px 6px; cursor: pointer;
    font-family: var(--vscode-font-family); font-size: 11px;
    color: var(--vscode-textLink-foreground); }
  .link:hover { color: var(--vscode-textLink-activeForeground); text-decoration: underline; }
</style>
</head>
<body>
  <div id="app"><div class="loading">Loading usage…</div></div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let state = { data: null, detailLevel: "auto" };
    let expanded = false; // user tapped a compact card to see everything

    window.addEventListener("message", (e) => {
      const m = e.data;
      if (m && m.type === "update") {
        state = { data: m.data, detailLevel: m.detailLevel };
        render();
      }
    });
    window.addEventListener("resize", render);

    function esc(s) {
      return String(s).replace(/[&<>"]/g, (c) => (
        { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]
      ));
    }
    function sev(pct) { return pct >= 100 ? "danger" : pct >= 80 ? "warn" : "ok"; }
    function money(n) {
      const r = Math.round(n * 100) / 100;
      return "$" + (Number.isInteger(r) ? r : r.toFixed(2));
    }
    function fmtDate(iso) {
      if (!iso) return "—";
      try {
        return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
      } catch { return iso; }
    }
    function fmtTokens(n) {
      if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
      if (n >= 1e3) return Math.round(n / 1e3) + "K";
      return String(n);
    }
    function ago(ts) {
      const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
      if (s < 60) return s + "s ago";
      const m = Math.round(s / 60);
      if (m < 60) return m + "m ago";
      return Math.round(m / 60) + "h ago";
    }

    function render() {
      const app = document.getElementById("app");
      const d = state.data;
      if (!d) { app.innerHTML = '<div class="loading">Loading usage…</div>'; return; }

      if (d.state === "needsAuth") {
        app.innerHTML = card(
          '<div class="center">' +
          '<div class="ic warn">&#9888;</div>' +
          '<h3>Not connected</h3>' +
          "<p>Couldn't read a valid Cursor session token. Make sure you're signed in to Cursor on this machine.</p>" +
          '<button class="primary" id="reconnect">Reconnect</button>' +
          '</div>'
        );
        document.getElementById("reconnect").onclick = () => vscode.postMessage({ type: "reconnect" });
        return;
      }
      if (d.state === "error") {
        app.innerHTML = card(
          '<div class="center">' +
          '<div class="ic err">&#9888;</div>' +
          '<h3>Couldn\\'t refresh</h3>' +
          "<p>" + esc(d.error) + "</p>" +
          '<button class="primary" id="retry">Retry</button>' +
          '</div>'
        );
        document.getElementById("retry").onclick = () => vscode.postMessage({ type: "refresh" });
        return;
      }

      // ok
      const autoCompact = state.detailLevel === "auto" && window.innerHeight < 340;
      const mode = pickMode();

      if (mode === "compact") {
        app.innerHTML = renderCompact(d);
        // Any card expands to the full view when height is limited.
        app.querySelectorAll("[data-expand]").forEach((el) => {
          el.onclick = () => { expanded = true; render(); };
        });
      } else {
        const collapsible = expanded && autoCompact;
        app.innerHTML = renderFull(d) + (collapsible
          ? '<div class="linkbar"><button class="link" id="collapse">Show less</button></div>'
          : "");
        const rf = document.getElementById("refresh");
        if (rf) rf.onclick = () => vscode.postMessage({ type: "refresh" });
        const cl = document.getElementById("collapse");
        if (cl) cl.onclick = () => { expanded = false; render(); };
      }
    }

    function pickMode() {
      if (state.detailLevel === "compact") return "compact";
      if (state.detailLevel === "full") return "full";
      if (expanded) return "full";
      return window.innerHeight >= 340 ? "full" : "compact";
    }

    function card(inner) { return '<div class="card">' + inner + "</div>"; }

    function requestsCard(d) {
      const s = sev(d.pct);
      const bigCls = s === "ok" ? "" : s;
      return card(
        '<div class="row"><span class="label">Included requests</span>' +
        '<span class="chip ' + s + '">' + d.pct + '%</span></div>' +
        '<div class="row" style="margin-top:6px"><span class="big ' + bigCls + '">' +
        d.used + '<span class="unit"> / ' + d.limit + '</span></span>' +
        '<span class="meta"><b>' + d.remaining + '</b> left</span></div>' +
        '<div class="track"><div class="fill ' + s + '" style="width:' + Math.min(100, d.pct) + '%"></div></div>' +
        (d.billingCycleEnd ? '<div class="reset">Resets ' + esc(fmtDate(d.billingCycleEnd)) +
          (d.daysLeft != null ? ' · ' + d.daysLeft.toFixed(1) + 'd left' : '') + '</div>' : '') +
        burn(d)
      );
    }

    function burn(d) {
      if (d.requestsPerDay == null || d.projectedRequests == null) return "";
      const cls = d.projectedToExceed ? " warn" : "";
      return '<div class="burn' + cls + '">' + d.requestsPerDay.toFixed(1) + '/day &#8594; ~' +
        d.projectedRequests + ' by reset' + (d.projectedToExceed ? ' (over limit)' : '') + '</div>';
    }

    function spendCard(d) {
      const pct = d.onDemandLimit > 0 ? (d.onDemandUsed / d.onDemandLimit) * 100 : 0;
      const s = sev(pct);
      const rem = money(d.onDemandRemaining);
      return card(
        '<div class="row"><span class="label">On-demand spend</span>' +
        '<span class="chip ' + s + '">' + Math.round(pct) + '%</span></div>' +
        '<div class="row" style="margin-top:6px"><span class="big ' + (s === "ok" ? "" : s) + '">' +
        money(d.onDemandUsed) + '<span class="unit"> / ' + money(d.onDemandLimit) + '</span></span>' +
        '<span class="meta"><b>' + rem + '</b> left</span></div>' +
        '<div class="track"><div class="fill ' + s + '" style="width:' + Math.min(100, pct) + '%"></div></div>' +
        '<div class="kv"><span class="k">Plan</span><span class="v">' + esc(d.membershipType) + '</span></div>'
      );
    }

    function modelsCard(d) {
      if (!d.models || !d.models.length) return "";
      const rows = d.models.map((m) =>
        '<tr><td>' + esc(m.model) + '</td><td class="cost">' + money(m.costDollars) +
        '</td><td>' + m.requests + '</td><td>' + fmtTokens(m.inputTokens + m.outputTokens) + '</td></tr>'
      ).join("");
      return card(
        '<div class="label" style="margin-bottom:6px">Usage by model</div>' +
        '<table><thead><tr><th>Model</th><th>$</th><th>Req</th><th>Tokens</th></tr></thead>' +
        '<tbody>' + rows + '</tbody></table>'
      );
    }

    function foot(d) {
      return '<div class="foot"><span class="stamp">updated ' + ago(d.fetchedAt) + '</span>' +
        '<button id="refresh">Refresh</button></div>';
    }

    function renderFull(d) {
      return requestsCard(d) + spendCard(d) + modelsCard(d) + foot(d);
    }

    function clickableCard(inner) {
      return '<div class="card clickable" data-expand="1" title="Click for full details">' + inner + "</div>";
    }

    function renderCompact(d) {
      const s = sev(d.pct);
      const pctSpend = d.onDemandLimit > 0 ? (d.onDemandUsed / d.onDemandLimit) * 100 : 0;
      return clickableCard(
        '<div class="row"><span class="big ' + (s === "ok" ? "" : s) + '">' + d.used +
        '<span class="unit">/' + d.limit + '</span></span><span class="chip ' + s + '">' + d.pct + '%</span></div>' +
        '<div class="track"><div class="fill ' + s + '" style="width:' + Math.min(100, d.pct) + '%"></div></div>' +
        '<div class="sub"><span><b>' + d.remaining + '</b> left</span><span>' +
        (d.daysLeft != null ? d.daysLeft.toFixed(1) + 'd left' : '') + '</span></div>'
      ) + clickableCard(
        '<div class="row"><span class="v" style="font-family:var(--mono)">' + money(d.onDemandUsed) +
        ' / ' + money(d.onDemandLimit) + '</span><span class="chip ' + sev(pctSpend) + '">' +
        Math.round(pctSpend) + '%</span></div>'
      ) + '<div class="hint">&#9660; Click a card for full details</div>';
    }

    vscode.postMessage({ type: "ready" });
  </script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
