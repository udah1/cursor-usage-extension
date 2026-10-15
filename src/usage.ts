import { readAuthContext, sessionExpiredFailure, AuthContext, AuthFailure } from "./auth";
import { log, sanitizeError } from "./log";
import {
  endpoints,
  isAuthError,
  AggregationRow,
  UsageResponse,
  UsageSummary,
  TeamsResponse,
  PlanUsage,
  PlanInfoResponse,
  SandUsageStatus,
  CurrentPeriodUsage,
} from "./api";

/** Where "Open Dashboard" should land for this account. */
export type DashboardHost = "cursor" | "grok";

const UNIFIED_MEMBERSHIPS = new Set(["premium", "plus", "super", "unified_ultra"]);

const CURSOR_USAGE_URL = "https://cursor.com/dashboard/usage";
const CURSOR_SPENDING_URL = "https://cursor.com/dashboard/spending";
const GROK_USAGE_URL = "https://grok.com/dashboard/usage";
const GROK_BILLING_URL = "https://grok.com/dashboard/billing";

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

/** Request-count meters (typical team/enterprise) vs spending-style percent meters (individual Pro). */
export type MeterMode = "requests" | "spending";

export interface GrokBotUsage {
  percent: number;
  resetsAt?: string;
  daysLeft?: number;
  label?: string;
}

export interface UsageOk {
  state: "ok";
  fetchedAt: number;

  isTeam: boolean;
  meterMode: MeterMode;
  membershipType: string;
  email?: string;
  planName?: string;
  planPrice?: string;

  // Included requests (request-based plans)
  used: number;
  limit: number;
  remaining: number;
  pct: number;
  /** Combined usage-based percent from the dashboard (not a request ratio). */
  totalPercentUsed?: number;
  /** Cursor Models bar (Composer / Cursor Grok / auto). */
  autoPercentUsed?: number;
  /** Other Models bar (named API models). */
  apiPercentUsed?: number;
  includedExhausted?: boolean;
  includedUsedDollars?: number;
  includedLimitDollars?: number;
  bonusDollars?: number;

  // On-demand spend (dollars). Hidden in the UI when `onDemandEnabled` is false.
  onDemandEnabled: boolean;
  onDemandUsed: number;
  onDemandLimit: number;
  onDemandRemaining: number;
  perUserHardLimit?: number;

  grokBot?: GrokBotUsage;

  // Billing cycle + burn rate
  billingCycleStart?: string;
  billingCycleEnd?: string;
  daysLeft?: number;
  requestsPerDay?: number;
  projectedRequests?: number;
  projectedToExceed?: boolean;

  // Per-model table (best-effort; team and individual)
  models?: ModelRow[];

  /**
   * Unified/Premium (Grok billing line): Cursor Models meters are weekly and the
   * browser dashboard lives on grok.com.
   */
  isUnified?: boolean;
  dashboardHost: DashboardHost;

  /** True when this is cached data kept on screen after a refresh failed. */
  stale?: boolean;
  /** Why the last refresh failed, when `stale` is set. */
  staleError?: string;
}

export type UsageResult =
  | UsageOk
  | ({ state: "needsAuth" } & AuthFailure)
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

function asNumber(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) {
    return v;
  }
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n)) {
      return n;
    }
  }
  return 0;
}

function hasRequestCap(usage: UsageResponse): boolean {
  const cap = usage["gpt-4"]?.maxRequestUsage;
  return typeof cap === "number" && Number.isFinite(cap) && cap > 0;
}

function hasSpendingMeters(plan: PlanUsage): boolean {
  return plan.autoPercentUsed != null || plan.apiPercentUsed != null;
}

/** Team/request-cap stays on the existing UI; individual Pro uses spending-style bars. */
export function detectMeterMode(
  isTeam: boolean,
  usage: UsageResponse,
  plan: PlanUsage,
  membershipType?: string
): MeterMode {
  if (isTeam || hasRequestCap(usage)) {
    return "requests";
  }
  if (hasSpendingMeters(plan) || isUnifiedMembership(membershipType)) {
    return "spending";
  }
  return "requests";
}

