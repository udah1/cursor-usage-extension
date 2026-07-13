import * as https from "node:https";

const HOST = "cursor.com";
const TIMEOUT_MS = 8000;
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/** Thrown for non-2xx responses so callers can branch on status (401/403 = auth). */
export class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

export function isAuthError(err: unknown): boolean {
  return err instanceof HttpError && (err.status === 401 || err.status === 403);
}

function baseHeaders(cookie: string): Record<string, string> {
  return {
    Cookie: cookie,
    Accept: "application/json",
    Referer: "https://cursor.com/dashboard",
    Origin: "https://cursor.com",
    "User-Agent": UA,
  };
}

function request<T>(
  method: "GET" | "POST",
  pathname: string,
  cookie: string,
  body?: unknown
): Promise<T> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const headers = baseHeaders(cookie);
  if (payload !== undefined) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = Buffer.byteLength(payload).toString();
  }

  return new Promise<T>((resolve, reject) => {
    const req = https.request(
      {
        host: HOST,
        path: pathname,
        method,
        headers,
        timeout: TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          const text = Buffer.concat(chunks).toString("utf8");
          if (status < 200 || status >= 300) {
            reject(new HttpError(status, `HTTP ${status} for ${pathname}`));
            return;
          }
          if (!text) {
            resolve(undefined as unknown as T);
            return;
          }
          try {
            resolve(JSON.parse(text) as T);
          } catch (e) {
            reject(new Error(`Bad JSON from ${pathname}: ${(e as Error).message}`));
          }
        });
      }
    );

    req.on("timeout", () => {
      req.destroy(new Error(`Timeout after ${TIMEOUT_MS}ms for ${pathname}`));
    });
    req.on("error", reject);

    if (payload !== undefined) {
      req.write(payload);
    }
    req.end();
  });
}

export function getJson<T>(pathname: string, cookie: string): Promise<T> {
  return request<T>("GET", pathname, cookie);
}

export function postJson<T>(pathname: string, cookie: string, body: unknown): Promise<T> {
  return request<T>("POST", pathname, cookie, body);
}

/* -------------------------------------------------------------------------- */
/* Endpoint response shapes (subset we use)                                    */
/* -------------------------------------------------------------------------- */

export interface AuthMe {
  sub?: string;
  email?: string;
}

export interface LegacyUsageBucket {
  numRequests: number;
  maxRequestUsage: number;
}

export interface UsageResponse {
  ["gpt-4"]?: LegacyUsageBucket;
  startOfMonth?: string;
}

export interface UsageSummary {
  membershipType?: string;
  isUnlimited?: boolean;
  limitType?: string;
  billingCycleStart?: string;
  billingCycleEnd?: string;
  individualUsage?: {
    plan?: { used?: number; totalPercentUsed?: number };
    onDemand?: { used?: number; limit?: number; remaining?: number };
  };
}

export interface TeamsResponse {
  teams?: Array<{ id: number; requestQuotaPerSeat?: number }>;
}

export interface HardLimitResponse {
  hardLimitPerUser?: number;
}

export interface AggregationRow {
  modelIntent?: string;
  totalCents?: number;
  requestCost?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface AggregatedUsageResponse {
  aggregations?: AggregationRow[];
  totalCostCents?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalCacheReadTokens?: number;
}

/* Endpoint helpers ---------------------------------------------------------- */

export const endpoints = {
  me: (cookie: string) => getJson<AuthMe>("/api/auth/me", cookie),

  usage: (cookie: string, sub: string) =>
    getJson<UsageResponse>(`/api/usage?user=${encodeURIComponent(sub)}`, cookie),

  usageSummary: (cookie: string) => getJson<UsageSummary>("/api/usage-summary", cookie),

  teams: (cookie: string) =>
    postJson<TeamsResponse>("/api/dashboard/teams", cookie, { activeOnly: false }),

  hardLimit: (cookie: string, teamId: number) =>
    postJson<HardLimitResponse>("/api/dashboard/get-hard-limit", cookie, { teamId }),

  aggregatedUsage: (cookie: string, teamId: number) =>
    postJson<AggregatedUsageResponse>(
      "/api/dashboard/get-aggregated-usage-events",
      cookie,
      { teamId }
    ),
};
