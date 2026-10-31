"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { createClient } from "@/utils/supabase/client";
import { Skeleton } from "@/components/ui/skeleton";
import { FunnelReportView } from "@/components/FunnelReportView";
import { AlertCircle, AlertTriangle, ArrowLeft, ChevronDown, ChevronUp, ExternalLink, Monitor, Play, RefreshCw, Smartphone, Square, X } from "lucide-react";
import { apiErrorMessage } from "@/utils/api-error";
import { deriveStages, explainFailure, GTM_MISSING, gtmMissing, OWNER_LABEL, STAGES, type ProblemOwner, type StageState } from "@/utils/funnel-report";
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

type Tone = "green" | "red" | "amber" | "blue" | "muted";
const TONE_PILL: Record<Tone, string> = {
  green: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
  red: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  amber: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  blue: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
  muted: "bg-muted text-muted-foreground",
};
const TONE_TEXT: Record<Tone, string> = {
  green: "text-green-600 dark:text-green-400",
  red: "text-red-600 dark:text-red-400",
  amber: "text-amber-600 dark:text-amber-400",
  blue: "text-blue-600 dark:text-blue-400",
  muted: "text-muted-foreground",
};

// A rounded status label: "● Working", "● 1 funnel failing"
function Pill({ tone, children, dot = true }: { tone: Tone; children: React.ReactNode; dot?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ${TONE_PILL[tone]}`}>
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

// A small round ✓ / ! / ✕ with words beside it, for a table cell
function Mark({ tone, children }: { tone: "green" | "amber" | "red"; children: React.ReactNode }) {
  const mark = tone === "green" ? "✓" : tone === "red" ? "✕" : "!";
  return (
    <span className={`inline-flex items-center gap-2 whitespace-nowrap ${tone === "green" ? "text-foreground/80" : TONE_TEXT[tone]}`}>
      <span className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-bold ${TONE_PILL[tone]}`}>{mark}</span>
      {children}
    </span>
  );
}

// One stage of a test (quote form, verify, thank-you page) as a mark and a word
function StagePill({ state, label }: { state: StageState | null; label: string }) {
  if (!state) return <span className="text-muted-foreground">—</span>;
  const look: Record<StageState, { tone: "green" | "amber" | "red"; word: string } | null> = {
    ok: { tone: "green", word: "Working" },
    failed: { tone: "red", word: "Failed" },
    none: null,
    pending: null,
    unknown: null,
  };
  const l = look[state];
  if (!l) {
    const word = state === "none" ? "Not needed" : state === "pending" ? "Not reached" : "Run again";
    return <span className="text-muted-foreground" title={label}>{word}</span>;
  }
  return (
    <span title={label}>
      <Mark tone={l.tone}>{l.word}</Mark>
    </span>
  );
}