export function isUnifiedMembership(membershipType: string | undefined): boolean {
  if (!membershipType) {
    return false;
  }
  return UNIFIED_MEMBERSHIPS.has(membershipType.toLowerCase());
}

/** Unified/Premium plans: weekly included usage + grok.com dashboard. */
export function detectUnifiedPlan(
  membershipType: string | undefined,
  planInfo?: PlanInfoResponse,
  sand?: SandUsageStatus
): boolean {
  if (sand?.billingBrand === "SAND_BILLING_BRAND_GROK") {
    return true;
  }
  if (sand?.isUnified === true) {
    return true;
  }
  if (planInfo?.isMerged === true) {
    return true;
  }
  return isUnifiedMembership(membershipType);
}

export function dashboardUrlFor(result: Pick<UsageOk, "dashboardHost" | "meterMode">): string {
  if (result.dashboardHost === "grok") {
    return result.meterMode === "spending" ? GROK_BILLING_URL : GROK_USAGE_URL;
  }
  return result.meterMode === "spending" ? CURSOR_SPENDING_URL : CURSOR_USAGE_URL;
}

/** Normalize ISO or ms-epoch (number / numeric string) to an ISO timestamp. */
export function toIsoTimestamp(value: string | number | undefined | null): string | undefined {
  if (value == null || value === "") {
    return undefined;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return undefined;
    }
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  const trimmed = value.trim();
  if (/^\d{10,}$/.test(trimmed)) {
    const n = Number(trimmed);
    if (!Number.isFinite(n)) {
      return undefined;
    }
    const d = new Date(n);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    return undefined;
  }
  return new Date(parsed).toISOString();
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
        return res;
      }
      // A transient failure must never wipe data we already have on screen.
      if (res.state === "error" && lastGood) {
        return { ...lastGood, stale: true, staleError: res.error };
      }
      return res;
    })
    .finally(() => {
      inFlight = undefined;
    });

  return inFlight;
}

function toNeedsAuth(failure: AuthFailure): UsageResult {
  return { state: "needsAuth", ...failure };
}

