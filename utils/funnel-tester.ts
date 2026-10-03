import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/utils/supabase/server";

// The funnel-tester backend (funnel-tester/backend) runs as its own always-on server:
// a walk drives a real browser for minutes, which does not fit a serverless function.
export const FUNNEL_TESTER_URL = (process.env.FUNNEL_TESTER_URL || "http://localhost:4000").replace(/\/$/, "");
// Must match FUNNEL_TESTER_API_KEY on the backend once it is set there
const FUNNEL_TESTER_API_KEY = process.env.FUNNEL_TESTER_API_KEY;

// Same rule as the /api/check routes: signed in and listed in ADMIN_EMAIL.
// Returns the Supabase client, or the error response to send back.
export async function requireAdmin() {
  const supabase = await createClient();
  const { data: { session } } = await supabase.auth.getSession();

  if (!session) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }

  const adminEmail = process.env.ADMIN_EMAIL || "admin@example.com";
  const adminEmails = adminEmail.split(',').map(email => email.trim().toLowerCase());

  if (!session.user?.email || !adminEmails.includes(session.user.email.toLowerCase())) {
    return { error: NextResponse.json({ error: "Admin access required" }, { status: 403 }) };
  }

  return { supabase };
}

export const VIEWPORTS = ["desktop", "mobile"] as const;
type Viewport = (typeof VIEWPORTS)[number];

const deviceLabel = (v: Viewport) => (v === "desktop" ? "Desktop" : "Mobile");

// How many full reports to keep per funnel, kind and device
const REPORTS_KEPT = 5;

// Copy a finished report into the database (the tester's own files can be wiped by
// a redeploy) and drop the oldest beyond REPORTS_KEPT. Returns the new row's id.
async function saveReport(
  supabase: SupabaseClient,
  funnelId: string,
  kind: "test" | "ui",
  viewport: Viewport,
  status: string,
  report: unknown
): Promise<string | null> {
  const { data, error } = await supabase
    .from("funnel_reports")
    .insert({ funnel_id: funnelId, kind, viewport, status, report })
    .select("id")
    .single();
  if (error) {
    console.error("[funnel-tester] could not save report:", error.message);
    return null;
  }

  const { data: older } = await supabase
    .from("funnel_reports")
    .select("id")
    .eq("funnel_id", funnelId)
    .eq("kind", kind)
    .eq("viewport", viewport)
    .order("created_at", { ascending: false })
    .range(REPORTS_KEPT, REPORTS_KEPT + 100);
  if (older?.length) {
    await supabase.from("funnel_reports").delete().in("id", older.map(r => r.id));
  }

  return data.id;
}

// ---------------------------------------------------------------------------
// Funnel test: AI walk through the funnel on desktop then mobile
// ---------------------------------------------------------------------------

interface ViewportResult {
  status: "passed" | "failed" | "error";
  failure: string | null;
  steps: number | null;
  tracking_ok: boolean | null;
  report_id: string | null;
}

// Kick off a walk on desktop then mobile and mark the funnel as running.
// Each device submits the funnel's form for real, so every test creates two real leads.
export async function startFunnelTest(
  supabase: SupabaseClient,
  funnel: { id: string; name: string; url: string }
) {
  const res = await funnelTesterFetch("/run-batch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items: [{ url: funnel.url, name: funnel.name }], viewports: VIEWPORTS }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.batchId) {
    throw new Error(data.error || `Funnel tester responded with status ${res.status}`);
  }

  const startedAt = new Date().toISOString();
  const { error } = await supabase
    .from("funnels")
    .update({
      test_status: "running",
      test_run_id: data.batchId,
      test_failure: null,
      test_steps: null,
      test_tracking_ok: null,
      test_report_file: null,
      test_results: null,
      test_started_at: startedAt,
      test_finished_at: null,
    })
    .eq("id", funnel.id);
  if (error) throw error;

  return { runId: data.batchId as string, startedAt };
}

