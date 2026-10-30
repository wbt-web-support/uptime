"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { createClient } from "@/utils/supabase/client";
import { Skeleton } from "@/components/ui/skeleton";
import { StageCell } from "@/components/FunnelStageMarks";
import { FunnelReportView } from "@/components/FunnelReportView";
import { AlertCircle, ArrowLeft, ChevronDown, ChevronUp, Clock, ExternalLink, Globe, Monitor, Play, RefreshCw, Smartphone, Square, X } from "lucide-react";
import { apiErrorMessage } from "@/utils/api-error";
import { deriveStages, explainFailure, GTM_MISSING, gtmMissing, OWNER_LABEL, STAGES, type ProblemOwner } from "@/utils/funnel-report";
import { isChooserFunnel } from "@/utils/funnel-discovery";
import type { HealthResult } from "@/utils/funnel-health";

// Everything about one website's funnel tests on one page: the landing page
// "Get a quote" check, then every funnel's stages on desktop and mobile and why any
// failed. Each step-by-step report opens right here, under the funnel it belongs to.

type Device = "desktop" | "mobile";
const DEVICES: Device[] = ["desktop", "mobile"];
const DEVICE_LABEL: Record<Device, string> = { desktop: "Desktop", mobile: "Mobile" };
const DEVICE_ICON = { desktop: Monitor, mobile: Smartphone };
// A landing page check younger than this is reused by Run test, not repeated
const LANDING_CHECK_REUSE_MIN = 60;

interface DeviceResult {
  status: "passed" | "failed" | "error";
  failure: string | null;
  steps: number | null;
  tracking_ok: boolean | null;
  report_id?: string | null;
  site_problem?: string | null;
  results_buttons?: { ok: number; total: number; failed: string[]; payment: string; payment_note?: string | null; list?: { label: string; ok: boolean; note: string }[] } | null;
  otp_seen?: boolean;
  email_note?: string | null;
  gtm_found?: boolean | null;
}

// One past test, as saved by utils/funnel-tester.ts (kind "history")
interface HistoryEntry {
  started_at: string | null;
  finished_at: string;
  result: "working" | "not_working" | "error";
  reason: string | null;
}

// The last tests of a funnel as a row of dots, oldest left, plus when it broke
function HistoryStrip({ entries }: { entries: HistoryEntry[] }) {
  if (entries.length === 0) return null;
  const newestFirst = entries;
  const latest = newestFirst[0];
  const lastWorkedIndex = newestFirst.findIndex(e => e.result === "working");
  const lastWorked = lastWorkedIndex >= 0 ? newestFirst[lastWorkedIndex] : null;
  // When it broke: the oldest of the failed tests since it last worked
  const brokeAt = latest.result !== "working"
    ? newestFirst[(lastWorkedIndex >= 0 ? lastWorkedIndex : newestFirst.length) - 1]
    : null;
  const dot = { working: "bg-green-500", not_working: "bg-red-500", error: "bg-gray-400" };
  const label = { working: "Working", not_working: "Not working", error: "Didn't finish" };
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-2.5 text-xs text-muted-foreground">
      <span className="font-medium text-foreground">Last {entries.length} test{entries.length === 1 ? "" : "s"}</span>
      <span className="flex items-center gap-1" aria-label="Test history, oldest first">
        {[...newestFirst].reverse().map((e, i) => (
          <span
            key={i}
            className={`h-3 w-3 rounded-full ${dot[e.result]}`}
            title={`${new Date(e.finished_at).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} - ${label[e.result]}${e.reason ? `: ${e.reason}` : ""}`}
          />
        ))}
      </span>
      {latest.result !== "working" && (
        <span>
          {brokeAt && <>Not working since <span className="font-medium text-foreground">{shortDate(brokeAt.finished_at)}</span></>}
          {lastWorked ? <> · last worked {shortDate(lastWorked.finished_at)}</> : entries.length > 1 ? <> · hasn&apos;t worked in any of these tests</> : null}
        </span>
      )}
    </div>
  );
}

interface UiResult {
  status: "ok" | "issues" | "error";
  ui_issues: string[];
  quote_buttons_found: number;
  quote_buttons_working: number;
  // Each button clicked and what it did; missing on older checks
  quote_buttons?: { label: string; position: string | null; works: boolean; outcome: string }[];
  // UK spelling / grammar mistakes in the page text; desktop only, missing on older checks
  grammar_issues?: { found: string; suggestion: string; reason: string; status?: "fix" | "fixed" }[] | null;
  // Where the quote buttons were checked: the homepage, or a service page when it had none
  landing_url?: string | null;
  // Checked as well as the homepage, when none of the homepage's buttons led to the funnel
  also_checked_url?: string | null;
  error: string | null;
  report_id: string | null;
}

interface Funnel {
  id: string;
  name: string;
  url: string;
  domain_id: string | null;
  test_status: "running" | "passed" | "failed" | "error" | null;
  test_failure: string | null;
  test_started_at: string | null;
  test_finished_at: string | null;
  test_results: Partial<Record<Device, DeviceResult>> | null;
  ui_results: Partial<Record<Device, UiResult>> | null;
  ui_checked_at: string | null;
  // false = switched off: never tested. Missing until the test_enabled migration has been run.
  test_enabled?: boolean | null;
}

