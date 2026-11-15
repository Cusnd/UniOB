import type {
  CfPlanSource,
  CfWorkersPlan,
  Env,
  HubCloudflareQuota,
} from "./types";

export const CF_MANUAL_PLAN_SETTING_KEY = "cf_workers_plan_manual";

/**
 * Cloudflare Free hard-caps a single SQLite-backed Durable Object at 1 GB
 * (1,073,741,824 bytes / 1 GiB conservative ceiling). Any live DO database
 * exceeding this ceiling is provably running on a Workers Paid account.
 */
const CF_FREE_SINGLE_DO_HARD_CAP_BYTES = 1_073_741_824;

const POSITIVE_CACHE_TTL_MS = 15 * 60 * 1000;
const NEGATIVE_CACHE_TTL_MS = 60 * 1000;

interface CachedApiPlanEntry {
  plan: CfWorkersPlan | null;
  expiresAtMs: number;
}

const apiPlanCache = new Map<string, CachedApiPlanEntry>();

export function clearCfPlanCacheForTest(): void {
  apiPlanCache.clear();
}

export function parseCfWorkersPlan(raw: unknown): CfWorkersPlan | null {
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().toLowerCase();
  if (
    normalized === "free" ||
    normalized === "workers_free" ||
    normalized === "workers-free"
  ) {
    return "free";
  }
  if (
    normalized === "paid" ||
    normalized === "workers_paid" ||
    normalized === "workers-paid"
  ) {
    return "paid";
  }
  return null;
}

function isSubscriptionWorkersPaid(sub: unknown): boolean {
  if (!sub || typeof sub !== "object") return false;
  const item = sub as Record<string, unknown>;
  const state =
    typeof item.state === "string" ? item.state.trim().toLowerCase() : "";
  if (
    state === "cancelled" ||
    state === "canceled" ||
    state === "expired" ||
    state === "deactivated"
  ) {
    return false;
  }
  if (
    state &&
    state !== "paid" &&
    state !== "provisioned" &&
    state !== "trial" &&
    state !== "active"
  ) {
    return false;
  }

  const ratePlan =
    item.rate_plan && typeof item.rate_plan === "object"
      ? (item.rate_plan as Record<string, unknown>)
      : null;
  const rateId =
    ratePlan && typeof ratePlan.id === "string"
      ? ratePlan.id.trim().toLowerCase()
      : "";
  const publicName =
    ratePlan && typeof ratePlan.public_name === "string"
      ? ratePlan.public_name.trim().toLowerCase()
      : "";

  if (
    rateId === "workers_paid" ||
    rateId === "partners_workers_paid" ||
    rateId.startsWith("workers_paid") ||
    rateId === "unbound_paid" ||
    publicName.includes("workers paid")
  ) {
    return true;
  }

  return false;
}