// One "at a glance" box at the top of the page
function SummaryCard({ label, value, tone, note }: { label: string; value: string; tone: Tone; note: string }) {
  return (
    <div className="rounded-xl border bg-card px-5 py-4">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${TONE_TEXT[tone]}`}>{value}</p>
      <p className="mt-1 truncate text-sm text-muted-foreground" title={note}>
        {note}
      </p>
    </div>
  );
}

// Something on one device's test that needs a look; chips = the products it affects
interface Issue {
  title: string;
  desc?: string;
  chips?: string[];
  owner?: ProblemOwner;
  count: number;
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
  // Button lists opened with "Show": "landing:<device>" or "<funnel id>:<device>"
  const [openLists, setOpenLists] = useState<Set<string>>(new Set());
  const toggleList = (key: string) =>
    setOpenLists(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

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
  // A status check answers testerOffline when the test runs on a tester this site
  // can't reach (started from the app on the computer running it)
  const TESTER_ELSEWHERE = "Running on the funnel tester on another computer - the result shows here when it finishes.";
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
          if (cancelled) return;
          // Started from the local app, on a tester this site can't reach: wait quietly
          if (body.testerOffline) {
            pollWorked();
            setTestMessages(prev => ({ ...prev, [id]: TESTER_ELSEWHERE }));
            continue;
          }
          if (!res.ok) throw new Error(res.status === 401 ? "Your session has expired. Please sign in again." : body.error);
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

  const isFailing = (f: Funnel) =>
    f.test_status === "failed" || f.test_status === "error" || (f.test_status === "passed" && anyStageFailed(f));
  // When a failing funnel broke: the oldest failed test since it last worked
  const brokeSince = (f: Funnel) => {
    const entries = history[f.id] ?? [];
    const lastWorked = entries.findIndex(e => e.result === "working");
    const oldestFail = entries[(lastWorked >= 0 ? lastWorked : entries.length) - 1];
    return oldestFail && oldestFail.result !== "working" ? oldestFail.finished_at : f.test_finished_at;
  };
  const funnelBadge = (f: Funnel): { text: string; tone: Tone } => {
    if (f.test_enabled === false) return { text: "Switched off", tone: "muted" };
    if (f.test_status === "running") return { text: "Testing now…", tone: "blue" };
    if (isFailing(f)) {
      const since = brokeSince(f);
      return { text: since ? `Not working since ${shortDate(since)}` : "Not working", tone: "red" };
    }
    if (f.test_status === "passed") return { text: "Working", tone: "green" };
    return { text: "Not tested yet", tone: "muted" };
  };
  // Failing (and running) funnels first, then working, then not tested
  const rank = (f: Funnel) => (f.test_enabled === false ? 3 : isFailing(f) || f.test_status === "running" ? 0 : f.test_status === "passed" ? 1 : 2);
  const ordered = [...listed].sort((a, b) => rank(a) - rank(b));

  // Summary card: quote funnels
  const firstFailing = ordered.find(f => f.test_enabled !== false && isFailing(f));
  const whereItFails = (f: Funnel) => {
    for (const d of DEVICES) {
      const r = f.test_results?.[d];
      if (!r) continue;
      const stages = deriveStages(r);
      const stage = STAGES.find(s => stages[s.key] === "failed");
      if (stage) return `${serviceLabel(f)} – ${d} ${stage.short.toLowerCase()}`;
      if (r.status !== "passed") return `${serviceLabel(f)} – ${explainFailure(r.failure, r.site_problem)?.title ?? `${d} test failed`}`;
    }
    return serviceLabel(f);
  };
  // Summary card: landing page quote buttons, both devices together
  const landingUi = uiSource ? DEVICES.map(d => uiSource.ui_results?.[d]).filter((u): u is UiResult => !!u && !u.error) : [];
  const quoteFound = landingUi.reduce((n, u) => n + u.quote_buttons_found, 0);
  const quoteWorking = landingUi.reduce((n, u) => n + u.quote_buttons_working, 0);
  const landingWhere = (() => {
    const checked = uiSource?.ui_results?.desktop?.landing_url ?? uiSource?.ui_results?.mobile?.landing_url;
    const also = uiSource?.ui_results?.desktop?.also_checked_url ?? uiSource?.ui_results?.mobile?.also_checked_url;
    const pathOf = (u: string) => new URL(u).pathname;
    const main = checked && pathOf(checked).replace(/\/+$/, "") !== "" ? pathOf(checked) : "Homepage";
    return also ? `${main} + ${pathOf(also)}` : main;
  })();
  // Summary card: did the site email the quote after each test?
  const emailNotes = tested.flatMap(f => DEVICES.map(d => f.test_results?.[d]?.email_note).filter((n): n is string => !!n));
  const emailsReceived = emailNotes.filter(n => n.startsWith("Email sent")).length;
  // Summary card: spelling & grammar
  const grammar = uiSource?.ui_results?.desktop?.grammar_issues;
  const grammarToFix = Array.isArray(grammar) ? grammar.filter(g => g.status !== "fixed").length : 0;
  // Daily checks that couldn't run (e.g. no funnel tester connected to this site)
  const healthError = Object.values(health)
    .map(h => ("error" in h ? (h as { error: string }).error : null))
    .find((e): e is string => !!e);

  // One device's problems, grouped: buttons failing the same way become one issue
  // with the products as chips
  const issuesOf = (r: DeviceResult): Issue[] => {
    const issues: Issue[] = [];
    const why = r.status !== "passed" ? explainFailure(r.failure, r.site_problem) : null;
    if (why) issues.push({ title: why.title, desc: `How to fix: ${why.fix}`, owner: why.owner, count: 1 });
    const buttons = r.results_buttons;
    if (buttons?.list) {
      const groups = new Map<string, { kind: string; note: string; names: string[] }>();
      for (const b of buttons.list.filter(b => !b.ok)) {
        const colon = b.label.indexOf(":");
        const kind = colon > 0 ? b.label.slice(0, colon).trim() : b.label;
        const name = colon > 0 ? b.label.slice(colon + 1).trim() : "";
        const key = `${kind}|${b.note}`;
        if (!groups.has(key)) groups.set(key, { kind, note: b.note, names: [] });
        if (name) groups.get(key)!.names.push(name);
      }
      for (const g of Array.from(groups.values())) {
        issues.push(
          g.names.length > 1
            ? { title: `"${g.kind}" - ${g.note}`, chips: g.names, count: g.names.length }
            : { title: g.names[0] ? `${g.kind}: ${g.names[0]}` : g.kind, desc: g.note, count: 1 }
        );
      }
    } else if (buttons && buttons.failed.length > 0) {
      issues.push({ title: "Thank-you page buttons need a look", chips: buttons.failed, count: buttons.failed.length });
    }
    if (buttons?.payment_note && /test key/i.test(buttons.payment)) issues.push({ title: "Checkout", desc: buttons.payment_note, count: 1 });
    if (gtmMissing(r)) {
      issues.push({
        title: GTM_MISSING,
        desc: "How to fix: Add the site's Google Tag Manager container to the quote form page so leads are tracked.",
        owner: "website",
        count: 1,
      });
    }
    return issues;
  };

  // Landing page buttons with the same text, as one line: "GET A FREE QUOTE ×6"
  const groupQuoteButtons = (list: NonNullable<UiResult["quote_buttons"]>) => {
    const groups = new Map<string, { label: string; total: number; works: number; positions: Record<string, number>; to: Set<string>; problems: string[] }>();
    for (const b of list) {
      const label = b.label || "(no text)";
      if (!groups.has(label)) groups.set(label, { label, total: 0, works: 0, positions: {}, to: new Set(), problems: [] });
      const g = groups.get(label)!;
      g.total++;
      if (b.works) g.works++;
      else g.problems.push(b.outcome);
      // "top of page" -> "top"
      const pos = b.position?.replace(/ of (the )?page$/i, "");
      if (pos) g.positions[pos] = (g.positions[pos] ?? 0) + 1;
      const url = b.outcome.match(/https?:\/\/[^\s)"',]+/)?.[0];
      if (url && b.works) {
        try {
          g.to.add(new URL(url).pathname);
        } catch {}
      }
    }
    return Array.from(groups.values());
  };

  const stopOrRun = (f: Funnel, on: boolean) =>
    f.test_status === "running" || uiChecking === f.id ? (
      <button
        type="button"
        onClick={() => stopTest(f)}
        disabled={stopping === f.id}
        className="inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-md border px-3 text-xs font-semibold text-red-600 transition-colors hover:bg-muted disabled:opacity-50"
        title="Stop this test"
      >
        <Square className="h-3.5 w-3.5" /> {stopping === f.id ? "Stopping…" : "Stop"}
      </button>
    ) : (
      <button
        type="button"
        onClick={() => startTest(f, DEVICES)}
        disabled={!on || uiChecking !== null}
        className="inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-md border px-3 text-xs font-semibold transition-colors hover:bg-muted disabled:opacity-50"
        title={on ? "Test this funnel again: desktop, then mobile" : "Tick Include in tests to test this funnel"}
      >
        <Play className="h-3.5 w-3.5 fill-current" /> Run test
      </button>
    );

  const headCell = "px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground";
  const siteBadge: { text: string; tone: Tone } =
    failing > 0
      ? { text: `${failing} funnel${failing === 1 ? "" : "s"} failing`, tone: "red" }
      : passing > 0 && passing === tested.length
        ? { text: "All funnels working", tone: "green" }
        : { text: "Not fully tested yet", tone: "muted" };

  return (
    <div className="container mx-auto max-w-7xl px-4 py-8">
      {backLink}

      {/* Header: the website, how it's doing, and the daily check */}
      <div className="mb-5 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-3xl font-bold text-foreground">{siteName}</h1>
            <Pill tone={siteBadge.tone}>{siteBadge.text}</Pill>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-sm text-muted-foreground">
            <a href={home?.url ?? `https://${host}/`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-foreground hover:text-brand">
              {host} <ExternalLink className="h-3 w-3" />
            </a>
            {clientName ? (
              <span>Client: {clientName}</span>
            ) : (
              <span className="rounded-full bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-800 dark:bg-violet-950 dark:text-violet-300">Added manually</span>
            )}
            {lastTested && <span>Last tested {shortDate(lastTested)}</span>}
          </div>
        </div>
        <button
          onClick={runHealthCheck}
          disabled={checkingHealth}
          title="Opens each quote page and checks it without filling in or sending anything: page, quote form, GTM, postcode lookup, Stripe key, phone links"
          className="inline-flex h-10 shrink-0 items-center gap-2 rounded-md bg-brand px-4 text-sm font-semibold text-white shadow-sm transition-opacity hover:opacity-90 disabled:opacity-60"
        >
          <RefreshCw className={`h-4 w-4 ${checkingHealth ? "animate-spin" : ""}`} />
          {checkingHealth ? "Checking… (about 30s per funnel)" : "Run daily check now"}
        </button>
      </div>

      {healthError && (
        <div className="mb-5 flex items-start gap-2.5 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800/70 dark:bg-amber-950/30 dark:text-amber-200">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            <span className="font-semibold">Scheduled daily checks can&apos;t run. </span>
            {healthError}
          </p>
        </div>
      )}
      {saveError && (
        <div className="mb-5 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-400">
          <AlertCircle className="h-4 w-4 shrink-0" /> {saveError}
        </div>
      )}

      {/* At a glance */}
      <div className="mb-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard
          label="Quote funnels"
          value={tested.length === 0 ? "None to test" : failing > 0 ? `${failing} of ${tested.length} failing` : passing === tested.length ? `All ${tested.length} working` : `${passing} of ${tested.length} working`}
          tone={failing > 0 ? "red" : passing === tested.length && passing > 0 ? "green" : "muted"}
          note={firstFailing ? whereItFails(firstFailing) : passing > 0 ? "Every stage worked on desktop and mobile" : "Run a test to see results"}
        />
        <SummaryCard
          label={'"Get a quote" buttons'}
          value={!uiSource ? "Not checked yet" : quoteFound === 0 ? "None found" : `${quoteWorking} of ${quoteFound} work`}
          tone={!uiSource ? "muted" : quoteFound > 0 && quoteWorking === quoteFound ? "green" : "amber"}
          note={uiSource ? landingWhere : "Checked at the start of every test"}
        />
        <SummaryCard
          label="Email confirmations"
          value={emailNotes.length === 0 ? "Not recorded" : `${emailsReceived} of ${emailNotes.length} received`}
          tone={emailNotes.length === 0 ? "muted" : emailsReceived === emailNotes.length ? "green" : "amber"}
          note={
            emailNotes.length === 0
              ? "Shown after the next test"
              : emailsReceived === 0
                ? "Site sends no confirmation email"
                : emailsReceived < emailNotes.length
                  ? "Some tests got no email"
                  : "Every test got an email"
          }
        />
        <SummaryCard
          label="Spelling & grammar (UK)"
          value={!Array.isArray(grammar) ? "Not checked yet" : grammar.length === 0 ? "No mistakes" : grammarToFix === 0 ? "All fixed" : `${grammarToFix} to fix`}
          tone={!Array.isArray(grammar) ? "muted" : grammarToFix === 0 ? "green" : "amber"}
          note={uiSource?.ui_checked_at ? `Checked ${shortDate(uiSource.ui_checked_at)}` : "Checked with the next test"}
        />
      </div>

      {/* Every funnel: each device's stages, and what needs a look */}
      <section className="mb-10">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 className="text-lg font-semibold">Quote funnels</h2>
          <span className="text-sm text-muted-foreground">Failing funnels first · passing checks are hidden until you expand them</span>
        </div>
        <div className="space-y-4">
          {ordered.map(f => {
            const badge = funnelBadge(f);
            const on = f.test_enabled !== false;
            const problems = health[f.id] && !("error" in health[f.id]) ? health[f.id].checks.filter(c => c.status === "problem") : [];
            return (
              <div key={f.id} className={`overflow-hidden rounded-xl border bg-card ${on ? "" : "opacity-60"}`}>
                <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
                  <div className="flex flex-wrap items-center gap-3">
                    <h3 className="text-lg font-semibold">{serviceLabel(f)}</h3>
                    <Pill tone={badge.tone}>{badge.text}</Pill>
                    {f.test_finished_at && f.test_status !== "running" && (
                      <span className="text-sm text-muted-foreground">
                        {shortDate(f.test_finished_at)}
                        {tookText(f)}
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-4 text-sm">
                    <label className="inline-flex cursor-pointer items-center gap-2" title={on ? "Untick to stop testing this funnel" : "Tick to test this funnel again"}>
                      <input
                        type="checkbox"
                        checked={on}
                        disabled={f.test_status === "running"}
                        onChange={e => setTestEnabled(f, e.target.checked)}
                        className="h-4 w-4 accent-brand"
                      />
                      Include in tests
                    </label>
                    <a href={f.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:text-brand">
                      Open page <ExternalLink className="h-3 w-3" />
                    </a>
                    {stopOrRun(f, on)}
                  </div>
                </div>

                {problems.length > 0 && (
                  <div className="border-t px-5 py-2 text-xs text-amber-700 dark:text-amber-400">
                    <span className="font-semibold">Daily check {shortDate(health[f.id].checked_at)}: </span>
                    {problems.map(c => `${c.label} - ${c.detail}`).join(" · ")}
                  </div>
                )}

                {f.test_status === "running" || uiChecking === f.id ? (
                  <div className="border-t px-5 py-4 text-sm text-blue-700 dark:text-blue-300">
                    {uiChecking === f.id ? "Checking the landing page first…" : "Testing right now…"}
                    {testMessages[f.id] && <p className="mt-1 truncate text-xs" title={testMessages[f.id]}>{testMessages[f.id]}</p>}
                  </div>
                ) : !f.test_results ? (
                  <p className="border-t px-5 py-4 text-sm text-muted-foreground">
                    {f.test_failure ? explainFailure(f.test_failure)?.title ?? f.test_failure : "Not tested yet - press Run test."}
                  </p>
                ) : (
                  <div className="overflow-x-auto border-t">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b bg-muted/30">
                          <th className={headCell}>Device</th>
                          {STAGES.map(s => (
                            <th key={s.key} className={headCell} title={s.label}>
                              {s.short}
                            </th>
                          ))}
                          <th className={headCell}>Buttons</th>
                          <th className={headCell}>Email</th>
                          <th className={`${headCell} text-right`}>Report</th>
                        </tr>
                      </thead>
                      <tbody>
                        {DEVICES.map(d => {
                          const r = f.test_results?.[d];
                          const Icon = DEVICE_ICON[d];
                          const key = `${f.id}:${d}`;
                          const stages = r ? deriveStages(r) : null;
                          const buttons = r?.results_buttons;
                          const issues = r ? issuesOf(r) : [];
                          const issueCount = issues.reduce((n, i) => n + i.count, 0);
                          const passed = buttons?.list?.filter(b => b.ok) ?? [];
                          return (
                            <Fragment key={d}>
                              <tr className="border-t first:border-t-0">
                                <td className="px-4 py-3.5">
                                  <span className="inline-flex items-center gap-2 font-semibold">
                                    <Icon className="h-4 w-4 text-muted-foreground" /> {DEVICE_LABEL[d]}
                                  </span>
                                </td>
                                {STAGES.map(s => (
                                  <td key={s.key} className="px-4 py-3.5">
                                    <StagePill state={stages?.[s.key] ?? null} label={s.label} />
                                  </td>
                                ))}
                                <td className="px-4 py-3.5">
                                  {buttons && buttons.total > 0 ? (
                                    <Mark tone={buttons.ok === buttons.total ? "green" : "amber"}>
                                      {buttons.ok} of {buttons.total}
                                    </Mark>
                                  ) : (
                                    <span className="text-muted-foreground">—</span>
                                  )}
                                </td>
                                <td className="px-4 py-3.5">
                                  {r?.email_note ? (
                                    <span title={r.email_note}>
                                      <Mark tone={r.email_note.startsWith("Email sent") ? "green" : "amber"}>
                                        {r.email_note.startsWith("Email sent") ? "Received" : "None"}
                                      </Mark>
                                    </span>
                                  ) : (
                                    <span className="text-muted-foreground">—</span>
                                  )}
                                </td>
                                <td className="px-4 py-3.5">
                                  <div className="flex items-center justify-end gap-2">
                                    {r?.report_id && (
                                      <button
                                        type="button"
                                        onClick={() => toggleReport(key)}
                                        className={`inline-flex h-8 items-center whitespace-nowrap rounded-md border px-3 text-xs font-semibold transition-colors ${
                                          openReport === key ? "border-brand bg-brand text-white" : "hover:bg-muted"
                                        }`}
                                      >
                                        {openReport === key ? "Hide steps" : "Step by step"}
                                      </button>
                                    )}
                                    {on && (
                                      <button
                                        type="button"
                                        disabled={uiChecking !== null || f.test_status === "running"}
                                        onClick={() => startTest(f, [d])}
                                        className="inline-flex h-8 items-center gap-1 whitespace-nowrap rounded-md border px-3 text-xs font-semibold transition-colors hover:bg-muted disabled:opacity-50"
                                        title={`Test this funnel again on ${d} only - the other device keeps its last result`}
                                      >
                                        <RefreshCw className="h-3.5 w-3.5" /> Retest
                                      </button>
                                    )}
                                  </div>
                                </td>
                              </tr>
                              {r && (issueCount > 0 || passed.length > 0) && (
                                <tr>
                                  <td colSpan={STAGES.length + 4} className="px-4 pb-3.5 pt-0">
                                    {issueCount > 0 && (
                                      <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 dark:border-amber-800/70 dark:bg-amber-950/20">
                                        <p className="mb-2 text-[11px] font-bold uppercase tracking-wider text-amber-700 dark:text-amber-400">
                                          {DEVICE_LABEL[d]} · {issueCount} issue{issueCount === 1 ? "" : "s"} to look at
                                        </p>
                                        <ul className="space-y-3">
                                          {issues.map((issue, i) => (
                                            <li key={i}>
                                              <div className="flex flex-wrap items-center gap-2">
                                                <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                                                <span className="font-semibold text-amber-900 dark:text-amber-200">{issue.title}</span>
                                                {issue.owner && (
                                                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${OWNER_BADGE[issue.owner]}`}>{OWNER_LABEL[issue.owner]}</span>
                                                )}
                                              </div>
                                              {issue.desc && <p className="ml-6 mt-0.5 text-sm text-muted-foreground">{issue.desc}</p>}
                                              {issue.chips && (
                                                <div className="ml-6 mt-1.5 flex flex-wrap gap-1.5">
                                                  {issue.chips.map((c, j) => (
                                                    <span key={j} className="rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-900/30 dark:text-amber-200">
                                                      {c}
                                                    </span>
                                                  ))}
                                                </div>
                                              )}
                                            </li>
                                          ))}
                                        </ul>
                                      </div>
                                    )}
                                    {passed.length > 0 && (
                                      <div className={issueCount > 0 ? "mt-2" : ""}>
                                        <button
                                          type="button"
                                          onClick={() => toggleList(key)}
                                          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
                                        >
                                          {openLists.has(key) ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                                          {openLists.has(key) ? "Hide passing checks" : `Show ${passed.length} passing check${passed.length === 1 ? "" : "s"}`}
                                        </button>
                                        {openLists.has(key) && (
                                          <ul className="ml-5 mt-1.5 space-y-0.5 text-sm text-muted-foreground">
                                            {passed.map((b, i) => (
                                              <li key={i}>
                                                <span className="text-green-600 dark:text-green-400">✓</span> <span className="font-medium text-foreground">{b.label}</span>: {b.note}
                                              </li>
                                            ))}
                                            {buttons?.payment_note && !/test key/i.test(buttons.payment) && <li>💳 Checkout: {buttons.payment_note}</li>}
                                            {r.email_note && <li>📧 {r.email_note}</li>}
                                          </ul>
                                        )}
                                      </div>
                                    )}
                                  </td>
                                </tr>
                              )}
                            </Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
                {/* The step-by-step report, under the table so it can't widen it */}
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

      {/* Landing page: every "Get a quote" button clicked, grouped by its words */}
      <section>
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 className="text-lg font-semibold">Landing page &quot;Get a quote&quot; buttons</h2>
          {uiSource && (
            <span className="text-sm text-muted-foreground">
              {landingWhere} · clicked only, nothing submitted
              {uiSource.ui_checked_at && (
                <>
                  {" "}· checked{!isHomepage(uiSource.url) && <> for {serviceLabel(uiSource)}</>}, {shortDate(uiSource.ui_checked_at)}
                </>
              )}
            </span>
          )}
        </div>
        {!uiSource ? (
          <p className="rounded-xl border p-4 text-sm text-muted-foreground">Not checked yet - it runs at the start of every test.</p>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {DEVICES.map(d => {
              const ui = uiSource.ui_results?.[d];
              const list = ui && !ui.error ? ui.quote_buttons ?? (ui.report_id ? oldQuoteButtons[ui.report_id] : undefined) : undefined;
              const allWork = !!ui && !ui.error && ui.quote_buttons_found > 0 && ui.quote_buttons_working === ui.quote_buttons_found;
              return (
                <div key={d} className="overflow-hidden rounded-xl border bg-card">
                  <div className="flex items-center justify-between border-b px-5 py-3">
                    <span className="font-semibold">{DEVICE_LABEL[d]}</span>
                    {ui && !ui.error && (
                      <Pill tone={allWork ? "green" : "red"} dot={false}>
                        {ui.quote_buttons_found === 0 ? "No quote buttons found" : `${ui.quote_buttons_working} of ${ui.quote_buttons_found} work`}
                      </Pill>
                    )}
                  </div>
                  {!ui ? (
                    <p className="px-5 py-4 text-sm text-muted-foreground">Not checked</p>
                  ) : ui.error ? (
                    <p className="px-5 py-4 text-sm text-red-700 dark:text-red-400">{explainFailure(ui.error)?.title ?? ui.error}</p>
                  ) : (
                    <ul className="divide-y">
                      {groupQuoteButtons(list ?? []).map(g => (
                        <li key={g.label} className="flex items-start justify-between gap-4 px-5 py-3">
                          <div className="min-w-0">
                            <p className="font-semibold">
                              {g.label} <span className="font-normal text-muted-foreground">×{g.total}</span>
                            </p>
                            <p className="mt-0.5 text-xs text-muted-foreground">
                              {Object.entries(g.positions)
                                .map(([pos, n]) => (g.total > 1 ? `${pos} ${n}` : pos))
                                .join(" · ")}
                              {g.to.size > 0 && <> → {Array.from(g.to).join(", ")}</>}
                            </p>
                            {g.problems.map((p, i) => (
                              <p key={i} className="mt-0.5 text-xs text-amber-700 dark:text-amber-400">
                                ⚠️ {p}
                              </p>
                            ))}
                          </div>
                          <span className={`shrink-0 text-sm font-medium ${g.works === g.total ? "text-green-600 dark:text-green-400" : "text-amber-600 dark:text-amber-400"}`}>
                            {g.works === g.total ? (g.total > 1 ? "all work" : "works") : `${g.works} of ${g.total} work`}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Spelling & grammar mistakes, when there are any to look at */}
        {Array.isArray(grammar) && grammar.length > 0 && (
          <div className="mt-4 overflow-x-auto rounded-xl border bg-card">
            <p className="border-b px-5 py-3 font-semibold">Spelling &amp; grammar (UK)</p>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/30">
                  <th className={headCell}>Found on the page</th>
                  <th className={headCell}>Should be</th>
                  <th className={headCell}>Why</th>
                  <th className={headCell}>Status</th>
                </tr>
              </thead>
              <tbody className="divide-y">
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
                          onChange={e => setGrammarStatus(uiSource!, i, e.target.value as "fix" | "fixed")}
                          aria-label={`Status of "${g.found}"`}
                          className={`rounded-md border bg-background px-2 py-1 text-xs font-medium ${fixed ? "text-green-700 dark:text-green-400" : "text-amber-700 dark:text-amber-400"}`}
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
        )}
      </section>
    </div>
  );
}