// Whose problem a failure is, as a coloured tag
const OWNER_BADGE: Record<ProblemOwner, string> = {
  website: "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300",
  tester: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  setup: "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300",
  unclear: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
  stopped: "bg-muted text-muted-foreground",
};

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return url;
  }
};
const isHomepage = (url: string) => {
  try {
    return new URL(url).pathname.replace(/\/+$/, "") === "";
  } catch {
    return false;
  }
};
const serviceLabel = (f: Funnel) =>
  isHomepage(f.url) ? "Landing page funnel" : f.name.includes(" - ") ? f.name.split(" - ").slice(1).join(" - ") : f.name;
// " · took 6m 40s" for a funnel's last test (both devices), or nothing
const tookText = (f: { test_started_at: string | null; test_finished_at: string | null }) => {
  if (!f.test_started_at || !f.test_finished_at) return "";
  const s = Math.round((new Date(f.test_finished_at).getTime() - new Date(f.test_started_at).getTime()) / 1000);
  if (s <= 0 || s > 3 * 3600) return "";
  return ` · took ${s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`}`;
};
const shortDate = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

function Badge({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
        ok ? "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-400" : "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400"
      }`}
    >
      {children}
    </span>
  );
}

// "Show report" toggle on a device card
function ReportToggle({ open, onClick, label }: { open: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
        open ? "border-brand bg-brand text-white" : "hover:bg-muted"
      }`}
    >
      {open ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
      {open ? "Hide report" : label}
    </button>
  );
}

// The report opened from a card, full width under the cards
function InlineReport({ id, title, onClose }: { id: string; title: string; onClose: () => void }) {
  return (
    <div className="mt-3 rounded-lg border bg-muted/20 p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-sm font-semibold">{title}</span>
        <button type="button" onClick={onClose} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground" title="Close">
          <X className="h-4 w-4" />
        </button>
      </div>
      <FunnelReportView id={id} />
    </div>
  );
}

// The latest daily no-submit check of a funnel: each check as a tick or a warning,
// with what's wrong spelled out under it
function HealthLine({ result }: { result: HealthResult | undefined }) {
  if (!result) return null;
  if ("error" in result) {
    return <p className="border-b px-4 py-2 text-xs text-muted-foreground">Daily check couldn&apos;t run: {(result as { error: string }).error}</p>;
  }
  const shown = result.checks.filter(c => c.status !== "skipped");
  const problems = shown.filter(c => c.status === "problem");
  return (
    <div className="border-b px-4 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium text-foreground">Daily check</span>
        <span className="text-muted-foreground">{shortDate(result.checked_at)} · nothing submitted</span>
        {shown.map(c => (
          <span key={c.key} className={c.status === "ok" ? "text-muted-foreground" : "font-medium text-amber-700 dark:text-amber-400"}>
            {c.status === "ok" ? "✅" : "⚠️"} {c.label}
          </span>
        ))}
      </div>
      {problems.map(c => (
        <p key={c.key} className="mt-1 text-amber-700 dark:text-amber-400">
          <span className="font-medium">{c.label}:</span> {c.detail}
        </p>
      ))}
    </div>
  );
}

export default function SiteReportPage() {
  const params = useParams<{ host: string }>();
  const host = decodeURIComponent(params.host ?? "").toLowerCase();
  const supabase = useMemo(() => createClient(), []);
  const [funnels, setFunnels] = useState<Funnel[] | null>(null);
  const [history, setHistory] = useState<Record<string, HistoryEntry[]>>({});
  // Latest daily no-submit check per funnel
  const [health, setHealth] = useState<Record<string, HealthResult>>({});
  const [checkingHealth, setCheckingHealth] = useState(false);
  // Button lists of older landing page checks, by report id (see load)
  const [oldQuoteButtons, setOldQuoteButtons] = useState<Record<string, NonNullable<UiResult["quote_buttons"]>>>({});
  const [clientName, setClientName] = useState<string | null>(null);
  const [error, setError] = useState("");
  // A switch that couldn't be saved (e.g. the test_enabled column is missing)
  const [saveError, setSaveError] = useState("");
  // The one report open on the page: "<funnel id or landing>:<device>"
  const [openReport, setOpenReport] = useState<string | null>(null);
  const toggleReport = (key: string) => setOpenReport(prev => (prev === key ? null : key));

  // Switch a funnel on or off for testing (Run test, Test all, automatic tests)
  const setTestEnabled = async (f: Funnel, enabled: boolean) => {
    setSaveError("");
    setFunnels(prev => prev?.map(x => (x.id === f.id ? { ...x, test_enabled: enabled } : x)) ?? prev);
    const { error: updateError } = await supabase.from("funnels").update({ test_enabled: enabled }).eq("id", f.id);
    if (updateError) {
      setFunnels(prev => prev?.map(x => (x.id === f.id ? { ...x, test_enabled: f.test_enabled } : x)) ?? prev);
      setSaveError(
        /test_enabled/.test(updateError.message)
          ? "Couldn't save: the database needs one new column first. Run migrations/add_funnel_test_enabled.sql in Supabase's SQL Editor, then try again."
          : `Couldn't save: ${updateError.message}`
      );
    }
  };

  // Mark one spelling/grammar mistake as fixed (or back to "to fix"); saved on the
  // funnel whose landing page check it came from
  const setGrammarStatus = async (f: Funnel, index: number, status: "fix" | "fixed") => {
    setSaveError("");
    const issues = f.ui_results?.desktop?.grammar_issues;
    if (!f.ui_results?.desktop || !Array.isArray(issues)) return;
    const uiResults = {
      ...f.ui_results,
      desktop: { ...f.ui_results.desktop, grammar_issues: issues.map((g, i) => (i === index ? { ...g, status } : g)) },
    };
    setFunnels(prev => prev?.map(x => (x.id === f.id ? { ...x, ui_results: uiResults } : x)) ?? prev);
    const { error: updateError } = await supabase.from("funnels").update({ ui_results: uiResults }).eq("id", f.id);
    if (updateError) {
      setFunnels(prev => prev?.map(x => (x.id === f.id ? { ...x, ui_results: f.ui_results } : x)) ?? prev);
      setSaveError(`Couldn't save: ${updateError.message}`);
    }
  };

  // Run the daily no-submit check now on this website's quote funnels (nothing is
  // filled in or sent), then show the results
  const runHealthCheck = async () => {
    const quotePages = (funnels ?? []).filter(f => f.test_enabled !== false && new URL(f.url).pathname.replace(/\/+$/, "") !== "");
    if (quotePages.length === 0) return;
    setCheckingHealth(true);
    setSaveError("");
    try {
      const res = await fetch("/api/funnels/health-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ funnelIds: quotePages.map(f => f.id) }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "The daily check couldn't run");
      setHealth(prev => ({ ...prev, ...body.results }));
    } catch (err: any) {
      setSaveError(err.message);
    } finally {
      setCheckingHealth(false);
    }
  };

  // Everything on the page, from the database; run again when a test finishes so
  // its result and the history dots show up
  const load = useCallback(async () => {
    const { data, error: loadError } = await supabase
      .from("funnels")
      .select("*")
      .order("name", { ascending: true });
    if (loadError) {
      setError(apiErrorMessage(loadError));
      return;
    }
    const site = (data as Funnel[]).filter(f => hostOf(f.url) === host);
    setFunnels(site);
    // Last tests of each funnel (small summaries, newest first)
    if (site.length > 0) {
      const { data: rows } = await supabase
        .from("funnel_reports")
        .select("funnel_id, report")
        .eq("kind", "history")
        .in("funnel_id", site.map(f => f.id))
        .order("created_at", { ascending: false })
        .limit(site.length * 30);
      const byFunnel: Record<string, HistoryEntry[]> = {};
      for (const r of rows ?? []) (byFunnel[r.funnel_id] ??= []).push(r.report as HistoryEntry);
      setHistory(byFunnel);
      const { data: healthRows } = await supabase
        .from("funnel_reports")
        .select("funnel_id, report")
        .eq("kind", "health")
        .in("funnel_id", site.map(f => f.id))
        .order("created_at", { ascending: false })
        .limit(site.length * 3);
      const latest: Record<string, HealthResult> = {};
      for (const r of healthRows ?? []) latest[r.funnel_id] ??= r.report as HealthResult;
      setHealth(latest);
      // Landing page checks from before the button list was saved on the funnel:
      // read the list from their saved report instead
      const oldReportIds = site
        .flatMap(f => DEVICES.map(d => f.ui_results?.[d]))
        .filter((u): u is UiResult => !!u && !u.quote_buttons && !!u.report_id)
        .map(u => u.report_id!);
      if (oldReportIds.length > 0) {
        const { data: uiRows } = await supabase.from("funnel_reports").select("id, report").in("id", oldReportIds);
        const lists: Record<string, NonNullable<UiResult["quote_buttons"]>> = {};
        for (const row of uiRows ?? []) {
          const buttons = (row.report as { quoteButtons?: any[] } | null)?.quoteButtons;
          if (Array.isArray(buttons)) {
            lists[row.id] = buttons.map(b => ({
              label: String(b.label ?? "").trim(),
              position: b.position ?? null,
              works: !!b.works,
              outcome: String(b.outcome ?? ""),
            }));
          }
        }
        setOldQuoteButtons(lists);
      }
    }
    const domainId = site.find(f => f.domain_id)?.domain_id;
    if (domainId) {
      const { data: d } = await supabase.from("domains").select("display_name, domain_name").eq("id", domainId).maybeSingle();
      if (d) setClientName(d.display_name || d.domain_name);
    }
  }, [supabase, host]);

  useEffect(() => {
    load();
  }, [load]);

  // Run one funnel again from here - both devices, or just the one that failed.
  // Each device fills in and sends the form for real, so it asks first.
  const [testMessages, setTestMessages] = useState<Record<string, string>>({});
  const [stopping, setStopping] = useState<string | null>(null);
  // The funnel whose landing page "Get a quote" buttons are being checked before its test
  const [uiChecking, setUiChecking] = useState<string | null>(null);
  const stoppedRef = useRef(false);

  // A status check can fail on its own now and then (a dropped connection to the
  // database) while the test carries on fine - only say so after a few in a row
  const failedPolls = useRef(0);
  const pollFailed = (err: unknown) => {
    failedPolls.current++;
    if (failedPolls.current >= 3) setSaveError(apiErrorMessage(err));
  };
  const pollWorked = () => {
    failedPolls.current = 0;
  };

  // Click every "Get a quote" button on the landing page, desktop and mobile
  // (nothing is filled in or sent), and wait for it to finish. False when stopped.
  const checkLandingPage = async (f: Funnel): Promise<boolean> => {
    const res = await fetch("/api/funnels/ui-check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ funnelId: f.id }),
    });
    // 409 = a check is already running for this funnel: wait for that one
    if (!res.ok && res.status !== 409) {
      const body = await res.json().catch(() => ({}));
      throw new Error(res.status === 401 ? "Your session has expired. Please sign in again." : body.error);
    }
    while (!stoppedRef.current) {
      await new Promise(r => setTimeout(r, 5000));
      try {
        const statusRes = await fetch(`/api/funnels/ui-check/status?funnelId=${encodeURIComponent(f.id)}`);
        const body = await statusRes.json();
        if (!statusRes.ok) throw new Error(statusRes.status === 401 ? "Your session has expired. Please sign in again." : body.error);
        pollWorked();
        if (body.funnel.ui_status !== "running") return true;
        if (body.message) setTestMessages(prev => ({ ...prev, [f.id]: `Landing page: ${body.message}` }));
      } catch (err) {
        pollFailed(err);
      }
    }
    return false;
  };

  const startTest = async (f: Funnel, devices: Device[]) => {
    setSaveError("");
    // One test at a time across every website: the two test phone numbers are shared,
    // so two tests at once could read each other's SMS codes
    const { data: running, error: runningError } = await supabase.from("funnels").select("name").eq("test_status", "running").limit(1);
    if (runningError) {
      setSaveError(apiErrorMessage(runningError));
      return;
    }
    if (running && running.length > 0) {
      setSaveError(`"${running[0].name}" is being tested right now. One test runs at a time (the test phone numbers are shared) - wait for it to finish, then press Run test again.`);
      return;
    }
    const where = devices.length === 2 ? "on desktop and then mobile" : `on ${devices[0]} only`;
    const leads = `${devices.length} real lead${devices.length === 1 ? "" : "s"}`;
    const last = f.test_finished_at ? `\n\nLast tested ${shortDate(f.test_finished_at)}.` : "";
    if (
      !window.confirm(
        `Test "${serviceLabel(f)}" ${where}?\n\n1. Every "Get a quote" button on the landing page is clicked, on desktop and mobile (nothing is sent) - skipped if it was checked in the last ${LANDING_CHECK_REUSE_MIN} minutes.\n2. Then the form is filled in and sent for real - ${leads} on the client's site, plus any thank-you page forms (Save quote, Book...).${last}`
      )
    )
      return;
    stoppedRef.current = false;
    failedPolls.current = 0;
    try {
      // Each funnel's landing check clicks only its own quote buttons, so this
      // funnel's check from the last hour that worked is kept rather than clicking
      // them all again (each check is many visits, and too many in a row trip some
      // sites' firewalls)
      const recentCheck =
        !!f.ui_checked_at &&
        Date.now() - new Date(f.ui_checked_at).getTime() < LANDING_CHECK_REUSE_MIN * 60_000 &&
        DEVICES.every(d => f.ui_results?.[d] && !f.ui_results[d]!.error);
      let finished = true;
      if (!recentCheck) {
        setUiChecking(f.id);
        setTestMessages(prev => ({ ...prev, [f.id]: "Checking every \"Get a quote\" button on the landing page (desktop and mobile)..." }));
        try {
          finished = await checkLandingPage(f);
        } catch (err) {
          // The landing page check is extra: if it can't run, the funnel test still does
          setSaveError(`Couldn't check the landing page buttons (${apiErrorMessage(err)}) - testing the funnel anyway.`);
        }
        setUiChecking(null);
        await load();
      }
      if (!finished) return;
      const res = await fetch("/api/funnels/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ funnelId: f.id, viewports: devices, withUiCheck: false, ignoreCooldown: true }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(res.status === 401 ? "Your session has expired. Please sign in again." : body.error);
      setFunnels(prev => prev?.map(x => (x.id === f.id ? { ...x, test_status: "running", test_started_at: body.started_at } : x)) ?? prev);
      setTestMessages(prev => ({ ...prev, [f.id]: "Starting..." }));
    } catch (err: any) {
      setSaveError(apiErrorMessage(err));
    } finally {
      setUiChecking(null);
    }
  };

  const stopTest = async (f: Funnel) => {
    if (!window.confirm(`Stop the test on "${serviceLabel(f)}"?\n\nIt stops after the step it's on. Anything already sent stays sent. If an SMS code is on its way, it's entered first so it isn't wasted.`)) return;
    stoppedRef.current = true;
    setStopping(f.id);
    try {
      const res = await fetch("/api/funnels/test/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ funnelId: f.id }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(res.status === 401 ? "Your session has expired. Please sign in again." : body.error);
      await load();
    } catch (err: any) {
      setSaveError(apiErrorMessage(err));
    } finally {
      setStopping(null);
    }
  };

  // Follow every test running on this website until it ends
  const runningIds = (funnels ?? []).filter(f => f.test_status === "running").map(f => f.id).join(",");
  useEffect(() => {
    if (!runningIds) return;
    let cancelled = false;
    const poll = async () => {
      for (const id of runningIds.split(",")) {
        try {
          const res = await fetch(`/api/funnels/test/status?funnelId=${encodeURIComponent(id)}`);
          const body = await res.json();
          if (!res.ok) throw new Error(res.status === 401 ? "Your session has expired. Please sign in again." : body.error);
          if (cancelled) return;
          pollWorked();
          if (body.funnel.test_status === "running") {
            if (body.message) setTestMessages(prev => ({ ...prev, [id]: body.message }));
          } else {
            setTestMessages(prev => {
              const { [id]: _, ...rest } = prev;
              return rest;
            });
            await load();
          }
        } catch (err: any) {
          if (!cancelled) pollFailed(err);
        }
      }
    };
    poll();
    const timer = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [runningIds, load]);

  const backLink = (
    <Link href="/funnel-test" className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
      <ArrowLeft className="h-4 w-4" /> Funnel Test
    </Link>
  );

  if (error) {
    return (
      <div className="mx-auto w-full max-w-5xl px-4 py-8">
        {backLink}
        <div className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-400">
          <AlertCircle className="h-4 w-4" /> Could not load this website: {error}
        </div>
      </div>
    );
  }
  if (!funnels) {
    return (
      <div className="mx-auto w-full max-w-5xl space-y-3 px-4 py-8">
        {backLink}
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (funnels.length === 0) {
    return (
      <div className="mx-auto w-full max-w-5xl px-4 py-8">
        {backLink}
        <p className="text-sm text-muted-foreground">No funnels found for {host}.</p>
      </div>
    );
  }

  const home = funnels.find(f => isHomepage(f.url));
  const siteName = home?.name ?? clientName ?? funnels[0].name.split(" - ")[0] ?? host;
  // Same rule as the list: the bare homepage is only tested when there's nothing more specific
  const specific = funnels.filter(f => !isHomepage(f.url) && !isChooserFunnel(f));
  const listed = specific.length > 0 ? specific : funnels.filter(f => !isChooserFunnel(f));
  // Switched-off funnels stay listed (so they can be switched back on) but don't count
  const tested = listed.filter(f => f.test_enabled !== false);
  // The landing page check is saved on whichever funnel ran it most recently
  const uiSource = funnels.filter(f => f.ui_results).sort((a, b) => (b.ui_checked_at ?? "").localeCompare(a.ui_checked_at ?? ""))[0];
  const lastTested = tested.map(f => f.test_finished_at).filter((d): d is string => !!d).sort().pop();
  // Working only when every stage on every device worked (incl. Save quote and
  // Checkout on the thank-you page); a form that went through but has a broken
  // thank-you page button counts as not working
  const anyStageFailed = (f: Funnel) =>
    DEVICES.some(d => {
      const r = f.test_results?.[d];
      // (A missing Google Tag Manager is shown below each device, not counted here)
      return !!r && Object.values(deriveStages(r)).includes("failed");
    });
  const failing = tested.filter(f => f.test_status === "failed" || f.test_status === "error" || (f.test_status === "passed" && anyStageFailed(f))).length;
  const passing = tested.filter(f => f.test_status === "passed" && !anyStageFailed(f)).length;

  const funnelStatus = (f: Funnel) =>
    f.test_enabled === false
      ? { text: "Switched off", cls: "bg-gray-100 text-gray-800 dark:bg-muted dark:text-muted-foreground" }
      : f.test_status === "running"
      ? { text: "Testing now…", cls: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300" }
      : f.test_status === "passed" && !anyStageFailed(f)
        ? { text: "Working", cls: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300" }
        : f.test_status === "failed" || f.test_status === "error" || (f.test_status === "passed" && anyStageFailed(f))
          ? { text: "Not working", cls: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300" }
          : { text: "Not tested yet", cls: "bg-gray-100 text-gray-800 dark:bg-muted dark:text-muted-foreground" };

  const th = "px-4 py-3 text-left font-medium";
  const thCenter = "px-2 py-3 text-center font-medium";

  return (
    <div className="container mx-auto px-4 py-10">
      {backLink}

      {/* Header: the website, and how it's doing overall */}
      <div className="mb-10 flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <h1 className="text-3xl font-bold text-foreground">{siteName}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
            <a
              href={home?.url ?? `https://${host}/`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 hover:text-brand"
            >
              <Globe className="h-4 w-4" /> {host} <ExternalLink className="h-3 w-3" />
            </a>
            {clientName ? (
              <span>Client: {clientName}</span>
            ) : (
              <span className="rounded-full bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-800 dark:bg-violet-950 dark:text-violet-300">
                Added manually
              </span>
            )}
            {lastTested && (
              <span className="inline-flex items-center gap-1">
                <Clock className="h-4 w-4" /> Last tested {shortDate(lastTested)}
              </span>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-start gap-3">
          <button
            onClick={runHealthCheck}
            disabled={checkingHealth}
            title="Opens each quote page and checks it without filling in or sending anything: page, quote form, GTM, postcode lookup, Stripe key, phone links"
            className="inline-flex h-9 items-center gap-1.5 self-center rounded-md border px-3 text-sm font-medium hover:bg-muted disabled:opacity-60"
          >
            <RefreshCw className={`h-4 w-4 ${checkingHealth ? "animate-spin" : ""}`} />
            {checkingHealth ? "Checking… (about 30s per funnel)" : "Daily check now"}
          </button>
          {[
            { label: "Working", value: passing, cls: "text-green-600 dark:text-green-400" },
            { label: "Not working", value: failing, cls: "text-red-600 dark:text-red-400" },
            { label: `Funnel${tested.length === 1 ? "" : "s"}`, value: tested.length, cls: "text-foreground" },
          ].map(s => (
            <div key={s.label} className="min-w-[96px] rounded-lg border px-4 py-3 text-center">
              <div className={`text-2xl font-bold ${s.cls}`}>{s.value}</div>
              <div className="text-xs text-muted-foreground">{s.label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* 1. Landing page: every "Get a quote" button clicked */}
      <section className="mb-10">
        <h2 className="text-lg font-semibold">Landing page</h2>
        <p className="mb-3 text-sm text-muted-foreground">
          The homepage&apos;s &quot;Get a quote&quot; buttons for the funnel being tested are clicked to check they lead somewhere
          (other services&apos; buttons are checked when those funnels are tested). Nothing is submitted.
          {uiSource && !isHomepage(uiSource.url) && (
            <>
              {" "}Last checked for <span className="font-medium text-foreground">{serviceLabel(uiSource)}</span>
              {uiSource.ui_checked_at && <> ({shortDate(uiSource.ui_checked_at)})</>}.
            </>
          )}
          {(() => {
            // The homepage had none, so the funnel's service page was checked instead
            const checked = uiSource?.ui_results?.desktop?.landing_url ?? uiSource?.ui_results?.mobile?.landing_url;
            const path = checked ? new URL(checked).pathname : "/";
            const also = uiSource?.ui_results?.desktop?.also_checked_url ?? uiSource?.ui_results?.mobile?.also_checked_url;
            if (also) {
              return (
                <>
                  {" "}The buttons on{" "}
                  <a href={also} target="_blank" rel="noopener noreferrer" className="font-medium text-foreground hover:text-brand">
                    {new URL(also).pathname}
                  </a>
                  , the landing page that leads to this funnel, were checked too.
                </>
              );
            }
            return path.replace(/\/+$/, "") !== "" ? (
              <>
                {" "}This website has no quote buttons on its homepage, so they were checked on{" "}
                <a href={checked!} target="_blank" rel="noopener noreferrer" className="font-medium text-foreground hover:text-brand">
                  {path}
                </a>
                .
              </>
            ) : null;
          })()}
        </p>
        {!uiSource ? (
          <p className="rounded-lg border p-4 text-sm text-muted-foreground">Not checked yet - it runs at the start of every test (Run test below).</p>
        ) : (
          <>
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-muted/50">
                    <th className={th}>Device</th>
                    <th className={th}>&quot;Get a quote&quot; buttons</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {DEVICES.map(d => {
                    const ui = uiSource.ui_results?.[d];
                    const Icon = DEVICE_ICON[d];
                    const allWork = !!ui && !ui.error && ui.quote_buttons_found > 0 && ui.quote_buttons_working === ui.quote_buttons_found;
                    return (
                      <tr key={d} className="align-top">
                        <td className="px-4 py-4">
                          <span className="inline-flex items-center gap-2 font-medium">
                            <Icon className="h-4 w-4 text-muted-foreground" /> {DEVICE_LABEL[d]}
                          </span>
                        </td>
                        <td className="px-4 py-4">
                          {!ui ? (
                            <span className="text-muted-foreground">Not checked</span>
                          ) : ui.error ? (
                            <span className="text-red-700 dark:text-red-400">{explainFailure(ui.error)?.title ?? ui.error}</span>
                          ) : (
                            <span
                              className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                                allWork
                                  ? "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300"
                                  : "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300"
                              }`}
                            >
                              {ui.quote_buttons_found === 0
                                ? "No quote buttons found"
                                : `${ui.quote_buttons_working} of ${ui.quote_buttons_found} work`}
                            </span>
                          )}
                          {(() => {
                            const list = ui && !ui.error ? ui.quote_buttons ?? (ui.report_id ? oldQuoteButtons[ui.report_id] : undefined) : undefined;
                            return list && list.length > 0 ? (
                            <ul className="mt-2 space-y-0.5 text-xs">
                              {list.map((b, i) => (
                                <li key={i} className={b.works ? "text-muted-foreground" : "text-amber-700 dark:text-amber-400"}>
                                  {b.works ? "✅" : "⚠️"} <span className="font-medium">{b.label || "(no text)"}</span>
                                  {b.position && <span> ({b.position})</span>}: {b.outcome}
                                </li>
                              ))}
                            </ul>
                            ) : null;
                          })()}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* UK spelling & grammar on the landing page (checked on desktop - same words on mobile) */}
            {(() => {
              const grammar = uiSource.ui_results?.desktop?.grammar_issues;
              const toFix = Array.isArray(grammar) ? grammar.filter(g => g.status !== "fixed").length : 0;
              return (
                <div className="mt-4">
                  <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
                    Spelling &amp; grammar (UK)
                    {Array.isArray(grammar) && (
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                          toFix === 0
                            ? "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300"
                            : "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300"
                        }`}
                      >
                        {grammar.length === 0 ? "No mistakes found" : toFix === 0 ? "All fixed" : `${toFix} to fix`}
                      </span>
                    )}
                  </h3>
                  {!Array.isArray(grammar) ? (
                    <p className="text-sm text-muted-foreground">Not checked yet - it runs with the next test.</p>
                  ) : grammar.length > 0 ? (
                    <div className="overflow-x-auto rounded-lg border">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="bg-muted/50">
                            <th className={th}>Found on the page</th>
                            <th className={th}>Should be</th>
                            <th className={th}>Why</th>
                            <th className={th}>Status</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                          {grammar.map((g, i) => {
                            const fixed = g.status === "fixed";
                            return (
                              <tr key={i} className={`align-top ${fixed ? "opacity-60" : ""}`}>
                                <td className={`px-4 py-3 ${fixed ? "text-muted-foreground line-through" : "text-red-700 dark:text-red-400"}`}>&ldquo;{g.found}&rdquo;</td>
                                <td className="px-4 py-3 text-green-700 dark:text-green-400">&ldquo;{g.suggestion}&rdquo;</td>
                                <td className="px-4 py-3 text-muted-foreground">{g.reason}</td>
                                <td className="px-4 py-3">
                                  <select
                                    value={fixed ? "fixed" : "fix"}
                                    onChange={e => setGrammarStatus(uiSource, i, e.target.value as "fix" | "fixed")}
                                    aria-label={`Status of "${g.found}"`}
                                    className={`rounded-md border bg-background px-2 py-1 text-xs font-medium ${
                                      fixed ? "text-green-700 dark:text-green-400" : "text-amber-700 dark:text-amber-400"
                                    }`}
                                  >
                                    <option value="fix">To fix</option>
                                    <option value="fixed">Fixed</option>
                                  </select>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  ) : null}
                </div>
              );
            })()}
          </>
        )}
      </section>

      {/* 2. Every funnel: each device's stages, what happened, how to fix it */}
      <section>
        <h2 className="text-lg font-semibold">Quote funnels</h2>
        <p className="mb-3 text-sm text-muted-foreground">
          Each funnel is entered from the homepage, filled in and submitted - first on desktop, then on mobile. The thank-you
          page includes its Save quote and Checkout buttons. Untick <span className="font-medium text-foreground">Include in tests</span> to
          stop testing a funnel.
        </p>
        {saveError && (
          <div className="mb-3 flex items-center gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-400">
            <AlertCircle className="h-4 w-4 shrink-0" /> {saveError}
          </div>
        )}
        <div className="space-y-6">
          {listed.map(f => {
            const status = funnelStatus(f);
            const on = f.test_enabled !== false;
            return (
              <div key={f.id} className={`overflow-hidden rounded-lg border ${on ? "" : "opacity-60"}`}>
                <div className="flex flex-wrap items-center justify-between gap-3 bg-muted/40 px-4 py-3">
                  <div className="flex flex-wrap items-center gap-3">
                    <h3 className="text-base font-semibold">{serviceLabel(f)}</h3>
                    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${status.cls}`}>{status.text}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
                    {f.test_status === "running" || uiChecking === f.id ? (
                      <button
                        type="button"
                        onClick={() => stopTest(f)}
                        disabled={stopping === f.id}
                        className="inline-flex items-center gap-1 whitespace-nowrap rounded-md border px-2.5 py-1 text-xs font-medium text-red-600 transition-colors hover:bg-muted disabled:opacity-50"
                        title="Stop this test"
                      >
                        <Square className="h-3.5 w-3.5" /> {stopping === f.id ? "Stopping…" : "Stop"}
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => startTest(f, DEVICES)}
                        disabled={!on || uiChecking !== null}
                        className="inline-flex items-center gap-1 whitespace-nowrap rounded-md border px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
                        title={on ? "Test this funnel again: desktop, then mobile" : "Tick Include in tests to test this funnel"}
                      >
                        <Play className="h-3.5 w-3.5" /> Run test
                      </button>
                    )}
                    <label
                      className="inline-flex cursor-pointer items-center gap-1.5 font-medium text-foreground"
                      title={on ? "Untick to stop testing this funnel" : "Tick to test this funnel again"}
                    >
                      <input
                        type="checkbox"
                        id={`include-${f.id}`}
                        checked={on}
                        disabled={f.test_status === "running"}
                        onChange={e => setTestEnabled(f, e.target.checked)}
                        className="h-4 w-4 accent-brand"
                      />
                      Include in tests
                    </label>
                    {f.test_finished_at && (
                      <span className="inline-flex items-center gap-1">
                        <Clock className="h-3.5 w-3.5" /> {shortDate(f.test_finished_at)}
                        {tookText(f)}
                      </span>
                    )}
                    <a href={f.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:text-brand">
                      Open page <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>
                </div>

                <HistoryStrip entries={history[f.id] ?? []} />
                <HealthLine result={health[f.id]} />

                {f.test_status === "running" || uiChecking === f.id ? (
                  <div className="px-4 py-4 text-sm text-blue-700 dark:text-blue-300">
                    {uiChecking === f.id ? "Checking the landing page first…" : "Testing right now…"}
                    {testMessages[f.id] && <p className="mt-1 truncate text-xs" title={testMessages[f.id]}>{testMessages[f.id]}</p>}
                  </div>
                ) : !f.test_results ? (
                  <p className="px-4 py-4 text-sm text-muted-foreground">
                    {f.test_failure ? explainFailure(f.test_failure)?.title ?? f.test_failure : "Not tested yet."}
                  </p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b">
                          <th className={th}>Device</th>
                          {STAGES.map(s => (
                            <th key={s.key} className={thCenter} title={s.label}>
                              {s.short}
                            </th>
                          ))}
                          <th className={th}>What happened</th>
                          <th className={`${th} text-right`}>Report</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {DEVICES.map(d => {
                          const r = f.test_results?.[d];
                          const Icon = DEVICE_ICON[d];
                          const key = `${f.id}:${d}`;
                          const stages = r ? deriveStages(r) : null;
                          const why = r && r.status !== "passed" ? explainFailure(r.failure, r.site_problem) : null;
                          const buttons = r?.results_buttons;
                          return (
                            <tr key={d} className="align-top">
                              <td className="px-4 py-4">
                                <span className="inline-flex items-center gap-2 font-medium">
                                  <Icon className="h-4 w-4 text-muted-foreground" /> {DEVICE_LABEL[d]}
                                </span>
                              </td>
                              {STAGES.map(s => (
                                <td key={s.key} className="px-2 py-4 text-center">
                                  <StageCell state={stages?.[s.key] ?? null} label={s.label} />
                                </td>
                              ))}
                              <td className="max-w-md px-4 py-4">
                                {!r ? (
                                  <span className="text-muted-foreground">Not tested on {d}.</span>
                                ) : why ? (
                                  <div className="space-y-1">
                                    <div className="flex flex-wrap items-center gap-2">
                                      <span className="font-medium text-foreground">{why.title}</span>
                                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${OWNER_BADGE[why.owner]}`}>
                                        {OWNER_LABEL[why.owner]}
                                      </span>
                                    </div>
                                    <p className="text-xs text-muted-foreground">
                                      <span className="font-medium text-foreground">How to fix: </span>
                                      {why.fix}
                                    </p>
                                  </div>
                                ) : (
                                  <div className="space-y-1">
                                    <span className="text-foreground">Form submitted and the thank-you page loaded.</span>
                                    {buttons && buttons.total > 0 && (
                                      <p className={`text-xs ${buttons.ok < buttons.total ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground"}`}>
                                        Save quote &amp; Checkout buttons: {buttons.ok} of {buttons.total} worked
                                        {buttons.failed.length > 0 && ` · need a look: ${buttons.failed.join(", ")}`}
                                      </p>
                                    )}
                                    {buttons?.payment_note && (
                                      <p className={`text-xs ${/test key/i.test(buttons.payment) ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground"}`}>
                                        💳 Checkout: {buttons.payment_note}
                                      </p>
                                    )}
                                    {buttons?.list && buttons.list.length > 0 && (
                                      <ul className="space-y-0.5 text-xs">
                                        {buttons.list.map((b, i) => (
                                          <li key={i} className={b.ok ? "text-muted-foreground" : "text-amber-700 dark:text-amber-400"}>
                                            {b.ok ? "✅" : "⚠️"} <span className="font-medium">{b.label}</span>: {b.note}
                                          </li>
                                        ))}
                                      </ul>
                                    )}
                                  </div>
                                )}
                                {r?.email_note && (
                                  <p
                                    className={`mt-2 text-xs ${
                                      r.email_note.startsWith("Email sent") ? "text-green-700 dark:text-green-400" : "text-muted-foreground"
                                    }`}
                                  >
                                    📧 Quote form: {r.email_note}
                                  </p>
                                )}
                                {gtmMissing(r) && (
                                  <div className="mt-2 space-y-1">
                                    <div className="flex flex-wrap items-center gap-2">
                                      <span className="font-medium text-red-700 dark:text-red-400">{GTM_MISSING}</span>
                                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${OWNER_BADGE.website}`}>{OWNER_LABEL.website}</span>
                                    </div>
                                    <p className="text-xs text-muted-foreground">
                                      <span className="font-medium text-foreground">How to fix: </span>
                                      Add the site&apos;s Google Tag Manager container to the quote form page so leads are tracked.
                                    </p>
                                  </div>
                                )}
                              </td>
                              <td className="px-4 py-4 text-right">
                                <div className="flex flex-col items-end gap-2">
                                  {r?.report_id && (
                                    <ReportToggle open={openReport === key} onClick={() => toggleReport(key)} label="Step by step" />
                                  )}
                                  {on && (
                                    <button
                                      type="button"
                                      disabled={uiChecking !== null}
                                      onClick={() => startTest(f, [d])}
                                      className="inline-flex items-center gap-1 whitespace-nowrap rounded-md border px-2.5 py-1 text-xs font-medium transition-colors hover:bg-muted"
                                      title={`Test this funnel again on ${d} only - the other device keeps its last result`}
                                    >
                                      <RefreshCw className="h-3.5 w-3.5" /> Test {d} again
                                    </button>
                                  )}
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
                {DEVICES.map(d => {
                  const id = f.test_results?.[d]?.report_id;
                  return id && openReport === `${f.id}:${d}` ? (
                    <div key={d} className="border-t px-4 pb-4">
                      <InlineReport id={id} title={`${serviceLabel(f)} – ${DEVICE_LABEL[d]}, step by step`} onClose={() => setOpenReport(null)} />
                    </div>
                  ) : null;
                })}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