// Turn one finished device run into its result, saving the full report to the database
async function readViewportResult(
  supabase: SupabaseClient,
  funnelId: string,
  viewport: Viewport,
  run: any
): Promise<ViewportResult> {
  if (!run || run.status === "failed") {
    return { status: "error", failure: run?.error || "Test crashed", steps: null, tracking_ok: null, report_id: null };
  }

  const result: ViewportResult = {
    status: run.completed ? "passed" : "failed",
    failure: null,
    steps: null,
    tracking_ok: null,
    report_id: null,
  };

  if (run.reportFile) {
    const reportRes = await funnelTesterFetch(`/reports/${encodeURIComponent(run.reportFile)}`);
    if (reportRes.ok) {
      const [report] = await reportRes.json();
      if (report) {
        result.failure = report.failure || null;
        result.steps = Array.isArray(report.steps) ? report.steps.length : null;
        result.tracking_ok = !!(report.gtmPresentThroughout || report.gtagPresentThroughout);
        result.report_id = await saveReport(supabase, funnelId, "test", viewport, result.status, report);
      }
    }
  }
  return result;
}

// Ask the backend how a running test is going. While it runs, returns the walker's
// latest message and screenshot; once both devices have finished, saves the outcome.
export async function syncFunnelTest(
  supabase: SupabaseClient,
  funnel: any
): Promise<{ funnel: any; message?: string; screenshot?: string }> {
  if (funnel.test_status !== "running" || !funnel.test_run_id) {
    return { funnel };
  }

  const statusRes = await funnelTesterFetch(`/batch/${encodeURIComponent(funnel.test_run_id)}/status`);

  let update: Record<string, unknown>;

  if (statusRes.status === 404) {
    // Batch status lives in the backend's memory, so a restart loses it
    update = { test_status: "error", test_failure: "Test was interrupted (the funnel tester restarted)" };
  } else if (!statusRes.ok) {
    throw new Error(`Funnel tester responded with status ${statusRes.status}`);
  } else {
    const batch = await statusRes.json();
    const runs = batch.items?.[0]?.runs ?? {};

    const active = VIEWPORTS.find(v => runs[v]?.status === "running" || runs[v]?.status === "queued");
    if (active && !batch.done) {
      const messages: string[] = runs[active]?.messages || [];
      return {
        funnel,
        message: `${deviceLabel(active)}: ${messages[messages.length - 1] || "Starting..."}`,
        screenshot: runs[active]?.latestScreenshot,
      };
    }

    const results = {} as Record<Viewport, ViewportResult>;
    for (const v of VIEWPORTS) results[v] = await readViewportResult(supabase, funnel.id, v, runs[v]);
    const all = VIEWPORTS.map(v => results[v]);

    // Overall result: passed only when both devices passed
    const overall = all.some(r => r.status === "failed") ? "failed" : all.some(r => r.status === "error") ? "error" : "passed";
    const failures = VIEWPORTS
      .filter(v => results[v].failure)
      .map(v => `${deviceLabel(v)}: ${results[v].failure}`);

    update = {
      test_status: overall,
      test_results: results,
      test_failure: failures.length ? failures.join(" | ") : null,
      test_steps: results.desktop.steps,
      // Missing on either device counts as missing
      test_tracking_ok: all.some(r => r.tracking_ok === false) ? false : all.some(r => r.tracking_ok === true) ? true : null,
    };
  }

  update.test_finished_at = new Date().toISOString();
  const { data: updated, error } = await supabase
    .from("funnels")
    .update(update)
    .eq("id", funnel.id)
    .select()
    .single();
  if (error) throw error;

  return { funnel: updated };
}

// ---------------------------------------------------------------------------
// UI check: load the page, click every quote button, look for visual problems.
// Submits no forms, so it creates no leads.
// ---------------------------------------------------------------------------

interface UiViewportResult {
  status: "ok" | "issues" | "error";
  ui_issues: string[];
  quote_buttons_found: number;
  quote_buttons_working: number;
  // The main call-to-action, only checked when the page has no quote buttons
  cta: { label: string; works: boolean } | null;
  error: string | null;
  report_id: string | null;
}