async function doFetch(): Promise<UsageResult> {
  const first = await readAuthContext();
  if (!first.ok) {
    return toNeedsAuth(first);
  }
  let auth = first.context;

  try {
    return await fetchWithAuth(auth);
  } catch (err) {
    // Token rotation: on 401/403 re-read keys once and retry exactly once.
    if (isAuthError(err)) {
      log(`API auth error, re-reading local session: ${sanitizeError(err)}`);
      const reread = await readAuthContext();
      if (!reread.ok) {
        return toNeedsAuth(reread);
      }
      auth = reread.context;
      try {
        return await fetchWithAuth(auth);
      } catch (err2) {
        if (isAuthError(err2)) {
          log(`API still rejected the session after re-read: ${sanitizeError(err2)}`);
          return toNeedsAuth(sessionExpiredFailure());
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
  const plan = summary.individualUsage?.plan ?? {};
  const meterMode = detectMeterMode(isTeam, usage, plan, summary.membershipType);

  // Best-effort extras — never let one failure blank the panel.
  let teams: TeamsResponse | undefined;
  let perUserHardLimit: number | undefined;
  let models: ModelRow[] | undefined;
  let planInfo: PlanInfoResponse | undefined;
  let sand: SandUsageStatus | undefined;
  let currentPeriod: CurrentPeriodUsage | undefined;

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
  } else if (meterMode === "spending") {
    const [planR, sandR, aggR, periodR] = await Promise.allSettled([
      endpoints.planInfo(cookie),
      endpoints.sandUsage(cookie),
      endpoints.aggregatedUsage(cookie),
      endpoints.currentPeriodUsage(cookie),
    ]);
    if (planR.status === "fulfilled") {
      planInfo = planR.value;
    }
    if (sandR.status === "fulfilled") {
      sand = sandR.value;
    }
    if (aggR.status === "fulfilled") {
      models = mapModels(aggR.value?.aggregations);
    }
    if (periodR.status === "fulfilled") {
      currentPeriod = periodR.value;
    }
  }

  return buildResult({
    auth,
    usage,
    summary,
    isTeam,
    meterMode,
    teams,
    perUserHardLimit,
    models,
    planInfo,
    sand,
    currentPeriod,
  });
}

function mapModels(rows: AggregationRow[] | undefined): ModelRow[] | undefined {
  if (!rows || rows.length === 0) {
    return undefined;
  }
  return rows
    .map((r) => ({
      model: r.modelIntent ?? "unknown",
      costDollars: centsToDollars(asNumber(r.totalCents)),
      requests: asNumber(r.requestCost),
      inputTokens: asNumber(r.inputTokens),
      outputTokens: asNumber(r.outputTokens),
      cacheReadTokens: asNumber(r.cacheReadTokens),
      cacheWriteTokens: asNumber(r.cacheWriteTokens),
    }))
    .sort((a, b) => b.costDollars - a.costDollars);
}

function mapGrokBot(sand: SandUsageStatus | undefined, now: number): GrokBotUsage | undefined {
  if (!sand || sand.hasNonZeroIncludedLimit === false) {
    return undefined;
  }
  if (typeof sand.usagePercent !== "number" || !Number.isFinite(sand.usagePercent)) {
    return undefined;
  }
  const resetMs = sand.nextResetTimestampUtc ? Date.parse(sand.nextResetTimestampUtc) : NaN;
  return {
    percent: sand.usagePercent,
    resetsAt: sand.nextResetTimestampUtc,
    daysLeft: Number.isNaN(resetMs) ? undefined : Math.max(0, (resetMs - now) / DAY_MS),
    label: sand.grokPlanLabel,
  };
}

interface BuildInput {
  auth: AuthContext;
  usage: UsageResponse;
  summary: UsageSummary;
  isTeam: boolean;
  meterMode: MeterMode;
  teams?: TeamsResponse;
  perUserHardLimit?: number;
  models?: ModelRow[];
  planInfo?: PlanInfoResponse;
  sand?: SandUsageStatus;
  currentPeriod?: CurrentPeriodUsage;
}

function buildResult(input: BuildInput): UsageOk {
  const {
    auth,
    usage,
    summary,
    isTeam,
    meterMode,
    teams,
    perUserHardLimit,
    models,
    planInfo,
    sand,
    currentPeriod,
  } = input;

  const legacy = usage["gpt-4"] ?? {};
  const plan = summary.individualUsage?.plan ?? {};
  const onDemand = summary.individualUsage?.onDemand ?? {};
  const isUnified = detectUnifiedPlan(summary.membershipType, planInfo, sand);
  const dashboardHost: DashboardHost = isUnified ? "grok" : "cursor";

  // Unified/Premium: Cursor Models live on the weekly current-period endpoint.
  // usage-summary still returns monthly 0% bars that no longer match the dashboard.
  const useWeeklyMeters =
    isUnified &&
    currentPeriod?.planUsage != null &&
    (currentPeriod.planUsage.autoPercentUsed != null ||
      currentPeriod.planUsage.apiPercentUsed != null);

  const autoPercentUsed = useWeeklyMeters
    ? currentPeriod!.planUsage!.autoPercentUsed
    : plan.autoPercentUsed;
  const apiPercentUsed = useWeeklyMeters
    ? currentPeriod!.planUsage!.apiPercentUsed
    : plan.apiPercentUsed;
  const totalPercentUsed = useWeeklyMeters
    ? currentPeriod!.planUsage!.totalPercentUsed
    : plan.totalPercentUsed;

  const planUsedCents = plan.used ?? 0;
  const requestQuotaPerSeat =
    auth.teamId != null
      ? teams?.teams?.find((t) => t.id === auth.teamId)?.requestQuotaPerSeat
      : undefined;

  const usedFromSpend = planUsedCents > 0 ? getRequestCountFromSpendCents(planUsedCents) : undefined;

  const used = isTeam ? usedFromSpend ?? (legacy.numRequests ?? 0) : (legacy.numRequests ?? 0);
  const limit =
    isTeam && requestQuotaPerSeat != null
      ? 500 * requestQuotaPerSeat
      : legacy.maxRequestUsage ?? 0;

  const safeLimit = limit > 0 ? limit : 0;
  const remaining = Math.max(0, safeLimit - used);
  const pct = safeLimit > 0 ? Math.round((used / safeLimit) * 1000) / 10 : 0;

  const onDemandEnabled =
    onDemand.enabled === true ||
    (onDemand.enabled !== false && ((onDemand.limit ?? 0) > 0 || (onDemand.used ?? 0) > 0));
  const onDemandUsed = centsToDollars(onDemand.used ?? 0);
  const onDemandLimit = centsToDollars(onDemand.limit ?? 0);
  const onDemandRemaining = centsToDollars(onDemand.remaining ?? 0);

  const includedLimitCents = plan.limit ?? planInfo?.planInfo?.includedAmountCents ?? 0;
  const includedExhausted = includedLimitCents > 0 && planUsedCents >= includedLimitCents;

  const now = Date.now();
  const billingCycleStart = useWeeklyMeters
    ? toIsoTimestamp(currentPeriod!.billingCycleStart) ?? summary.billingCycleStart
    : summary.billingCycleStart;
  const billingCycleEnd = useWeeklyMeters
    ? toIsoTimestamp(currentPeriod!.billingCycleEnd) ?? summary.billingCycleEnd
    : summary.billingCycleEnd;

  const start = billingCycleStart ? Date.parse(billingCycleStart) : NaN;
  const end = billingCycleEnd ? Date.parse(billingCycleEnd) : NaN;

  let daysLeft: number | undefined;
  let requestsPerDay: number | undefined;
  let projectedRequests: number | undefined;
  let projectedToExceed: boolean | undefined;

  if (!Number.isNaN(end)) {
    daysLeft = Math.max(0, (end - now) / DAY_MS);
  }
  if (!Number.isNaN(start) && !Number.isNaN(end) && meterMode === "requests") {
    const elapsedDays = Math.max(0.5, (now - start) / DAY_MS);
    const cycleLengthDays = (end - start) / DAY_MS;
    requestsPerDay = used / elapsedDays;
    projectedRequests = Math.round(requestsPerDay * cycleLengthDays);
    projectedToExceed = safeLimit > 0 && projectedRequests > safeLimit;
  }

  const planName = sand?.cursorPlanName ?? planInfo?.planInfo?.planName;

  return {
    state: "ok",
    fetchedAt: now,
    isTeam,
    meterMode,
    membershipType: summary.membershipType ?? "unknown",
    email: auth.email,
    planName,
    planPrice: planInfo?.planInfo?.price,

    used,
    limit: safeLimit,
    remaining,
    pct,
    totalPercentUsed,
    autoPercentUsed,
    apiPercentUsed,
    includedExhausted,
    includedUsedDollars: centsToDollars(planUsedCents),
    includedLimitDollars: centsToDollars(includedLimitCents),
    bonusDollars: centsToDollars(plan.breakdown?.bonus ?? 0),

    onDemandEnabled,
    onDemandUsed,
    onDemandLimit,
    onDemandRemaining,
    perUserHardLimit,
    grokBot: mapGrokBot(sand, now),

    billingCycleStart,
    billingCycleEnd,
    daysLeft,
    requestsPerDay,
    projectedRequests,
    projectedToExceed,

    models,
    isUnified,
    dashboardHost,
  };
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
