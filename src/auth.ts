import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { log, sanitizeError } from "./log";

/**
 * Reads Cursor's own locally-stored session token (READ-ONLY) and builds the
 * `WorkosCursorSessionToken` cookie used by the cursor.com dashboard.
 *
 * We never open the SQLite DB read-write, never VACUUM, and never persist or
 * log the cookie/JWT. Everything stays in memory.
 */

export interface AuthContext {
  /** Full cookie header value: `WorkosCursorSessionToken=<uri-encoded sub::jwt>` */
  cookie: string;
  /** The user sub claim (with any leading `auth0|` stripped). */
  sub: string;
  /** The raw access-token JWT. */
  jwt: string;
  /** Numeric team id, if this is a team account. */
  teamId?: number;
  /** Cached email, if present. */
  email?: string;
}

export type AuthFailureReason =
  | "noDb"
  | "missingCli"
  | "dbUnreadable"
  | "noToken"
  | "invalidJwt"
  | "sessionExpired";

export interface AuthFailure {
  reason: AuthFailureReason;
  title: string;
  message: string;
}

export type AuthReadResult = { ok: true; context: AuthContext } | ({ ok: false } & AuthFailure);

const AUTH_KEYS = [
  "cursorAuth/accessToken",
  "cursorAuth/cachedTeam",
  "cursorAuth/stripeMembershipType",
  "cursorAuth/cachedEmail",
] as const;

type DatabaseSyncInstance = {
  prepare(sql: string): { all(...params: string[]): unknown };
  close(): void;
};

type DatabaseSyncCtor = new (
  dbPath: string,
  options?: { readOnly?: boolean }
) => DatabaseSyncInstance;

/** Locate Cursor's global state DB per-platform. Returns the first that exists. */
export function findStateDbPath(): string | undefined {
  const home = os.homedir();
  const candidates: string[] = [];

  switch (process.platform) {
    case "darwin":
      candidates.push(
        path.join(home, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb")
      );
      break;
    case "win32": {
      const appData = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
      candidates.push(path.join(appData, "Cursor", "User", "globalStorage", "state.vscdb"));
      break;
    }
    default:
      candidates.push(path.join(home, ".config", "Cursor", "User", "globalStorage", "state.vscdb"));
      break;
  }

  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) {
        return c;
      }
    } catch {
      // ignore
    }
  }
  return undefined;
}

interface ItemRow {
  key: string;
  value: string;
}

function isErrno(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === code
  );
}