export async function detectCfWorkersPlanFromApi(
  env: Env,
  forceRefresh = false,
): Promise<CfWorkersPlan | null> {
  const token = (env.CF_API_TOKEN || env.CLOUDFLARE_API_TOKEN || "").trim();
  const accountId = (
    env.CF_ACCOUNT_ID ||
    env.CLOUDFLARE_ACCOUNT_ID ||
    ""
  ).trim();
  if (!token || !accountId) {
    return null;
  }

  const cacheKey = `${accountId}:${token.slice(0, 4)}:${token.slice(-4)}:${token.length}`;
  const nowMs = Date.now();
  if (!forceRefresh) {
    const cached = apiPlanCache.get(cacheKey);
    if (cached && cached.expiresAtMs > nowMs) {
      return cached.plan;
    }
  }

  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/subscriptions`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(3500),
      },
    );
    if (!res.ok) {
      apiPlanCache.set(cacheKey, {
        plan: null,
        expiresAtMs: nowMs + NEGATIVE_CACHE_TTL_MS,
      });
      return null;
    }

    const body = (await res.json()) as Record<string, unknown>;
    if (!body || body.success !== true || !Array.isArray(body.result)) {
      apiPlanCache.set(cacheKey, {
        plan: null,
        expiresAtMs: nowMs + NEGATIVE_CACHE_TTL_MS,
      });
      return null;
    }

    const detected: CfWorkersPlan = body.result.some(isSubscriptionWorkersPaid)
      ? "paid"
      : "free";
    apiPlanCache.set(cacheKey, {
      plan: detected,
      expiresAtMs: nowMs + POSITIVE_CACHE_TTL_MS,
    });
    return detected;
  } catch {
    apiPlanCache.set(cacheKey, {
      plan: null,
      expiresAtMs: nowMs + NEGATIVE_CACHE_TTL_MS,
    });
    return null;
  }
}

export interface FleetNqQuotaControl {
  enabled: boolean;
  intervalSec: number;
  targetCount: number;
}

export interface FleetScchEstimates {
  nqEnabledNodes: number;
  estDailyDoWrites: number;
  estDailyDoRequests: number;
  estSteadyStorageBytes: number;
}

export function computeFleetScchEstimates(
  totalNodes: number,
  nqControls: Iterable<FleetNqQuotaControl>,
): FleetScchEstimates {
  const safeNodes = Math.max(0, Math.floor(totalNodes));
  const coreDailyWrites = safeNodes > 0 ? 888 * safeNodes + 96 : 0;

  let nqEnabledNodes = 0;
  let nqDailyWrites = 0;
  let nqSteadyStorage = 0;

  for (const ctrl of nqControls) {
    if (ctrl.enabled && ctrl.targetCount > 0) {
      nqEnabledNodes += 1;
      const clampedInterval = Math.max(10, ctrl.intervalSec || 20);
      nqDailyWrites += Math.round(1034 * Math.min(1, 300 / clampedInterval));
      nqSteadyStorage += Math.round(
        17_707_932 * (ctrl.targetCount / 3) * Math.min(2, 20 / clampedInterval),
      );
    }
  }

  return {
    nqEnabledNodes,
    estDailyDoWrites: coreDailyWrites + nqDailyWrites,
    estDailyDoRequests: safeNodes > 0 ? Math.round(14.4 * safeNodes + 96) : 0,
    estSteadyStorageBytes: safeNodes * 1_840_000 + nqSteadyStorage,
  };
}

export async function readManualCfPlan(
  db: D1Database,
): Promise<CfWorkersPlan | null> {
  const row = await db
    .prepare("SELECT value FROM system_settings WHERE key = ?")
    .bind(CF_MANUAL_PLAN_SETTING_KEY)
    .first<{ value: string }>();
  return parseCfWorkersPlan(row?.value);
}

export async function saveManualCfPlan(
  db: D1Database,
  plan: CfWorkersPlan,
): Promise<void> {
  const nowSec = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      `INSERT INTO system_settings (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(CF_MANUAL_PLAN_SETTING_KEY, plan, nowSec)
    .run();
}

export async function resolveHubCloudflareQuota(params: {
  env: Env;
  doStorageBytes: number | null;
  estimates: FleetScchEstimates;
  forceRefresh?: boolean;
}): Promise<HubCloudflareQuota> {
  const { env, doStorageBytes, estimates, forceRefresh = false } = params;

  const [apiPlan, manualPlan] = await Promise.all([
    detectCfWorkersPlanFromApi(env, forceRefresh),
    readManualCfPlan(env.DB),
  ]);

  let detectedPlan: CfWorkersPlan | null = null;
  let planSource: CfPlanSource = "default";

  if (apiPlan !== null) {
    detectedPlan = apiPlan;
    planSource = "api";
  } else {
    const envPlan = parseCfWorkersPlan(env.CF_WORKERS_PLAN);
    if (envPlan !== null) {
      detectedPlan = envPlan;
      planSource = "env";
    } else if (
      doStorageBytes !== null &&
      doStorageBytes > CF_FREE_SINGLE_DO_HARD_CAP_BYTES
    ) {
      detectedPlan = "paid";
      planSource = "runtime";
    }
  }

  let effectivePlan: CfWorkersPlan = "free";
  if (detectedPlan !== null) {
    effectivePlan = detectedPlan;
  } else if (manualPlan !== null) {
    effectivePlan = manualPlan;
    planSource = "manual";
  } else {
    effectivePlan = "free";
    planSource = "default";
  }

  return {
    detected_plan: detectedPlan,
    manual_plan: manualPlan,
    effective_plan: effectivePlan,
    plan_source: planSource,
    do_storage_bytes: doStorageBytes,
    nq_enabled_nodes: estimates.nqEnabledNodes,
    est_daily_do_writes: estimates.estDailyDoWrites,
    est_daily_do_requests: estimates.estDailyDoRequests,
    est_steady_storage_bytes: estimates.estSteadyStorageBytes,
  };
}
