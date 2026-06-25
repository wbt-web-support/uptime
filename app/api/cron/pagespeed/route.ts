import { NextRequest, NextResponse } from "next/server";
import { createAdminClient, getDomainTargets, runAndSavePageSpeed, type Strategy } from "@/utils/pagespeed";

// Scheduled PageSpeed batch runner.
//
// Each invocation builds the full set of test targets (every domain's main URL
// + inner pages, mobile + desktop), then processes the STALEST ones first within
// a time budget. Because every test saves independently, the job is self-healing
// across serverless timeouts: whatever it does not reach this run becomes the
// highest-priority work next run. Schedule it frequently (see vercel.json) and it
// keeps all domains fresh on a rolling basis.
//
// Auth: send `Authorization: Bearer <CRON_SECRET>`. Vercel Cron does this
// automatically when CRON_SECRET is set in the project env.

export const dynamic = "force-dynamic";
export const maxDuration = 300; // seconds (Vercel Pro/Enterprise; Hobby caps at 60)

// Google PageSpeed Insights API limits (with PAGESPEED_INSIGHTS_API_KEY):
//   - 25,000 queries / day
//   - 400 queries / 100 seconds
//   - a documented soft throttle around ~1 request/second sustained (bursts 429)
// The defaults below stay comfortably inside all three:
//   MIN_INTERVAL_MS=1200 caps starts at ~50/min (~83 per 100s, well under 400),
//   DAILY_BUDGET guards the 25k/day cap, and CONCURRENCY only lets the long
//   (10-30s) calls overlap — the pacing gate, not concurrency, sets the rate.
// Each site is re-scanned once its newest result is older than this window
// (default 60h ≈ 2.5 days, i.e. every 2-3 days). The cron only tests targets
// past this age, so most runs do little or nothing until sites fall due.
const RETEST_HOURS = Number(process.env.PAGESPEED_RETEST_HOURS || 60);
// We work at the granularity of one PSI call (one URL × one strategy), NOT whole
// sites — a heavy site is ~8-12 calls and can take ~5 minutes on its own, far more
// than one serverless run (max 300s) allows. The rolling stale-first queue spreads
// those calls across many runs. Each call is ~10-40s, so concurrency (not the
// pacing gate) sets per-run throughput: ~CONCURRENCY × TIME_BUDGET / call_duration.
// Concurrency 12 ≈ 55-110 calls per 4.5-min run. The start-pacing gate still bounds
// the request RATE, so higher concurrency (more overlapping slow calls) stays API-safe.
const CONCURRENCY = Number(process.env.PAGESPEED_CONCURRENCY || 16);
const MAX_PER_RUN = Number(process.env.PAGESPEED_MAX_PER_RUN || 200);
const MIN_INTERVAL_MS = Number(process.env.PAGESPEED_MIN_INTERVAL_MS || 1200);
const DAILY_BUDGET = Number(process.env.PAGESPEED_DAILY_BUDGET || 25000);
// Leave headroom under maxDuration so in-flight tests can finish and save.
const TIME_BUDGET_MS = Number(process.env.PAGESPEED_TIME_BUDGET_MS || 270000);

interface Target {
  domainId: string;
  url: string;
  strategy: Strategy;
  lastTested: number; // epoch ms; 0 = never tested (highest priority)
}

