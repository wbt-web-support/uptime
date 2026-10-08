import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/utils/supabase/server";
import { buildSummary, CHECKOUT_BUTTON, GTM_MISSING, summarizeWalk, type FinalActionLike, type WalkReport } from "@/utils/funnel-report";

// The funnel-tester backend (funnel-tester/backend) runs as its own always-on server:
// a walk drives a real browser for minutes, which does not fit a serverless function.
export const FUNNEL_TESTER_URL = (process.env.FUNNEL_TESTER_URL || "http://localhost:4000").replace(/\/$/, "");
// Must match FUNNEL_TESTER_API_KEY on the backend once it is set there
const FUNNEL_TESTER_API_KEY = process.env.FUNNEL_TESTER_API_KEY;
// Minimum gap before the same funnel can be tested again after a finished test
const RETEST_COOLDOWN_MINUTES = Number(process.env.FUNNEL_RETEST_COOLDOWN_MINUTES || 60);

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

// How many full reports to keep per funnel, kind and device: the latest test and
// the one before it. Saving a 3rd deletes the oldest, so the database stays small.
const REPORTS_KEPT = 2;

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
  // A funnel walk report is tens of KB (every step, log and API call). Keep a small
  // summary inside it so the Issues page can read just that via report->_summary.
  const withSummary =
    kind === "test" && report && typeof report === "object"
      ? { ...(report as object), _summary: summarizeWalk(report as WalkReport) }
      : report;
  // Postgres JSONB rejects the NUL character ("unsupported Unicode escape
  // sequence"). Sites' API responses copied into the report sometimes contain one,
  // which silently lost that device's whole report - drop them before saving.
  const stored = JSON.parse(JSON.stringify(withSummary).replace(/\\u0000/g, ""));

  // One retry: a dropped connection ("fetch failed") lost reports too
  let saved: { id: string } | null = null;
  for (let attempt = 1; attempt <= 2 && !saved; attempt++) {
    const { data, error } = await supabase
      .from("funnel_reports")
      .insert({ funnel_id: funnelId, kind, viewport, status, report: stored })
      .select("id")
      .single();
    if (data) saved = data;
    else if (attempt === 2 || !/fetch failed|network|timeout/i.test(error?.message ?? "")) {
      console.error("[funnel-tester] could not save report:", error?.message);
      return null;
    }
  }
  if (!saved) return null;

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

  return saved.id;
}

// ---------------------------------------------------------------------------
// Funnel test: AI walk through the funnel on desktop then mobile
// ---------------------------------------------------------------------------

interface ViewportResult {
  status: "passed" | "failed" | "error";
  failure: string | null;
  // The site's own request failing (e.g. its postcode lookup answering 403), which
  // is usually the real reason behind a "blocked" walk
  site_problem?: string | null;
  steps: number | null;
  tracking_ok: boolean | null;
  report_id: string | null;
  // Results-page buttons (Save quote, Checkout...) when they were tested: how many
  // worked, which didn't, and whether a (test) card payment went through
  results_buttons?: { ok: number; total: number; failed: string[]; payment: string } | null;
  // The walk reached an SMS-code screen - for the "SMS verified" stage
  otp_seen?: boolean;
  // Google Tag Manager was found on the quote form (on at least one step - a single
  // step can miss it while the page is busy); false = the site has no GTM
  gtm_found?: boolean | null;
}

// Accepts "desktop", "mobile" or both, as the funnel tester's own dashboard offers
export function parseViewports(raw: unknown): Viewport[] {
  if (!Array.isArray(raw) || raw.length === 0) return [...VIEWPORTS];
  const picked = VIEWPORTS.filter(v => raw.includes(v));
  return picked.length ? picked : [...VIEWPORTS];
}

// Kick off a walk (desktop first, then mobile) and mark the funnel as running.
// Each device submits the funnel's form for real, so each one creates a real lead.
// Every test starts on the client's homepage, as a real visitor would. For a funnel
// page such as /ashp-quote/ the walker is told to enter the site through the link to
// that page, so each service's funnel (boiler, heat pump, air con, solar...) is reached
// via its own button rather than whichever the walker would pick first.
async function testEntry(supabase: SupabaseClient, funnel: { url: string; domain_id?: string | null }) {
  const target = new URL(funnel.url);
  if (target.pathname.replace(/\/+$/, "") === "") return { startUrl: funnel.url, entryHint: undefined };

  let homepage = `${target.origin}/`;
  if (funnel.domain_id) {
    const { data: domain } = await supabase.from("domains").select("uptime_url").eq("id", funnel.domain_id).maybeSingle();
    // Only use the client's listed homepage if it's the same site as the funnel
    try {
      if (domain?.uptime_url && new URL(domain.uptime_url).hostname.replace(/^www\./, "") === target.hostname.replace(/^www\./, "")) {
        homepage = domain.uptime_url;
      }
    } catch {
      // keep the funnel's own origin
    }
  }
  return { startUrl: homepage, entryHint: funnel.url };
}