export async function startUiCheck(
  supabase: SupabaseClient,
  funnel: { id: string; name: string; url: string }
) {
  const res = await funnelTesterFetch("/check-ui-batch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items: [{ url: funnel.url, name: funnel.name }] }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.batchId) {
    throw new Error(data.error || `Funnel tester responded with status ${res.status}`);
  }

  const startedAt = new Date().toISOString();
  const { error } = await supabase
    .from("funnels")
    .update({ ui_status: "running", ui_run_id: data.batchId, ui_results: null, ui_started_at: startedAt })
    .eq("id", funnel.id);
  if (error) throw error;

  return { runId: data.batchId as string, startedAt };
}

async function readUiResult(
  supabase: SupabaseClient,
  funnelId: string,
  viewport: Viewport,
  run: any
): Promise<UiViewportResult> {
  if (!run || run.status !== "completed") {
    return {
      status: "error",
      ui_issues: [],
      quote_buttons_found: 0,
      quote_buttons_working: 0,
      cta: null,
      error: run?.error || "Check did not finish",
      report_id: null,
    };
  }

  const quoteButtons: any[] = run.quoteButtons || [];
  const uiIssues: string[] = run.uiIssues || [];
  const cta = run.ctaCheck ? { label: run.ctaCheck.label, works: !!run.ctaCheck.changed } : null;
  const working = quoteButtons.filter(b => b.works).length;
  const problems = uiIssues.length + (quoteButtons.length - working) + (cta && !cta.works ? 1 : 0);
  const status = problems === 0 ? "ok" : "issues";

  const report = {
    screenshot: run.screenshot ?? null,
    uiIssues,
    quoteButtons,
    ctaCheck: run.ctaCheck ?? null,
    messages: run.messages ?? [],
  };

  return {
    status,
    ui_issues: uiIssues,
    quote_buttons_found: quoteButtons.length,
    quote_buttons_working: working,
    cta,
    error: null,
    report_id: await saveReport(supabase, funnelId, "ui", viewport, status, report),
  };
}

export async function syncUiCheck(
  supabase: SupabaseClient,
  funnel: any
): Promise<{ funnel: any; message?: string }> {
  if (funnel.ui_status !== "running" || !funnel.ui_run_id) {
    return { funnel };
  }

  const statusRes = await funnelTesterFetch(`/check-ui-batch/${encodeURIComponent(funnel.ui_run_id)}/status`);

  let update: Record<string, unknown>;

  if (statusRes.status === 404) {
    update = { ui_status: "error", ui_results: null };
  } else if (!statusRes.ok) {
    throw new Error(`Funnel tester responded with status ${statusRes.status}`);
  } else {
    const batch = await statusRes.json();
    const item = batch.items?.[0] ?? {};

    const active = VIEWPORTS.find(v => item[v]?.status === "running" || item[v]?.status === "queued");
    if (active && !batch.done) {
      const messages: string[] = item[active]?.messages || [];
      return { funnel, message: `${deviceLabel(active)}: ${messages[messages.length - 1] || "Starting..."}` };
    }

    const results = {} as Record<Viewport, UiViewportResult>;
    for (const v of VIEWPORTS) results[v] = await readUiResult(supabase, funnel.id, v, item[v]);
    const all = VIEWPORTS.map(v => results[v]);

    update = {
      ui_status: all.some(r => r.status === "issues") ? "issues" : all.some(r => r.status === "error") ? "error" : "ok",
      ui_results: results,
    };
  }

  update.ui_checked_at = new Date().toISOString();
  const { data: updated, error } = await supabase
    .from("funnels")
    .update(update)
    .eq("id", funnel.id)
    .select()
    .single();
  if (error) throw error;

  return { funnel: updated };
}

// Talk to the backend, turning "not running" into a readable message
export async function funnelTesterFetch(path: string, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  if (FUNNEL_TESTER_API_KEY) headers.set("Authorization", `Bearer ${FUNNEL_TESTER_API_KEY}`);

  let res: Response;
  try {
    res = await fetch(`${FUNNEL_TESTER_URL}${path}`, {
      ...init,
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new Error(`Funnel tester backend is not reachable at ${FUNNEL_TESTER_URL}. Start it with "npm run dev" in funnel-tester/backend.`);
  }
  if (res.status === 401) {
    throw new Error("The funnel tester rejected the API key. FUNNEL_TESTER_API_KEY must match on both sides.");
  }
  return res;
}