async function runBatch(force: boolean, maxOverride: number | null) {
  const supabase = createAdminClient();
  const startedAt = Date.now();

  const { data: domains, error } = await supabase
    .from("domains")
    .select("id, uptime_url, inner_pages");
  if (error) throw error;
  if (!domains || domains.length === 0) {
    return { message: "No domains to test", processed: 0, succeeded: 0, failed: 0, remaining: 0 };
  }

  // Daily-budget guard: count tests already run in the last 24h so we never
  // blow the 25k/day PageSpeed quota. Uses an exact count (head request).
  const dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { count: usedToday } = await supabase
    .from("pagespeed_results")
    .select("id", { count: "exact", head: true })
    .gte("tested_at", dayAgo);

  const remainingDailyBudget = Math.max(0, DAILY_BUDGET - (usedToday || 0));
  if (remainingDailyBudget === 0) {
    return {
      message: "Daily PageSpeed budget reached, skipping",
      usedToday: usedToday || 0,
      dailyBudget: DAILY_BUDGET,
      processed: 0,
      succeeded: 0,
      failed: 0,
      remaining: 0,
    };
  }

  // Map existing results to their last tested time, keyed by domain|url|strategy.
  const { data: existing } = await supabase
    .from("pagespeed_results")
    .select("domain_id, url, strategy, tested_at");

  const lastTestedMap = new Map<string, number>();
  for (const row of existing || []) {
    const key = `${row.domain_id}|${row.url}|${row.strategy}`;
    const ts = row.tested_at ? new Date(row.tested_at).getTime() : 0;
    const prev = lastTestedMap.get(key) || 0;
    if (ts > prev) lastTestedMap.set(key, ts);
  }

  // Build and prioritise the work list (stalest first).
  const cutoff = Date.now() - RETEST_HOURS * 3600 * 1000;
  const allTargets: Target[] = [];
  for (const domain of domains) {
    for (const { url, strategy } of getDomainTargets(domain)) {
      const lastTested = lastTestedMap.get(`${domain.id}|${url}|${strategy}`) || 0;
      allTargets.push({ domainId: domain.id, url, strategy, lastTested });
    }
  }

  const due = (force ? allTargets : allTargets.filter((t) => t.lastTested < cutoff)).sort(
    (a, b) => a.lastTested - b.lastTested
  );

  // Never queue more than the remaining daily quota allows.
  const limit = Math.min(maxOverride ?? MAX_PER_RUN, remainingDailyBudget);
  const queue = due.slice(0, limit);

  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  let index = 0;
  let budgetHit = false;

  const delay = (ms: number) => new Promise((res) => setTimeout(res, ms));

  // Global pacing gate shared by all workers: ensures at most one request is
  // *started* every MIN_INTERVAL_MS, keeping us under the API's ~1/sec and
  // 400-per-100s limits regardless of concurrency.
  let nextStartAt = startedAt;
  const acquireSlot = async () => {
    const now = Date.now();
    const wait = Math.max(0, nextStartAt - now);
    nextStartAt = Math.max(now, nextStartAt) + MIN_INTERVAL_MS;
    if (wait > 0) await delay(wait);
  };

  const worker = async () => {
    while (true) {
      if (Date.now() - startedAt > TIME_BUDGET_MS) {
        budgetHit = true;
        return;
      }
      const current = index++;
      if (current >= queue.length) return;
      const t = queue[current];
      await acquireSlot();
      const result = await runAndSavePageSpeed(supabase, t.domainId, t.url, t.strategy);
      processed++;
      if (result.success) succeeded++;
      else failed++;
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, CONCURRENCY) }).map(() => worker()));

  return {
    message: "PageSpeed batch completed",
    timestamp: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    domains: domains.length,
    dueTargets: due.length,
    processed,
    succeeded,
    failed,
    remaining: Math.max(0, due.length - processed),
    budgetHit,
    usedToday: usedToday || 0,
    dailyBudget: DAILY_BUDGET,
    remainingDailyBudget: Math.max(0, remainingDailyBudget - processed),
  };
}

async function handle(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const expectedSecret = process.env.CRON_SECRET;
  if (!expectedSecret) {
    console.warn("[cron/pagespeed] CRON_SECRET is not set — endpoint is unprotected.");
  } else if (authHeader !== `Bearer ${expectedSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const force = searchParams.get("force") === "1" || searchParams.get("force") === "true";
  const maxParam = searchParams.get("max");
  const maxOverride = maxParam ? Math.max(1, Number(maxParam)) : null;

  try {
    const summary = await runBatch(force, maxOverride);
    return NextResponse.json(summary);
  } catch (err: any) {
    console.error("[cron/pagespeed] error:", err);
    return NextResponse.json({ error: err.message || "Internal server error" }, { status: 500 });
  }
}

// GET for cron schedulers (Vercel Cron). POST for manual/explicit triggers.
export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}