export async function startFunnelTest(
  supabase: SupabaseClient,
  funnel: { id: string; name: string; url: string; domain_id?: string | null },
  viewports: Viewport[] = [...VIEWPORTS],
  // After a successful submit, also click whichever results-page buttons the site
  // has (Save quote, Book installation, Checkout...) and complete their follow-up
  // forms. A results page without any is simply skipped. False stops at the submit.
  testResultsButtons = true,
  // A person pressing Run test on this one funnel and confirming "test again anyway"
  // skips the cool-down below; automatic and bulk tests never do
  ignoreCooldown = false
) {
  // Never two tests of one funnel at once, whoever starts them (page, auto-test,
  // script) - each one submits the form, so overlapping runs mean duplicate leads
  const { data: current } = await supabase
    .from("funnels")
    .select("test_status, test_finished_at")
    .eq("id", funnel.id)
    .maybeSingle();
  if (current?.test_status === "running") {
    throw new Error("A test is already running for this funnel");
  }
  // Cool-down after a finished test: re-testing the same funnel over and over asks
  // its site for SMS codes again and again, which gets test numbers blocked. A test
  // that was stopped or crashed (status "error") can be re-run straight away.
  if (!ignoreCooldown && (current?.test_status === "passed" || current?.test_status === "failed") && current.test_finished_at) {
    const readyAt = new Date(current.test_finished_at).getTime() + RETEST_COOLDOWN_MINUTES * 60_000;
    if (Date.now() < readyAt) {
      const mins = Math.ceil((readyAt - Date.now()) / 60_000);
      throw new Error(
        `This funnel was tested less than ${RETEST_COOLDOWN_MINUTES} minutes ago. To protect the test phone numbers from being blocked, it can be tested again in ${mins} minute${mins === 1 ? "" : "s"}.`
      );
    }
  }

  const { startUrl, entryHint } = await testEntry(supabase, funnel);
  const res = await funnelTesterFetch("/run-batch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      items: [{ url: startUrl, name: funnel.name, entryHint }],
      viewports,
      testFinalActions: testResultsButtons,
    }),
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
        result.site_problem = summarizeWalk(report).siteProblem ?? null;
        // Only the buttons on the results page itself count - not the steps inside
        // them (e.g. "Add" / "Next" within checkout). Checkout counts as working
        // when its test payment went through, whatever happened on the way.
        const buttons: FinalActionLike[] = Array.isArray(report.finalActions) ? report.finalActions : [];
        const payment = buildSummary(report).find(s => s.title === "Checkout payment")?.value ?? "No checkout";
        const worked = (b: FinalActionLike) =>
          (CHECKOUT_BUTTON.test(b.label) && payment === "Paid (test)") || (!b.error && !b.warning);
        if (buttons.length === 0 && result.status === "passed") {
          // Results page had none of these buttons - nothing to test, not a failure
          result.results_buttons = { ok: 0, total: 0, failed: [], payment: "No checkout" };
        } else if (buttons.length > 0) {
          result.results_buttons = {
            ok: buttons.filter(worked).length,
            total: buttons.length,
            failed: buttons.filter(b => !worked(b)).map(b => b.label).slice(0, 6),
            payment,
          };
        }
        result.steps = Array.isArray(report.steps) ? report.steps.length : null;
        // An "_otp" screenshot is taken on every SMS-code screen the walk handled
        result.otp_seen = Array.isArray(report.steps) && report.steps.some((s: any) => /_otp\.png$/.test(s?.screenshot ?? ""));
        result.tracking_ok = !!(report.gtmPresentThroughout || report.gtagPresentThroughout);
        result.gtm_found = Array.isArray(report.steps) && report.steps.length > 0
          ? report.steps.some((s: any) => s?.tracking?.gtmPresent === true)
          : null;
        result.report_id = await saveReport(supabase, funnelId, "test", viewport, result.status, report);
      }
    }
  }
  return result;
}

// What the page shows for each device while a walk runs
export interface LiveRun {
  status: "queued" | "running" | "completed" | "failed";
  messages: string[];
  latestScreenshot?: string;
}

