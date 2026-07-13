import { readAuthContext, AuthContext } from "./auth";
import {
  endpoints,
  isAuthError,
  AggregationRow,
  UsageResponse,
  UsageSummary,
  TeamsResponse,
} from "./api";

/* -------------------------------------------------------------------------- */
/* Result types                                                                */
/* -------------------------------------------------------------------------- */

export interface ModelRow {
  model: string;
  costDollars: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface UsageOk {
  state: "ok";
  fetchedAt: number;

  isTeam: boolean;
  membershipType: string;
  email?: string;

  // Included requests
  used: number;
  limit: number;
  remaining: number;
  pct: number;
  /** Usage-based accounts show THIS on the dashboard instead of the request ratio. */
  totalPercentUsed?: number;

  // On-demand spend (dollars)
  onDemandUsed: number;
  onDemandLimit: number;
  onDemandRemaining: number;
  perUserHardLimit?: number;

  // Billing cycle + burn rate
  billingCycleStart?: string;
  billingCycleEnd?: string;
  daysLeft?: number;
  requestsPerDay?: number;
  projectedRequests?: number;
  projectedToExceed?: boolean;

  // Team per-model table (best-effort)
  models?: ModelRow[];
}

export type UsageResult =
  | UsageOk
  | { state: "needsAuth" }
  | { state: "error"; error: string };

/* -------------------------------------------------------------------------- */
/* Dashboard-matching helpers                                                  */
/* -------------------------------------------------------------------------- */

/** ~4 cents per request; matches the dashboard's spend→request conversion. */
export function getRequestCountFromSpendCents(cents: number): number {
  return cents > 0 ? Math.ceil(cents / 4) : 0;
}

export function centsToDollars(cents: number): number {
  return cents / 100;
}

const DAY_MS = 86_400_000;

/* -------------------------------------------------------------------------- */
/* Throttle + cache state                                                      */
/* -------------------------------------------------------------------------- */

const MIN_FETCH_INTERVAL_MS = 60_000;
let lastFetchStartedAt = 0;
let lastGood: UsageOk | undefined;
let inFlight: Promise<UsageResult> | undefined;

export function getCached(): UsageOk | undefined {
  return lastGood;
}

/* -------------------------------------------------------------------------- */
/* Core fetch                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Never throws. Returns a discriminated result. Hard-throttled to at most one
 * network fetch per 60s (returns the cached good result in between).
 */
export async function fetchUsage(force = false): Promise<UsageResult> {
  const now = Date.now();

  if (!force && now - lastFetchStartedAt < MIN_FETCH_INTERVAL_MS) {
    if (lastGood) {
      return lastGood;
    }
  }
  if (inFlight) {
    return inFlight;
  }

  lastFetchStartedAt = now;
  inFlight = doFetch()
    .then((res) => {
      if (res.state === "ok") {
        lastGood = res;
      }
      return res;
    })
    .finally(() => {
      inFlight = undefined;
    });

  return inFlight;
}

async function doFetch(): Promise<UsageResult> {
  let auth = await readAuthContext();
  if (!auth) {
    return { state: "needsAuth" };
  }

  try {
    return await fetchWithAuth(auth);
  } catch (err) {
    // Token rotation: on 401/403 re-read keys once and retry exactly once.
    if (isAuthError(err)) {
      const reread = await readAuthContext();
      if (!reread) {
        return { state: "needsAuth" };
      }
      auth = reread;
      try {
        return await fetchWithAuth(auth);
      } catch (err2) {
        if (isAuthError(err2)) {
          return { state: "needsAuth" };
        }
        return { state: "error", error: describeError(err2) };
      }
    }
    return { state: "error", error: describeError(err) };
  }
}

async function fetchWithAuth(auth: AuthContext): Promise<UsageResult> {
  const { cookie } = auth;

  // Authoritative sub for /api/usage.
  let sub = auth.sub;
  try {
    const me = await endpoints.me(cookie);
    if (me?.sub) {
      sub = me.sub;
    }
  } catch (err) {
    if (isAuthError(err)) {
      throw err;
    }
    // Non-auth failure: fall back to the JWT-derived sub.
  }

  // Core endpoints (these two must succeed).
  const usage = await endpoints.usage(cookie, sub);
  const summary = await endpoints.usageSummary(cookie);

  const isTeam = summary.limitType === "team";

  // Best-effort team extras — never let one failure blank the panel.
  let teams: TeamsResponse | undefined;
  let perUserHardLimit: number | undefined;
  let models: ModelRow[] | undefined;

  if (isTeam && auth.teamId != null) {
    const teamId = auth.teamId;
    const [teamsR, hardLimitR, aggR] = await Promise.allSettled([
      endpoints.teams(cookie),
      endpoints.hardLimit(cookie, teamId),
      endpoints.aggregatedUsage(cookie, teamId),
    ]);
    if (teamsR.status === "fulfilled") {
      teams = teamsR.value;
    }
    if (hardLimitR.status === "fulfilled") {
      perUserHardLimit = hardLimitR.value?.hardLimitPerUser;
    }
    if (aggR.status === "fulfilled") {
      models = mapModels(aggR.value?.aggregations);
    }
  }

  return buildResult({ auth, usage, summary, isTeam, teams, perUserHardLimit, models });
}

function mapModels(rows: AggregationRow[] | undefined): ModelRow[] | undefined {
  if (!rows || rows.length === 0) {
    return undefined;
  }
  return rows
    .map((r) => ({
      model: r.modelIntent ?? "unknown",
      costDollars: centsToDollars(r.totalCents ?? 0),
      requests: r.requestCost ?? 0,
      inputTokens: r.inputTokens ?? 0,
      outputTokens: r.outputTokens ?? 0,
      cacheReadTokens: r.cacheReadTokens ?? 0,
      cacheWriteTokens: r.cacheWriteTokens ?? 0,
    }))
    .sort((a, b) => b.costDollars - a.costDollars);
}

interface BuildInput {
  auth: AuthContext;
  usage: UsageResponse;
  summary: UsageSummary;
  isTeam: boolean;
  teams?: TeamsResponse;
  perUserHardLimit?: number;
  models?: ModelRow[];
}

function buildResult(input: BuildInput): UsageOk {
  const { auth, usage, summary, isTeam, teams, perUserHardLimit, models } = input;

  const legacy = usage["gpt-4"] ?? { numRequests: 0, maxRequestUsage: 0 };
  const plan = summary.individualUsage?.plan ?? {};
  const onDemand = summary.individualUsage?.onDemand ?? {};

  const planUsedCents = plan.used ?? 0;
  const requestQuotaPerSeat =
    auth.teamId != null
      ? teams?.teams?.find((t) => t.id === auth.teamId)?.requestQuotaPerSeat
      : undefined;

  const usedFromSpend = planUsedCents > 0 ? getRequestCountFromSpendCents(planUsedCents) : undefined;

  const used = isTeam ? usedFromSpend ?? legacy.numRequests : legacy.numRequests;
  const limit =
    isTeam && requestQuotaPerSeat != null
      ? 500 * requestQuotaPerSeat
      : legacy.maxRequestUsage;

  const safeLimit = limit > 0 ? limit : legacy.maxRequestUsage || 0;
  const remaining = Math.max(0, safeLimit - used);
  const pct = safeLimit > 0 ? Math.round((used / safeLimit) * 1000) / 10 : 0;

  // On-demand (cents → dollars).
  const onDemandUsed = centsToDollars(onDemand.used ?? 0);
  const onDemandLimit = centsToDollars(onDemand.limit ?? 0);
  const onDemandRemaining = centsToDollars(onDemand.remaining ?? 0);

  // Billing cycle + burn rate.
  const now = Date.now();
  const start = summary.billingCycleStart ? Date.parse(summary.billingCycleStart) : NaN;
  const end = summary.billingCycleEnd ? Date.parse(summary.billingCycleEnd) : NaN;

  let daysLeft: number | undefined;
  let requestsPerDay: number | undefined;
  let projectedRequests: number | undefined;
  let projectedToExceed: boolean | undefined;

  if (!Number.isNaN(end)) {
    daysLeft = Math.max(0, (end - now) / DAY_MS);
  }
  if (!Number.isNaN(start) && !Number.isNaN(end)) {
    const elapsedDays = Math.max(0.5, (now - start) / DAY_MS);
    const cycleLengthDays = (end - start) / DAY_MS;
    requestsPerDay = used / elapsedDays;
    projectedRequests = Math.round(requestsPerDay * cycleLengthDays);
    projectedToExceed = safeLimit > 0 && projectedRequests > safeLimit;
  }

  return {
    state: "ok",
    fetchedAt: now,
    isTeam,
    membershipType: summary.membershipType ?? "unknown",
    email: auth.email,

    used,
    limit: safeLimit,
    remaining,
    pct,
    totalPercentUsed: plan.totalPercentUsed,

    onDemandUsed,
    onDemandLimit,
    onDemandRemaining,
    perUserHardLimit,

    billingCycleStart: summary.billingCycleStart,
    billingCycleEnd: summary.billingCycleEnd,
    daysLeft,
    requestsPerDay,
    projectedRequests,
    projectedToExceed,

    models,
  };
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
