import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/utils/pagespeed";
import { probeUrl } from "@/utils/monitoring";
import { startFunnelTest, syncFunnelTest } from "@/utils/funnel-tester";
import { isChooserFunnel } from "@/utils/funnel-discovery";

// Scheduled funnel tester: tests funnels automatically, one at a time.
//
// A walk takes minutes, longer than one serverless run, so each invocation only
// moves things one step: save the result of a walk that has finished, then, if
// nothing is running and the hourly cap allows, check the next due funnel's page
// loads and start its walk. Run it every few minutes (see vercel.json).
//
// Every test walks the funnel on desktop then mobile and submits the form for real
// each time, so it creates two real leads on the client's site. FUNNEL_RETEST_DAYS
// keeps that to one test per funnel per window.
// Set FUNNEL_AUTO_TEST=false to switch automatic testing off.
//
// Auth: send `Authorization: Bearer <CRON_SECRET>`. Vercel Cron does this
// automatically when CRON_SECRET is set in the project env.

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const TESTS_PER_HOUR = Number(process.env.FUNNEL_TESTS_PER_HOUR || 10);
const RETEST_DAYS = Number(process.env.FUNNEL_RETEST_DAYS || 7);
// Down pages are skipped without a walk; cap how many we probe in one run
const MAX_PROBES_PER_RUN = 10;

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const expectedSecret = process.env.CRON_SECRET;
  if (!expectedSecret) {
    console.warn("[cron/funnels] CRON_SECRET is not set — endpoint is unprotected.");
  } else if (authHeader !== `Bearer ${expectedSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (process.env.FUNNEL_AUTO_TEST === "false") {
    return NextResponse.json({ message: "Automatic funnel testing is switched off (FUNNEL_AUTO_TEST=false)" });
  }

  try {
    const supabase = createAdminClient();

    // 1. Save results of walks that have ended
    const { data: running, error: runningError } = await supabase
      .from("funnels")
      .select("*")
      .eq("test_status", "running");
    if (runningError) throw runningError;

    let stillRunning = 0;
    for (const funnel of running || []) {
      const { funnel: synced } = await syncFunnelTest(supabase, funnel);
      if (synced.test_status === "running") stillRunning++;
    }

    // One walk at a time, whether started here or from the page
    if (stillRunning > 0) {
      return NextResponse.json({ message: "A funnel test is still running", running: stillRunning });
    }

    // 2. Respect the hourly cap
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { count: startedThisHour, error: countError } = await supabase
      .from("funnels")
      .select("id", { count: "exact", head: true })
      .gte("test_started_at", hourAgo);
    if (countError) throw countError;

    if ((startedThisHour ?? 0) >= TESTS_PER_HOUR) {
      return NextResponse.json({ message: `Hourly limit of ${TESTS_PER_HOUR} tests reached`, started_this_hour: startedThisHour });
    }

    // 3. Next due funnels: never tested first, then the longest ago
    const dueBefore = new Date(Date.now() - RETEST_DAYS * 24 * 60 * 60 * 1000).toISOString();
    // "*" rather than naming test_enabled, so this keeps working before
    // migrations/add_funnel_test_enabled.sql has been run
    const { data: dueRows, error: dueError } = await supabase
      .from("funnels")
      .select("*")
      .or(`test_finished_at.is.null,test_finished_at.lt.${dueBefore}`)
      .order("test_finished_at", { ascending: true, nullsFirst: true })
      .order("created_at", { ascending: true })
      .limit(MAX_PROBES_PER_RUN * 5);
    if (dueError) throw dueError;
    // Funnels switched off on the Funnel Test page, and chooser pages (no form of
    // their own - their services are tested instead), are never tested automatically
    const due = (dueRows ?? [])
      .filter(f => f.test_enabled !== false && !isChooserFunnel(f))
      .slice(0, MAX_PROBES_PER_RUN);

    if (!due || due.length === 0) {
      return NextResponse.json({ message: `All funnels tested within the last ${RETEST_DAYS} days` });
    }

    // 4. Quick page check first; only walk funnels whose page loads
    const skipped: string[] = [];
    for (const funnel of due) {
      const result = await probeUrl(funnel.url);
      const checkedAt = new Date().toISOString();
      const pageUpdate = {
        last_status: result.isUp,
        last_status_code: result.statusCode,
        last_response_time: result.responseTime,
        last_error: result.error,
        last_checked_at: checkedAt,
      };

      if (!result.isUp) {
        // Counts as this window's test so a dead page isn't probed every run
        await supabase
          .from("funnels")
          .update({
            ...pageUpdate,
            test_status: "error",
            test_failure: `Skipped: page is down (${result.error})`,
            test_finished_at: checkedAt,
          })
          .eq("id", funnel.id);
        skipped.push(funnel.name);
        continue;
      }

      await supabase.from("funnels").update(pageUpdate).eq("id", funnel.id);
      const { runId } = await startFunnelTest(supabase, funnel);
      return NextResponse.json({ message: "Started funnel test", funnel: funnel.name, run_id: runId, skipped_down: skipped });
    }

    return NextResponse.json({ message: "No reachable funnel to test this run", skipped_down: skipped });
  } catch (error: any) {
    console.error("[cron/funnels] error:", error);
    return NextResponse.json({ error: error.message || "Internal server error" }, { status: 500 });
  }
}