// Ask the backend how a running test is going. While it runs, returns each device's
// live log and newest screenshot; once every device has finished, saves the outcome.
export async function syncFunnelTest(
  supabase: SupabaseClient,
  funnel: any
): Promise<{ funnel: any; message?: string; screenshot?: string; live?: Partial<Record<Viewport, LiveRun>> }> {
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
    // Only the devices chosen for this test have a run
    const tested = VIEWPORTS.filter(v => runs[v]);

    const active = tested.find(v => runs[v]?.status === "running" || runs[v]?.status === "queued");
    if (active && !batch.done) {
      const live: Partial<Record<Viewport, LiveRun>> = {};
      for (const v of tested) {
        live[v] = {
          status: runs[v].status,
          // The log grows by a few lines a second; the page only needs the recent part
          messages: (runs[v].messages || []).slice(-200),
          latestScreenshot: runs[v].latestScreenshot,
        };
      }
      const messages: string[] = runs[active]?.messages || [];
      return {
        funnel,
        message: `${deviceLabel(active)}: ${messages[messages.length - 1] || "Starting..."}`,
        screenshot: runs[active]?.latestScreenshot,
        live,
      };
    }

    const results: Partial<Record<Viewport, ViewportResult>> = {};
    for (const v of tested) results[v] = await readViewportResult(supabase, funnel.id, v, runs[v]);
    const all = tested.map(v => results[v]!);
    if (all.length === 0) all.push({ status: "error", failure: "No device was tested", steps: null, tracking_ok: null, report_id: null });

    // Overall result: passed only when both devices passed and the site has GTM
    const gtmMissing = tested.filter(v => results[v]!.gtm_found === false);
    const walked = all.some(r => r.status === "failed") ? "failed" : all.some(r => r.status === "error") ? "error" : "passed";
    const overall = walked === "passed" && gtmMissing.length > 0 ? "failed" : walked;
    const failures = tested
      .filter(v => results[v]!.failure)
      .map(v => `${deviceLabel(v)}: ${results[v]!.failure}`);
    for (const v of gtmMissing) failures.push(`${deviceLabel(v)}: ${GTM_MISSING}`);

    update = {
      test_status: overall,
      test_results: results,
      test_failure: failures.length ? failures.join(" | ") : null,
      test_steps: all[0].steps,
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

// Ask the backend to stop a running test and its UI check, then mark them stopped.
// Whatever the walker already submitted stays submitted.
export async function stopFunnelTest(supabase: SupabaseClient, funnel: any) {
  const runs: [string | null, string][] = [];
  if (funnel.test_status === "running" && funnel.test_run_id) runs.push([funnel.test_run_id, "/batch"]);
  if (funnel.ui_status === "running" && funnel.ui_run_id) runs.push([funnel.ui_run_id, "/check-ui-batch"]);

  for (const [runId, base] of runs) {
    const res = await funnelTesterFetch(`${base}/${encodeURIComponent(runId!)}/cancel`, { method: "POST" });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      // The backend's own "Unknown batchId": the run already finished or the tester
      // restarted, so there's nothing left to stop. Any other 404 means a backend
      // without the cancel endpoint - the run would carry on, so don't pretend.
      if (!(res.status === 404 && body.includes("Unknown batchId"))) {
        throw new Error(`Funnel tester could not stop the run (status ${res.status}) - is the backend up to date?`);
      }
    }
  }

  const stoppedAt = new Date().toISOString();
  const update: Record<string, unknown> = {};
  if (funnel.test_status === "running") {
    Object.assign(update, { test_status: "error", test_failure: "Stopped by user", test_finished_at: stoppedAt });
  }
  if (funnel.ui_status === "running") {
    Object.assign(update, { ui_status: "error", ui_results: null, ui_checked_at: stoppedAt });
  }
  if (Object.keys(update).length === 0) return funnel;

  const { data: updated, error } = await supabase
    .from("funnels")
    .update(update)
    .eq("id", funnel.id)
    .select()
    .single();
  if (error) throw error;
  return updated;
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
  // UK spelling / grammar mistakes in the page text; checked on desktop only
  grammar_issues?: GrammarIssue[] | null;
  error: string | null;
  report_id: string | null;
}

// One UK English mistake found on a page
export interface GrammarIssue {
  found: string;
  suggestion: string;
  reason: string;
}

// The UI check looks at the site's homepage, where visitors meet the quote buttons.
// Run on a quote page itself, its "Get a Quote" button only scrolls to the form
// already there, which the check misread as "does nothing".
export async function startUiCheck(
  supabase: SupabaseClient,
  funnel: { id: string; name: string; url: string; domain_id?: string | null }
) {
  const { startUrl } = await testEntry(supabase, funnel);
  const res = await funnelTesterFetch("/check-ui-batch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items: [{ url: startUrl, name: funnel.name }] }),
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

  // UK spelling / grammar mistakes in the page's text (desktop only, null on mobile)
  const grammarIssues: GrammarIssue[] | null = Array.isArray(run.grammarIssues) ? run.grammarIssues : null;

  const report = {
    screenshot: run.screenshot ?? null,
    uiIssues,
    quoteButtons,
    ctaCheck: run.ctaCheck ?? null,
    grammarIssues,
    messages: run.messages ?? [],
  };

  return {
    status,
    ui_issues: uiIssues,
    quote_buttons_found: quoteButtons.length,
    quote_buttons_working: working,
    cta,
    grammar_issues: grammarIssues,
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
