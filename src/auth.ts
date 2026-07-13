import { execFile } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

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

const AUTH_KEYS = [
  "cursorAuth/accessToken",
  "cursorAuth/cachedTeam",
  "cursorAuth/stripeMembershipType",
  "cursorAuth/cachedEmail",
] as const;

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

/**
 * Read the auth keys from the ItemTable using the `sqlite3` CLI in READ-ONLY,
 * JSON mode. Never reads the whole file — just the four keys we need.
 */
function readItemTable(dbPath: string): Promise<Map<string, string>> {
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
        const map = new Map<string, string>();
        const trimmed = stdout.trim();
        if (!trimmed) {
          resolve(map);
          return;
        }
        try {
          const rows = JSON.parse(trimmed) as ItemRow[];
          for (const row of rows) {
            if (row && typeof row.key === "string") {
              map.set(row.key, row.value);
            }
          }
          resolve(map);
        } catch (e) {
          reject(e);
        }
      }
    );
  });
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

/**
 * Build the in-memory auth context. Returns `undefined` when a valid token
 * cannot be assembled (caller should treat this as `needsAuth`).
 */
export async function readAuthContext(): Promise<AuthContext | undefined> {
  const dbPath = findStateDbPath();
  if (!dbPath) {
    return undefined;
  }

  let items: Map<string, string>;
  try {
    items = await readItemTable(dbPath);
  } catch {
    return undefined;
  }

  const jwt = coerceString(items.get("cursorAuth/accessToken"));
  if (!jwt) {
    return undefined;
  }

  const sub = subFromJwt(jwt);
  if (!sub) {
    return undefined;
  }

  const teamId = teamIdFromCachedTeam(items.get("cursorAuth/cachedTeam"));
  const email = coerceString(items.get("cursorAuth/cachedEmail"));

  const cookieValue = encodeURIComponent(`${sub}::${jwt}`);
  const cookie = `WorkosCursorSessionToken=${cookieValue}`;

  return { cookie, sub, jwt, teamId, email };
}
