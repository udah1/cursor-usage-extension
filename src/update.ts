import * as https from "node:https";

const REPO = "udah1/cursor-usage-extension";
const TIMEOUT_MS = 8000;
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
