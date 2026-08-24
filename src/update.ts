import * as https from "node:https";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REPO = "udah1/cursor-usage-extension";
const TIMEOUT_MS = 8000;
const DOWNLOAD_TIMEOUT_MS = 60000;
const MAX_REDIRECTS = 5;
const UA = "cursor-usage-extension";

export interface UpdateInfo {
  version: string; // without leading "v"
  htmlUrl: string;
  vsixUrl?: string;
}

interface GitHubRelease {
  tag_name?: string;
  html_url?: string;
  draft?: boolean;
  prerelease?: boolean;
  assets?: Array<{ name?: string; browser_download_url?: string }>;
}

/** Fetch the latest (non-draft) release from GitHub. Never throws. */
export async function fetchLatestRelease(): Promise<UpdateInfo | undefined> {
  try {
    const rel = await getJson<GitHubRelease>(`/repos/${REPO}/releases/latest`);
    if (!rel?.tag_name || rel.draft) {
      return undefined;
    }
    const version = rel.tag_name.replace(/^v/, "");
    const vsix = rel.assets?.find((a) => a.name?.endsWith(".vsix"));
    return {
      version,
      htmlUrl: rel.html_url ?? `https://github.com/${REPO}/releases`,
      vsixUrl: vsix?.browser_download_url,
    };
  } catch {
    return undefined;
  }
}

/** Returns true when `latest` is a strictly higher semver than `current`. */
export function isNewer(latest: string, current: string): boolean {
  const a = parse(latest);
  const b = parse(current);
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) {
      return true;
    }
    if (a[i] < b[i]) {
      return false;
    }
  }
  return false;
}

function parse(v: string): [number, number, number] {
  const core = v.split(/[-+]/)[0];
  const parts = core.split(".").map((n) => parseInt(n, 10));
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

/**
 * Download a release `.vsix` into the temp dir so it can be handed straight to
 * VS Code's installer. Returns the local file path.
 */
export async function downloadVsix(url: string, version: string): Promise<string> {
  const dest = path.join(os.tmpdir(), `cursor-usage-${version}-${Date.now()}.vsix`);
  try {
    await downloadTo(url, dest, MAX_REDIRECTS);
  } catch (err) {
    await fs.promises.rm(dest, { force: true }).catch(() => undefined);
    throw err;
  }
  return dest;
}

/** GitHub asset URLs redirect to a CDN, so redirects must be followed. */
function downloadTo(url: string, dest: string, redirectsLeft: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { "User-Agent": UA, Accept: "application/octet-stream" } },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;

        if (status >= 300 && status < 400 && location) {
          res.resume();
          if (redirectsLeft <= 0) {
            reject(new Error("Too many redirects"));
            return;
          }
          const next = new URL(location, url).toString();
          downloadTo(next, dest, redirectsLeft - 1).then(resolve, reject);
          return;
        }

        if (status !== 200) {
          res.resume();
          reject(new Error(`HTTP ${status} while downloading the update`));
          return;
        }

        const file = fs.createWriteStream(dest);
        file.on("error", reject);
        file.on("finish", () => file.close((err) => (err ? reject(err) : resolve())));
        res.on("error", reject);
        res.pipe(file);
      }
    );
    req.on("error", reject);
    req.setTimeout(DOWNLOAD_TIMEOUT_MS, () => {
      req.destroy(new Error("Download timed out"));
    });
  });
}

function getJson<T>(pathname: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const req = https.request(
      {
        host: "api.github.com",
        path: pathname,
        method: "GET",
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": UA,
        },
        timeout: TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          const text = Buffer.concat(chunks).toString("utf8");
          if (status < 200 || status >= 300) {
            reject(new Error(`HTTP ${status}`));
            return;
          }
          try {
            resolve(JSON.parse(text) as T);
          } catch (e) {
            reject(e as Error);
          }
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}