function isMissingBinary(err: unknown): boolean {
  if (isErrno(err, "ENOENT")) {
    return true;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return /\bENOENT\b/.test(msg) && /sqlite3/i.test(msg);
}

function isModuleMissing(err: unknown): boolean {
  if (isErrno(err, "ERR_UNKNOWN_BUILTIN_MODULE") || isErrno(err, "MODULE_NOT_FOUND")) {
    return true;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return /cannot find module|unknown builtin|not support/i.test(msg);
}

function rowsToMap(rows: unknown): Map<string, string> {
  const map = new Map<string, string>();
  if (!Array.isArray(rows)) {
    return map;
  }
  for (const row of rows) {
    if (!row || typeof row !== "object") {
      continue;
    }
    const rec = row as Record<string, unknown>;
    if (typeof rec.key === "string") {
      map.set(rec.key, rec.value == null ? "" : String(rec.value));
    }
  }
  return map;
}

function loadDatabaseSync(): DatabaseSyncCtor | undefined {
  try {
    const nodeRequire = createRequire(__filename);
    const mod = nodeRequire("node:sqlite") as { DatabaseSync?: DatabaseSyncCtor };
    if (typeof mod.DatabaseSync === "function") {
      return mod.DatabaseSync;
    }
  } catch (err) {
    log(`node:sqlite not loadable: ${sanitizeError(err)}`);
  }
  return undefined;
}

/**
 * Built-in SQLite (Node ≥ 22.5 / Cursor's Electron). Read-only, no PATH dependency.
 */
function readItemTableNodeSqlite(dbPath: string): Map<string, string> {
  const DatabaseSync = loadDatabaseSync();
  if (!DatabaseSync) {
    throw Object.assign(new Error("node:sqlite is not available in this runtime"), {
      code: "ERR_UNKNOWN_BUILTIN_MODULE",
    });
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const placeholders = AUTH_KEYS.map(() => "?").join(",");
    const stmt = db.prepare(
      `SELECT key, value FROM ItemTable WHERE key IN (${placeholders})`
    );
    return rowsToMap(stmt.all(...AUTH_KEYS));
  } finally {
    db.close();
  }
}

/**
 * Fallback: `sqlite3` CLI in READ-ONLY JSON mode. Never reads the whole file —
 * just the four keys we need.
 */
function readItemTableCli(dbPath: string): Promise<Map<string, string>> {
  const keyList = AUTH_KEYS.map((k) => `'${k}'`).join(",");
  const sql = `SELECT key,value FROM ItemTable WHERE key IN (${keyList});`;
  return new Promise((resolve, reject) => {
    execFile(
      "sqlite3",
      ["-readonly", "-json", dbPath, sql],
      { timeout: 5000, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        const trimmed = stdout.trim();
        if (!trimmed) {
          resolve(new Map());
          return;
        }
        try {
          resolve(rowsToMap(JSON.parse(trimmed) as ItemRow[]));
        } catch (e) {
          reject(e);
        }
      }
    );
  });
}

function missingCliMessage(): string {
  const install =
    process.platform === "win32"
      ? "On Windows: winget install SQLite.SQLite (or choco install sqlite), then reload the window."
      : process.platform === "linux"
        ? "On Linux: apt install sqlite3 (or your distro equivalent), then reload the window."
        : "Install the sqlite3 CLI and add it to PATH, then reload the window.";
  return (
    "Couldn't read Cursor's session database: sqlite3 is not on PATH, and the built-in SQLite reader isn't available. " +
    install
  );
}

function wrapDbError(nodeError: unknown, cliErr: unknown): AuthFailure {
  const nodeMissing = isModuleMissing(nodeError);
  const cliMissing = isMissingBinary(cliErr);

  if (nodeMissing && cliMissing) {
    return {
      reason: "missingCli",
      title: "SQLite CLI not found",
      message: missingCliMessage(),
    };
  }

  const primary = !nodeMissing && nodeError ? nodeError : cliErr;
  return {
    reason: "dbUnreadable",
    title: "Couldn't read session",
    message:
      "Found Cursor's session database but couldn't read it. " +
      `Details: ${sanitizeError(primary)}. See the Cursor Usage output channel.`,
  };
}

async function readItemTable(
  dbPath: string
): Promise<{ ok: true; items: Map<string, string> } | { ok: false; failure: AuthFailure }> {
  let nodeError: unknown;
  try {
    const items = readItemTableNodeSqlite(dbPath);
    log(`read ${items.size} auth key(s) via node:sqlite`);
    return { ok: true, items };
  } catch (err) {
    nodeError = err;
    log(`node:sqlite failed: ${sanitizeError(err)}`);
  }

  try {
    const items = await readItemTableCli(dbPath);
    log(`read ${items.size} auth key(s) via sqlite3 CLI`);
    return { ok: true, items };
  } catch (cliErr) {
    log(`sqlite3 CLI failed: ${sanitizeError(cliErr)}`);
    return { ok: false, failure: wrapDbError(nodeError, cliErr) };
  }
}

/** Base64url-decode the JWT payload and return the (auth0-stripped) `sub`. */
function subFromJwt(jwt: string): string | undefined {
  const parts = jwt.split(".");
  if (parts.length < 2) {
    return undefined;
  }
  try {
    const payloadJson = Buffer.from(parts[1], "base64url").toString("utf8");
    const payload = JSON.parse(payloadJson) as { sub?: unknown };
    if (typeof payload.sub !== "string" || !payload.sub) {
      return undefined;
    }
    return payload.sub.replace(/^auth0\|/, "");
  } catch {
    return undefined;
  }
}

/** JSON values in ItemTable may be stored double-encoded; unwrap defensively. */
function coerceString(raw: string | undefined): string | undefined {
  if (raw == null) {
    return undefined;
  }
  let v = raw;
  // Some values are JSON strings like "\"eyJ...\"".
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try {
      v = JSON.parse(v) as string;
    } catch {
      // leave as-is
    }
  }
  return v;
}

function teamIdFromCachedTeam(raw: string | undefined): number | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    const obj = JSON.parse(raw) as { teamId?: unknown };
    if (typeof obj.teamId === "number" && Number.isFinite(obj.teamId)) {
      return obj.teamId;
    }
  } catch {
    // ignore
  }
  return undefined;
}

export function sessionExpiredFailure(): AuthFailure {
  return {
    reason: "sessionExpired",
    title: "Session expired",
    message:
      "Cursor rejected the session token (401/403). Sign out and back in to Cursor on this machine, then click Reconnect.",
  };
}

/**
 * Build the in-memory auth context, or a structured failure the UI can show
 * without pretending the user is signed out.
 */
export async function readAuthContext(): Promise<AuthReadResult> {
  const dbPath = findStateDbPath();
  if (!dbPath) {
    log("state.vscdb not found in the usual Cursor locations");
    return {
      ok: false,
      reason: "noDb",
      title: "Session database missing",
      message:
        "Couldn't find Cursor's local session file (state.vscdb). Make sure Cursor is installed and you've signed in on this machine.",
    };
  }

  log(`using ${dbPath}`);

  const table = await readItemTable(dbPath);
  if (!table.ok) {
    return { ok: false, ...table.failure };
  }
  const items = table.items;

  const jwt = coerceString(items.get("cursorAuth/accessToken"));
  if (!jwt) {
    log("cursorAuth/accessToken missing from ItemTable");
    return {
      ok: false,
      reason: "noToken",
      title: "Not connected",
      message:
        "Couldn't find a Cursor session token. Make sure you're signed in to Cursor on this machine.",
    };
  }

  const sub = subFromJwt(jwt);
  if (!sub) {
    log("cursorAuth/accessToken present but JWT sub is missing or invalid");
    return {
      ok: false,
      reason: "invalidJwt",
      title: "Not connected",
      message:
        "Cursor's session token is present but invalid. Sign out and back in to Cursor, then click Reconnect.",
    };
  }

  const teamId = teamIdFromCachedTeam(items.get("cursorAuth/cachedTeam"));
  const email = coerceString(items.get("cursorAuth/cachedEmail"));

  const cookieValue = encodeURIComponent(`${sub}::${jwt}`);
  const cookie = `WorkosCursorSessionToken=${cookieValue}`;

  log("assembled session cookie from local keys (token not logged)");
  return { ok: true, context: { cookie, sub, jwt, teamId, email } };
}
