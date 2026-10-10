"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { isChooserFunnel } from "@/utils/funnel-discovery";
import Link from "next/link";
import {
  classifyMessage,
  combineStages,
  deriveProgress,
  deriveStages,
  explainFailure,
  GTM_MISSING,
  gtmMissing,
  STAGES,
  type FunnelStages,
  isWaitingForOtp,
  LOG_STYLE,
  OWNER_LABEL,
  type Explanation,
  type ProblemOwner,
} from "@/utils/funnel-report";
import { createClient } from "@/utils/supabase/client";
import { FunnelStageMarks, StageCell } from "@/components/FunnelStageMarks";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import {
  AlertCircle,
  Check,
  CheckCircle,
  ChevronDown,
  Clock,
  ChevronUp,
  ExternalLink,
  FileText,
  Filter,
  Globe,
  Minus,
  Monitor,
  MousePointerClick,
  Play,
  Plus,
  RefreshCw,
  Search,
  Smartphone,
  Square,
  Trash2,
  X,
} from "lucide-react";

interface Funnel {
  id: string;
  name: string;
  url: string;
  domain_id: string | null;
  last_status: boolean | null;
  last_status_code: number | null;
  last_response_time: number | null;
  last_error: string | null;
  last_checked_at: string | null;
  test_status: "running" | "passed" | "failed" | "error" | null;
  test_failure: string | null;
  test_steps: number | null;
  test_tracking_ok: boolean | null;
  test_started_at: string | null;
  test_finished_at: string | null;
  // Per-device results; test_status is the overall one
  test_results: Record<"desktop" | "mobile", {
    status: "passed" | "failed" | "error";
    failure: string | null;
    steps: number | null;
    tracking_ok: boolean | null;
    report_id?: string | null;
    site_problem?: string | null;
    results_buttons?: { ok: number; total: number; failed: string[]; payment: string } | null;
    otp_seen?: boolean;
    gtm_found?: boolean | null;
  }> | null;
  // UI check: quote buttons + visual problems, no forms submitted
  ui_status: "running" | "ok" | "issues" | "error" | null;
  ui_results: Record<"desktop" | "mobile", UiResult> | null;
  ui_checked_at: string | null;
  created_at: string;
  // false = switched off on the website's report page: never tested. Missing until
  // migrations/add_funnel_test_enabled.sql has been run, which counts as on.
  test_enabled?: boolean | null;
}

interface UiResult {
  status: "ok" | "issues" | "error";
  ui_issues: string[];
  quote_buttons_found: number;
  quote_buttons_working: number;
  cta: { label: string; works: boolean } | null;
  error: string | null;
  report_id: string | null;
}

interface DomainOption {
  id: string;
  domain_name: string;
  display_name: string | null;
}

// Same concurrency as the admin "Check Selected" batch
const CHECK_CONCURRENCY = 5;
const NO_CLIENT = "none";
const NO_CLIENT_LABEL = "No client";
// Result filters that pick whole websites by their overall test status
const SITE_FILTERS = ["passed", "failed", "untested"];
// How often to ask the funnel tester how a walk is going
const TEST_POLL_MS = 5000;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function formatTimeAgo(iso: string) {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "Just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

// "4m 12s", "1h 05m", "45s"
function formatDuration(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

// Same as the server's FUNNEL_RETEST_COOLDOWN_MINUTES default: how long a funnel
// waits between tests so the test phone numbers aren't asked for codes too often
// (Twilio blocks numbers that get codes again and again)
const RETEST_COOLDOWN_MIN = 24 * 60;

// "45 min", "3h 20m", "24 hours"
function minutesText(min: number) {
  if (min < 60) return `${min} min`;
  if (min % 60 === 0) return `${min / 60} hour${min === 60 ? "" : "s"}`;
  return `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, "0")}m`;
}

// Minutes until a funnel can be tested again (0 = now). Stopped or crashed tests
// ("error") don't count, the same as on the server.
function cooldownLeft(f: { test_status: string | null; test_finished_at: string | null }) {
  if ((f.test_status !== "passed" && f.test_status !== "failed") || !f.test_finished_at) return 0;
  const ready = new Date(f.test_finished_at).getTime() + RETEST_COOLDOWN_MIN * 60_000;
  return Math.max(0, Math.ceil((ready - Date.now()) / 60_000));
}

// How long the last test of a funnel took, both devices together
function testDurationMs(f: { test_started_at: string | null; test_finished_at: string | null }) {
  if (!f.test_started_at || !f.test_finished_at) return null;
  const ms = new Date(f.test_finished_at).getTime() - new Date(f.test_started_at).getTime();
  // Ignore nonsense (clock skew, a test left "running" overnight)
  return ms > 0 && ms < 3 * 3600_000 ? ms : null;
}

type Device = "mobile" | "desktop";
type DeviceChoice = Device | "both";

const DEVICES_FOR_CHOICE: Record<DeviceChoice, Device[]> = {
  both: ["desktop", "mobile"],
  desktop: ["desktop"],
  mobile: ["mobile"],
};

// Mirrors LiveRun in utils/funnel-tester.ts
interface LiveRun {
  status: "queued" | "running" | "completed" | "failed";
  messages: string[];
  latestScreenshot?: string;
}
type DeviceResult = NonNullable<Funnel["test_results"]>[Device];

// One device's result. Tests from before the desktop + mobile split, and runs that
// never reached the walker (page down, tester restarted), only have the overall one.
function deviceResult(funnel: Funnel, device: Device): DeviceResult | undefined {
  if (funnel.test_results?.[device]) return funnel.test_results[device];
  if (!funnel.test_status || funnel.test_status === "running") return undefined;
  return {
    status: funnel.test_status,
    failure: funnel.test_failure,
    steps: funnel.test_steps,
    tracking_ok: funnel.test_tracking_ok,
  };
}

const RESULT_LABEL = { passed: "Passed", failed: "Failed", error: "Error" } as const;

function resultColor(status: DeviceResult["status"]) {
  return status === "passed"
    ? "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-400"
    : "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400";
}

// Same pill as the Speed Test page, with a pass/fail result instead of a score
// A round status mark: green tick, red cross, blue spinner, or grey dash
function StateIcon({ state, size = "sm" }: { state: "running" | "passed" | "failed" | "partial" | "untested"; size?: "sm" | "lg" }) {
  const box = size === "lg" ? "h-8 w-8" : "h-6 w-6";
  const icon = size === "lg" ? "h-4 w-4" : "h-3.5 w-3.5";
  if (state === "running") {
    return (
      <span className={`${box} inline-flex shrink-0 items-center justify-center rounded-full bg-blue-100 text-blue-600 dark:bg-blue-950 dark:text-blue-400`}>
        <RefreshCw className={`${icon} animate-spin`} />
      </span>
    );
  }
  if (state === "passed") {
    return (
      <span className={`${box} inline-flex shrink-0 items-center justify-center rounded-full bg-green-100 text-green-600 dark:bg-green-950 dark:text-green-400`}>
        <Check className={icon} />
      </span>
    );
  }
  if (state === "failed") {
    return (
      <span className={`${box} inline-flex shrink-0 items-center justify-center rounded-full bg-red-100 text-red-600 dark:bg-red-950 dark:text-red-400`}>
        <X className={icon} />
      </span>
    );
  }
  return (
    <span className={`${box} inline-flex shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground`}>
      <Minus className={icon} />
    </span>
  );
}

function DevicePill({ result, testing, icon: Icon }: { result?: DeviceResult; testing: boolean; icon: any }) {
  if (testing) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-100 px-2.5 py-1 text-xs font-medium text-blue-700 dark:bg-blue-950 dark:text-blue-400">
        <RefreshCw className="h-3 w-3 animate-spin" />
        Testing
      </span>
    );
  }
  if (!result) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">
        <Icon className="h-3 w-3" /> —
      </span>
    );
  }
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${resultColor(result.status)}`}>
      {result.status === "error" ? <AlertCircle className="h-3 w-3" /> : <Icon className="h-3 w-3" />}
      {RESULT_LABEL[result.status]}
    </span>
  );
}

function PagePill({ funnel, checking }: { funnel: Funnel; checking: boolean }) {
  if (checking) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-100 px-2.5 py-1 text-xs font-medium text-blue-700 dark:bg-blue-950 dark:text-blue-400">
        <RefreshCw className="h-3 w-3 animate-spin" />
      </span>
    );
  }
  if (funnel.last_status === null) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground" title="Page not checked yet">
        <Globe className="h-3 w-3" /> —
      </span>
    );
  }
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${
        funnel.last_status
          ? "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-400"
          : "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400"
      }`}
      title={funnel.last_status ? "Page loads" : funnel.last_error || "Page is down"}
    >
      <Globe className="h-3 w-3" />
      {funnel.last_status ? "Up" : "Down"}
    </span>
  );
}

const screenshotUrl = (path: string) => `/api/funnels/screenshot?path=${encodeURIComponent(path)}`;

function ReportLink({ id, label }: { id?: string | null; label: string }) {
  if (!id) return null;
  return (
    <Link href={`/funnel-test/report/${id}`} className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
      <FileText className="h-3 w-3" /> {label}
    </Link>
  );
}

const OWNER_STYLE: Record<ProblemOwner, string> = {
  website: "border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-900 dark:bg-rose-950/50 dark:text-rose-300",
  tester: "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-300",
  setup: "border-violet-200 bg-violet-50 text-violet-800 dark:border-violet-900 dark:bg-violet-950/50 dark:text-violet-300",
  unclear: "border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-900 dark:bg-sky-950/50 dark:text-sky-300",
  stopped: "border-border bg-muted/50 text-muted-foreground",
};

// A failure explained in plain words: whose problem it is, what happened, how to fix
// it - with the original technical text folded away underneath
function ExplanationBox({ explanation, raw }: { explanation: Explanation | null; raw?: (string | null | undefined)[] }) {
  if (!explanation) return null;
  const details = (raw ?? []).filter((r): r is string => !!r && r !== explanation.what);
  return (
    <div className={`mt-3 rounded-md border p-2.5 text-xs ${OWNER_STYLE[explanation.owner]}`}>
      <div className="text-[10px] font-semibold uppercase tracking-wide opacity-80">{OWNER_LABEL[explanation.owner]}</div>
      <div className="mt-0.5 text-sm font-semibold">{explanation.title}</div>
      <p className="mt-1">{explanation.what}</p>
      <p className="mt-1.5"><span className="font-semibold">How to fix: </span>{explanation.fix}</p>
      {details.length > 0 && (
        <details className="mt-1.5 opacity-80">
          <summary className="cursor-pointer">Technical details</summary>
          {details.map((d, i) => <p key={i} className="mt-1 break-words">{d}</p>)}
        </details>
      )}
    </div>
  );
}

type StepState = "pending" | "active" | "passed" | "failed" | "skipped";

const STEP_ICON: Record<StepState, ReactNode> = {
  pending: <span className="flex h-5 w-5 items-center justify-center rounded-full border-2 border-muted-foreground/30" />,
  active: <RefreshCw className="h-5 w-5 animate-spin text-blue-600 dark:text-blue-400" />,
  passed: <CheckCircle className="h-5 w-5 text-green-600 dark:text-green-400" />,
  failed: <AlertCircle className="h-5 w-5 text-red-600 dark:text-red-400" />,
  skipped: <span className="flex h-5 w-5 items-center justify-center text-muted-foreground">–</span>,
};

// The test, in the order it runs: the landing page's quote buttons on desktop and
// mobile, then the quote form on desktop, then on mobile - each ticked off as it ends
function StepChecklist({ funnel, live }: { funnel: Funnel; live?: Partial<Record<Device, LiveRun>> }) {
  const ui = funnel.ui_results;
  const uiState: StepState =
    funnel.ui_status === "running" ? "active"
      : !ui ? (funnel.ui_status === "error" ? "failed" : "pending")
        : Object.values(ui).every(r => r.status !== "error" && r.quote_buttons_working === r.quote_buttons_found) ? "passed" : "failed";
  const uiDetail = ui
    ? (["desktop", "mobile"] as const)
        .filter(d => ui[d])
        .map(d => {
          const r = ui[d];
          const label = d === "desktop" ? "Desktop" : "Mobile";
          if (r.status === "error") return `${label}: check failed`;
          return r.quote_buttons_found === 0
            ? `${label}: no quote buttons found`
            : `${label}: ${r.quote_buttons_working} of ${r.quote_buttons_found} working`;
        })
        .join(" · ")
    : funnel.ui_status === "running" ? "Counting and clicking every \"Get a quote\" button…" : "Not checked yet";

  const formStep = (device: Device): { state: StepState; detail: string } => {
    const testing = funnel.test_status === "running";
    if (testing) {
      const run = live?.[device];
      if (live && !run) return { state: "skipped", detail: "Not part of this test" };
      if (!run || run.status === "queued") {
        return { state: "pending", detail: device === "mobile" ? "Starts after desktop" : "Waiting for the landing page check" };
      }
      if (run.status === "running") {
        const { phase, detail } = deriveProgress(run.messages);
        return { state: "active", detail: `${phase}${detail ? ` - ${detail}` : ""}` };
      }
      return { state: run.status === "failed" ? "failed" : "active", detail: run.status === "failed" ? "Didn't finish" : "Finished, saving…" };
    }
    const r = deviceResult(funnel, device);
    if (!r) return { state: "pending", detail: "Not tested yet" };
    if (r.status === "passed") return { state: "passed", detail: `Form submitted${r.steps ? ` in ${r.steps} steps` : ""}` };
    const e = explainFailure(r.failure, (r as { site_problem?: string | null }).site_problem);
    return { state: "failed", detail: e ? e.title : "Didn't submit" };
  };

  const steps: { title: string; state: StepState; detail: string }[] = [
    { title: "Landing page - \"Get a quote\" buttons (desktop + mobile)", state: uiState, detail: uiDetail },
    { title: "Quote form - Desktop", ...formStep("desktop") },
    { title: "Quote form - Mobile", ...formStep("mobile") },
  ];

  return (
    <ol className="rounded-lg border bg-background p-3">
      {steps.map((s, i) => (
        <li key={i} className={`flex items-start gap-3 px-1 py-2 ${i > 0 ? "border-t" : ""} ${s.state === "active" ? "rounded bg-blue-50/60 dark:bg-blue-950/30" : ""}`}>
          <span className="mt-0.5 shrink-0">{STEP_ICON[s.state]}</span>
          <div className="min-w-0">
            <div className="text-sm font-medium">
              <span className="text-muted-foreground">{i + 1}. </span>{s.title}
            </div>
            <div className={`text-xs ${s.state === "failed" ? "text-red-600 dark:text-red-400" : "text-muted-foreground"}`}>{s.detail}</div>
          </div>
        </li>
      ))}
    </ol>
  );
}

function LiveStatusBadge({ run }: { run: LiveRun }) {
  const base = "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold";
  if (run.status === "queued") return <span className={`${base} bg-muted text-muted-foreground`}>Queued</span>;
  if (run.status === "running") {
    return isWaitingForOtp(run.messages) ? (
      <span className={`${base} bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-400`}>
        <RefreshCw className="h-3 w-3 animate-spin" /> Waiting for SMS code…
      </span>
    ) : (
      <span className={`${base} bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-400`}>
        <RefreshCw className="h-3 w-3 animate-spin" /> Running
      </span>
    );
  }
  if (run.status === "completed") return <span className={`${base} bg-muted text-muted-foreground`}>Done, saving…</span>;
  return <span className={`${base} ${resultColor("error")}`}>✕ Crashed</span>;
}

// The funnel tester dashboard's live run panel: phase + progress bar, what the
// browser is looking at right now, and the walker's colour-coded log
function LiveRunView({ run }: { run: LiveRun }) {
  const logRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [run.messages.length]);

  if (run.status === "queued") {
    return <p className="text-sm text-muted-foreground">Waiting for the other device to finish…</p>;
  }
  const { phase, detail, percent } = deriveProgress(run.messages);
  return (
    <div className="space-y-3">
      <div>
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-sm font-semibold">{phase}</span>
          <span className="text-xs text-muted-foreground">{detail}</span>
        </div>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-brand transition-all duration-700" style={{ width: `${percent}%` }} />
        </div>
      </div>
      {run.latestScreenshot && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={run.latestScreenshot}
          src={screenshotUrl(run.latestScreenshot)}
          alt="What the browser is looking at right now"
          className="max-h-72 w-full rounded-md border object-contain object-top"
        />
      )}
      <div ref={logRef} className="max-h-56 overflow-y-auto rounded-md bg-[#0b0f19] p-3 font-mono text-[11.5px] leading-relaxed">
        {run.messages.length === 0 && <div className="italic text-gray-500">starting…</div>}
        {run.messages.map((m, i) => {
          const { icon, className } = LOG_STYLE[classifyMessage(m)];
          return (
            <div key={i} className="flex gap-2">
              <span className={`shrink-0 ${className}`}>{icon}</span>
              <span className="break-all text-gray-300">{m}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DeviceDetail({ result, ui, title, icon: Icon, testing, live, uiRunning, uiMessage }: {
  result?: DeviceResult;
  ui?: UiResult;
  title: string;
  icon: any;
  testing: boolean;
  // This device's run while a test is going; absent when it isn't part of the run
  live?: LiveRun;
  uiRunning: boolean;
  uiMessage?: string;
}) {
  return (
    <div className="rounded-lg border bg-background p-4">
      <div className="mb-3 flex items-center gap-2 text-sm font-medium">
        <Icon className="h-4 w-4 text-muted-foreground" />
        {title}
        {testing ? (
          live && <span className="ml-auto"><LiveStatusBadge run={live} /></span>
        ) : result && (
          <span className={`ml-auto rounded-full px-2.5 py-0.5 text-xs font-semibold ${resultColor(result.status)}`}>
            {RESULT_LABEL[result.status]}
          </span>
        )}
      </div>
      {testing ? (
        live ? <LiveRunView run={live} /> : <p className="text-sm text-muted-foreground">Starting…</p>
      ) : !result ? (
        <p className="text-sm text-muted-foreground">Not tested yet.</p>
      ) : (
        <>
          <div className="mb-3">
            <FunnelStageMarks stages={deriveStages(result)} />
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
            <div className="flex flex-col">
              <span className="text-muted-foreground">Steps walked</span>
              <span className="font-medium">{result.steps ?? "—"}</span>
            </div>
            <div className="flex flex-col">
              <span className="text-muted-foreground">Google Tag Manager</span>
              <span className={`font-medium ${gtmMissing(result) ? "text-red-600" : ""}`}>
                {result.gtm_found == null ? "—" : result.gtm_found ? "Found" : "Not found"}
              </span>
            </div>
          </div>
          {result.status !== "passed" && (
            <ExplanationBox explanation={explainFailure(result.failure, result.site_problem)} raw={[result.site_problem, result.failure]} />
          )}
          {"results_buttons" in result && result.results_buttons && result.results_buttons.total === 0 && (
            <div className="mt-3 rounded-md border bg-muted/30 p-2 text-xs text-muted-foreground">
              Results-page buttons: none on this funnel&apos;s results page - skipped
            </div>
          )}
          {"results_buttons" in result && result.results_buttons && result.results_buttons.total > 0 && (
            <div className="mt-3 rounded-md border bg-muted/30 p-2 text-xs">
              <div>
                Results-page buttons:{" "}
                <span className={result.results_buttons.ok < result.results_buttons.total ? "font-semibold text-amber-600" : "font-semibold text-green-600 dark:text-green-400"}>
                  {result.results_buttons.ok} of {result.results_buttons.total} worked
                </span>
              </div>
              {result.results_buttons.failed.length > 0 && (
                <div className="mt-0.5 text-amber-700 dark:text-amber-400">Need a look: {result.results_buttons.failed.join(", ")}</div>
              )}
              <div className="mt-0.5 text-muted-foreground">Checkout payment: {result.results_buttons.payment}</div>
            </div>
          )}
          <div className="mt-2">
            <ReportLink id={result.report_id} label="Full test report with screenshots" />
          </div>
        </>
      )}

      <div className="mt-4 border-t pt-3">
        <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium">
          <MousePointerClick className="h-3.5 w-3.5 text-muted-foreground" /> UI check
        </div>
        {uiRunning ? (
          <p className="text-xs text-muted-foreground">{uiMessage || "Waiting to start..."}</p>
        ) : !ui ? (
          <p className="text-xs text-muted-foreground">Not checked yet.</p>
        ) : ui.status === "error" ? (
          <ExplanationBox explanation={explainFailure(ui.error || "Check did not finish")} raw={[ui.error]} />
        ) : (
          <div className="space-y-1 text-xs">
            <div>
              Quote buttons:{" "}
              <span className={ui.quote_buttons_working < ui.quote_buttons_found ? "font-medium text-red-600 dark:text-red-400" : "font-medium"}>
                {ui.quote_buttons_found === 0 ? "none found" : `${ui.quote_buttons_working} of ${ui.quote_buttons_found} working`}
              </span>
            </div>
            {ui.cta && (
              <div>
                Main button &quot;{ui.cta.label}&quot;:{" "}
                <span className={ui.cta.works ? "font-medium" : "font-medium text-red-600 dark:text-red-400"}>
                  {ui.cta.works ? "works" : "does nothing"}
                </span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function UiPill({ funnel }: { funnel: Funnel }) {
  if (funnel.ui_status === "running") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-100 px-2.5 py-1 text-xs font-medium text-blue-700 dark:bg-blue-950 dark:text-blue-400" title="UI check running">
        <MousePointerClick className="h-3 w-3 animate-pulse" />
      </span>
    );
  }
  if (!funnel.ui_status) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground" title="UI not checked yet">
        <MousePointerClick className="h-3 w-3" /> —
      </span>
    );
  }
  const results = funnel.ui_results ? Object.values(funnel.ui_results) : [];
  const problems = results.reduce(
    // Design remarks aren't counted - only quote buttons that don't work
    (n, r) => n + (r.quote_buttons_found - r.quote_buttons_working) + (r.cta && !r.cta.works ? 1 : 0),
    0
  );
  // Older checks were marked "issues" for design remarks alone - those are OK now
  const ok = funnel.ui_status === "ok" || (funnel.ui_status === "issues" && problems === 0);
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${
        ok
          ? "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-400"
          : funnel.ui_status === "error"
            ? "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400"
            : "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400"
      }`}
      title="UI check: quote buttons and visual problems"
    >
      <MousePointerClick className="h-3 w-3" />
      {ok ? "UI OK" : funnel.ui_status === "error" ? "Error" : `${problems} issue${problems === 1 ? "" : "s"}`}
    </span>
  );
}

export default function FunnelTestPage() {
  const supabase = useMemo(() => createClient(), []);
  const [funnels, setFunnels] = useState<Funnel[]>([]);
  const [domains, setDomains] = useState<DomainOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [clientFilter, setClientFilter] = useState("all");
  // Search and filters survive a refresh (in this browser) until they're cleared.
  // Restored after the first render so the server and browser render the same page.
  const [filtersRestored, setFiltersRestored] = useState(false);
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("funnel-test-filters") ?? "{}");
      if (typeof saved.search === "string") setSearchQuery(saved.search);
      if (typeof saved.status === "string") setStatusFilter(saved.status);
      if (typeof saved.client === "string") setClientFilter(saved.client);
    } catch {}
    setFiltersRestored(true);
  }, []);
  useEffect(() => {
    if (!filtersRestored) return;
    try {
      localStorage.setItem("funnel-test-filters", JSON.stringify({ search: searchQuery, status: statusFilter, client: clientFilter }));
    } catch {}
  }, [filtersRestored, searchQuery, statusFilter, clientFilter]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showAddForm, setShowAddForm] = useState(false);
  const [form, setForm] = useState({ name: "", url: "", domain_id: NO_CLIENT });
  const [saving, setSaving] = useState(false);
  const [checkingIds, setCheckingIds] = useState<Set<string>>(new Set());
  const [checkProgress, setCheckProgress] = useState<{ done: number; total: number } | null>(null);
  // Latest walker message per running funnel test
  const [testMessages, setTestMessages] = useState<Record<string, string>>({});
  const [testAllProgress, setTestAllProgress] = useState<{ done: number; total: number; current: string; avgMs?: number; startedAt?: number } | null>(null);
  // Live log, progress and screenshot of a running test, per funnel and device
  const [testLive, setTestLive] = useState<Record<string, Partial<Record<Device, LiveRun>>>>({});
  // Which device(s) Run test / Test all use, like the funnel tester's own "Both / Desktop / Mobile"
  const [deviceChoice, setDeviceChoiceState] = useState<DeviceChoice>("both");
  const setDeviceChoice = (choice: DeviceChoice) => {
    setDeviceChoiceState(choice);
    try { localStorage.setItem("funnel-test-devices", choice); } catch {}
  };
  // Which device's results the list shows (tests always run on both); remembered here
  const [resultView, setResultViewState] = useState<DeviceChoice>("both");
  const setResultView = (view: DeviceChoice) => {
    setResultViewState(view);
    try { localStorage.setItem("funnel-test-view", view); } catch {}
  };
  useEffect(() => {
    try {
      const saved = localStorage.getItem("funnel-test-view");
      if (saved === "both" || saved === "desktop" || saved === "mobile") setResultViewState(saved);
    } catch {}
  }, []);
  // The device picker is hidden for now, so tests always run on both - a choice
  // saved earlier must not silently narrow them
  const SHOW_DEVICE_CHOICE = false;
  useEffect(() => {
    if (!SHOW_DEVICE_CHOICE) return;
    try {
      const saved = localStorage.getItem("funnel-test-devices");
      if (saved === "both" || saved === "desktop" || saved === "mobile") setDeviceChoiceState(saved);
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [uiMessages, setUiMessages] = useState<Record<string, string>>({});
  const [uiAllProgress, setUiAllProgress] = useState<{ done: number; total: number; current: string } | null>(null);
  // The loop reads the ref; the state only drives the "Stopping..." note
  const stopTestAllRef = useRef(false);
  const [stopRequested, setStopRequested] = useState(false);

  const fetchData = async () => {
    setLoading(true);
    try {
      const [funnelsRes, domainsRes] = await Promise.all([
        supabase.from("funnels").select("*").order("name", { ascending: true }),
        supabase.from("domains").select("id, domain_name, display_name").order("domain_name", { ascending: true }),
      ]);

      if (funnelsRes.error) {
        // The table is created by migrations/add_funnels_table.sql
        if (funnelsRes.error.code === "42P01" || funnelsRes.error.message.includes("funnels")) {
          throw new Error("The funnels table does not exist yet. Run migrations/add_funnels_table.sql in the Supabase SQL Editor.");
        }
        throw funnelsRes.error;
      }
      if (domainsRes.error) throw domainsRes.error;

      setFunnels(funnelsRes.data || []);
      // Pick up walks that were still running when the page was last closed
      (funnelsRes.data || []).filter(f => f.test_status === "running").forEach(f => pollTest(f.id));
      (funnelsRes.data || []).filter(f => f.ui_status === "running").forEach(f => pollUiCheck(f.id));
      setDomains(domainsRes.data || []);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // SMS verification codes each test number has received today, against its daily limit
  // blockedAt: Twilio refused to send verification codes to this number (its
  // anti-fraud block); Twilio lifts these within 12 hours, and the tester tries the number again after that
  const [smsUsage, setSmsUsage] = useState<{ limit: number; numbers: { number: string; used: number; blockedAt?: string | null }[] } | null>(null);

  // One warning per test number that is blocked, used up or nearly used up today
  const smsWarnings = (() => {
    if (!smsUsage) return [] as { level: "red" | "amber"; text: string }[];
    const out: { level: "red" | "amber"; text: string }[] = [];
    const usable = smsUsage.numbers.filter(n => !n.blockedAt && n.used < smsUsage.limit);
    for (const n of smsUsage.numbers) {
      if (n.blockedAt) {
        out.push({
          level: "red",
          text: `${n.number} is temporarily blocked by Twilio from receiving verification codes (since ${new Date(n.blockedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}). Twilio blocks lift within 12 hours; the number is tried again at ${new Date(new Date(n.blockedAt).getTime() + 12 * 3600_000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}. Tests use the other number meanwhile.`,
        });
      } else if (n.used >= smsUsage.limit) {
        out.push({ level: "red", text: `${n.number} has used all ${smsUsage.limit} of today's SMS codes. Tests use the other number until tomorrow.` });
      } else if (n.used >= Math.ceil(smsUsage.limit * 0.75)) {
        out.push({ level: "amber", text: `${n.number} has used ${n.used} of its ${smsUsage.limit} SMS codes today - nearly at the limit.` });
      }
    }
    if (smsUsage.numbers.length > 0 && usable.length === 0) {
      out.unshift({ level: "red", text: "No test number can receive SMS codes right now. Tests are paused until a number is free again, so the block isn’t made longer." });
    }
    return out;
  })();
  // Added to the "Test …?" confirmations so nobody starts tests without knowing
  const smsWarningText = smsWarnings.length ? `\n\n⚠ SMS numbers:\n${smsWarnings.map(w => `• ${w.text}`).join("\n")}` : "";

  // The warnings pop up by themselves when one appears that hasn't been seen today
  // (e.g. a number gets blocked during Test all); "OK, got it" remembers them
  const [smsPopupOpen, setSmsPopupOpen] = useState(false);
  const smsWarningKey = smsWarnings.map(w => w.text.replace(/\(since [^)]*\)/, "")).join("|");
  useEffect(() => {
    if (!smsWarningKey) return;
    let seen = "";
    try { seen = localStorage.getItem(`funnel-test-sms-warnings-${new Date().toDateString()}`) ?? ""; } catch {}
    const seenSet = new Set(seen.split("|"));
    if (smsWarningKey.split("|").some(w => !seenSet.has(w))) setSmsPopupOpen(true);
  }, [smsWarningKey]);
  const dismissSmsPopup = () => {
    setSmsPopupOpen(false);
    try {
      const key = `funnel-test-sms-warnings-${new Date().toDateString()}`;
      const seen = new Set((localStorage.getItem(key) ?? "").split("|").filter(Boolean));
      smsWarningKey.split("|").forEach(w => seen.add(w));
      localStorage.setItem(key, Array.from(seen).join("|"));
    } catch {}
  };
  const loadSmsUsage = async () => {
    try {
      const res = await fetch("/api/funnels/sms-usage");
      if (res.ok) setSmsUsage(await res.json());
    } catch {
      // the tester may be offline; the rest of the page still works
    }
  };

  useEffect(() => {
    fetchData();
    loadSmsUsage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const domainById = useMemo(() => new Map(domains.map(d => [d.id, d])), [domains]);

  const clientName = (funnel: Funnel) => {
    const client = funnel.domain_id ? domainById.get(funnel.domain_id) : undefined;
    return client ? client.display_name || client.domain_name : null;
  };

  const filteredFunnels = useMemo(() => {
    const q = searchQuery.toLowerCase();

    return funnels.filter(funnel => {
      const client = clientName(funnel);
      const matchesSearch =
        !q ||
        funnel.name.toLowerCase().includes(q) ||
        funnel.url.toLowerCase().includes(q) ||
        (client !== null && client.toLowerCase().includes(q));

      const matchesStatus =
        statusFilter === "all" ||
        (statusFilter === "up" && funnel.last_status === true) ||
        (statusFilter === "down" && funnel.last_status === false) ||
        (statusFilter === "unchecked" && funnel.last_status === null) ||
        // Test results filter whole websites (see visibleSites), not single funnels
        SITE_FILTERS.includes(statusFilter);

      const matchesClient =
        clientFilter === "all" ||
        (clientFilter === NO_CLIENT_LABEL ? client === null : client === clientFilter);

      return matchesSearch && matchesStatus && matchesClient;
    }).sort((a, b) => a.name.localeCompare(b.name));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [funnels, domainById, searchQuery, statusFilter, clientFilter]);

  const toggleExpand = (id: string) =>
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // The test-result ones count websites, like the summary cards above the list
  const statusFilters: { id: string; name: string; count?: number }[] = [
    { id: "all", name: "All results", count: funnels.length },
    { id: "passed", name: "All working" },
    { id: "failed", name: "Problems" },
    { id: "untested", name: "Not tested yet" },
    { id: "up", name: "Page up", count: funnels.filter(f => f.last_status === true).length },
    { id: "down", name: "Page down", count: funnels.filter(f => f.last_status === false).length },
    { id: "unchecked", name: "Page not checked", count: funnels.filter(f => f.last_status === null).length },
  ];

  const clientOptions = Array.from(new Set(funnels.map(f => clientName(f) ?? NO_CLIENT_LABEL))).sort();

  const addFunnel = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSuccess("");

    // A website is added by its name and landing page; its quote funnels (boiler,
    // air con, solar...) are then found on that page and added with it, so it's
    // tested like every client website
    const name = form.name.trim();
    let url = form.url.trim();
    if (!name || !url) {
      setError("Website name and landing page are required");
      return;
    }
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    let host: string;
    try {
      host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    } catch {
      setError("Please enter a valid landing page URL");
      return;
    }
    const existing = funnels.find(f => hostOf(f) === host);
    if (existing) {
      setError(`${host} is already in the list (${existing.name})`);
      return;
    }

    setSaving(true);
    try {
      const { data, error } = await supabase
        .from("funnels")
        .insert({ name, url, domain_id: null })
        .select()
        .single();
      if (error) throw error;
      setFunnels(prev => [...prev, data].sort((a, b) => a.name.localeCompare(b.name)));
      setForm({ name: "", url: "", domain_id: NO_CLIENT });
      setShowAddForm(false);
      setSuccess(`${name} added - looking for its quote funnels…`);
      checkFunnel(data.id);

      const res = await fetch("/api/funnels/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ site: { name, url } }),
      });
      const found = await res.json();
      if (!res.ok) throw new Error(found.error || "Couldn't look for the website's quote funnels");
      const { data: all } = await supabase.from("funnels").select("*").order("name", { ascending: true });
      if (all) setFunnels(all);
      const added: { name: string }[] = found.added ?? [];
      setSuccess(
        added.length > 0
          ? `${name} added with ${added.length} quote funnel${added.length === 1 ? "" : "s"}: ${added.map(a => a.name.split(" - ").slice(1).join(" - ") || a.name).join(", ")}`
          : `${name} added. No separate quote pages were found, so its landing page will be tested`
      );
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const deleteFunnel = async (funnel: Funnel) => {
    if (!window.confirm(`Delete "${funnel.name}" from funnel testing?\n\nIts saved test reports go too. The domain stays in uptime monitoring.`)) return;
    const { error } = await supabase.from("funnels").delete().eq("id", funnel.id);
    if (error) {
      setError(error.message);
      return;
    }
    setFunnels(prev => prev.filter(f => f.id !== funnel.id));
    setSuccess(`Funnel "${funnel.name}" deleted`);
  };

  // Check one funnel and update its row in place. Resolves to true when the check ran.
  const checkFunnel = async (id: string) => {
    setCheckingIds(prev => new Set(prev).add(id));
    try {
      const res = await fetch("/api/funnels/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ funnelId: id }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(res.status === 401 ? "Your session has expired. Please sign in again." : data.error);
      }

      setFunnels(prev => prev.map(f => f.id === id ? {
        ...f,
        last_status: data.status,
        last_status_code: data.status_code,
        last_response_time: data.response_time,
        last_error: data.error,
        last_checked_at: data.checked_at,
      } : f));
      return true;
    } catch (err: any) {
      setError(err.message);
      return false;
    } finally {
      setCheckingIds(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const checkAll = async () => {
    const list = filteredFunnels;
    if (list.length === 0) return;
    setError("");
    setSuccess("");
    setCheckProgress({ done: 0, total: list.length });

    let next = 0;
    let failures = 0;
    const worker = async () => {
      while (next < list.length) {
        const funnel = list[next++];
        if (!(await checkFunnel(funnel.id))) failures++;
        setCheckProgress(p => p && { ...p, done: p.done + 1 });
      }
    };
    await Promise.all(Array.from({ length: Math.min(CHECK_CONCURRENCY, list.length) }, worker));

    setCheckProgress(null);
    if (failures === 0) setSuccess(`Checked ${list.length} ${list.length === 1 ? "funnel" : "funnels"}`);
  };

  const replaceFunnel = (updated: Funnel) =>
    setFunnels(prev => prev.map(f => f.id === updated.id ? updated : f));

  // Follow a running walk until it ends. Resolves to the finished funnel row, or
  // null if polling failed (the error is shown on the page).
  const pollTest = async (id: string): Promise<Funnel | null> => {
    while (true) {
      try {
        const res = await fetch(`/api/funnels/test/status?funnelId=${encodeURIComponent(id)}`);
        const data = await res.json();
        if (!res.ok) {
          throw new Error(res.status === 401 ? "Your session has expired. Please sign in again." : data.error);
        }

        replaceFunnel(data.funnel);
        if (data.funnel.test_status !== "running") {
          setTestMessages(prev => {
            const { [id]: _, ...rest } = prev;
            return rest;
          });
          setTestLive(prev => {
            const { [id]: _, ...rest } = prev;
            return rest;
          });
          loadSmsUsage();
          return data.funnel;
        }
        if (data.message) setTestMessages(prev => ({ ...prev, [id]: data.message }));
        if (data.live) setTestLive(prev => ({ ...prev, [id]: data.live }));
      } catch (err: any) {
        setError(err.message);
        return null;
      }
      await sleep(TEST_POLL_MS);
    }
  };

  // The funnel a bulk run is on right now, so its Stop can end that test immediately
  const bulkCurrentRef = useRef<{ id: string; name: string } | null>(null);

  // Funnels stopped with a Stop button during this session, so a run in progress
  // doesn't carry on to its next stage
  const stoppedIdsRef = useRef<Set<string>>(new Set());

  // Run one funnel strictly one thing at a time, never two browsers at once:
  //   1. homepage - count every "Get a quote" button and check each one works
  //      (no forms submitted; skipped when this site was just checked)
  //   2. desktop - walk the funnel and submit; it finishes as soon as it's submitted
  //   3. mobile - the same
  // Resolves to the funnel once done, or null if it couldn't start.
  const runTest = async (funnel: Funnel, withUiCheck = true, ignoreCooldown = false): Promise<Funnel | null> => {
    stoppedIdsRef.current.delete(funnel.id);
    const stopped = () => stoppedIdsRef.current.has(funnel.id) || stopTestAllRef.current;

    if (withUiCheck && funnel.test_status !== "running") {
      setTestMessages(prev => ({ ...prev, [funnel.id]: "Checking the homepage's quote buttons first..." }));
      await runUiCheck(funnel);
      if (stopped()) return null;
    }

    if (funnel.test_status !== "running") {
      try {
        const res = await fetch("/api/funnels/test", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ funnelId: funnel.id, viewports: DEVICES_FOR_CHOICE[deviceChoice], withUiCheck: false, ignoreCooldown }),
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(res.status === 401 ? "Your session has expired. Please sign in again." : data.error);
        }
        replaceFunnel({
          ...funnel,
          test_status: "running",
          test_failure: null,
          test_steps: null,
          test_tracking_ok: null,
          test_results: null,
          test_started_at: data.started_at,
          test_finished_at: null,
        });
        setTestMessages(prev => ({ ...prev, [funnel.id]: "Starting..." }));
      } catch (err: any) {
        setError(err.message);
        // No test number can get SMS codes now (Twilio block / daily limit): end a
        // Test all here instead of trying every remaining funnel and failing each
        if (/test phone number/i.test(err.message ?? "")) stopTestAllRef.current = true;
        return null;
      }
    }
    return pollTest(funnel.id);
  };

  // Stop a running test and its UI check; the polling loops see the stopped status and end
  const [stoppingIds, setStoppingIds] = useState<Set<string>>(new Set());
  const stopTest = async (funnel: { id: string; name: string }, ask = true) => {
    if (ask && !window.confirm(`Stop the test on "${funnel.name}"?\n\nThe walker stops after the step it's on. Anything it has already submitted stays submitted. If an SMS code is on its way, it enters that code first, so the code isn't wasted (wasted codes get the test numbers blocked by Twilio).`)) return;
    stoppedIdsRef.current.add(funnel.id);
    setStoppingIds(prev => new Set(prev).add(funnel.id));
    try {
      const res = await fetch("/api/funnels/test/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ funnelId: funnel.id }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(res.status === 401 ? "Your session has expired. Please sign in again." : data.error);
      }
      replaceFunnel(data.funnel);
      setSuccess(`Stopped the test on "${funnel.name}"`);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setStoppingIds(prev => {
        const next = new Set(prev);
        next.delete(funnel.id);
        return next;
      });
    }
  };

  // Stop "Test all" / "UI check all": end the loop and stop the funnel it's on right
  // now rather than letting it finish
  const stopBulk = () => {
    stopTestAllRef.current = true;
    setStopRequested(true);
    if (bulkCurrentRef.current) stopTest(bulkCurrentRef.current, false);
  };

  const leadCount = DEVICES_FOR_CHOICE[deviceChoice].length;
  const deviceText = deviceChoice === "both" ? "on desktop and then mobile" : `on ${deviceChoice}`;
  const REAL_LEAD_WARNING =
    `1. Homepage: counts every "Get a quote" button and checks each one works (nothing submitted).\n` +
    `2. Then the funnel is filled in and submitted for real ${deviceText} - ` +
    `${leadCount} real lead${leadCount === 1 ? "" : "s"} per funnel on the client's site.\n` +
    `3. After submitting, any results-page buttons the site has (Save quote, Book, Checkout...) are clicked and their follow-up forms completed - this can create extra leads; checkout uses Stripe's test card. A results page without them is skipped.\n` +
    `One thing runs at a time.`;

  const testOne = (funnel: Funnel) => {
    // Tested within the hour: say so and let the person decide, instead of refusing
    const left = cooldownLeft(funnel);
    const ago = funnel.test_finished_at ? formatTimeAgo(funnel.test_finished_at).toLowerCase() : "";
    const ask = left > 0
      ? `"${funnel.name}" was tested ${ago}. To protect the test phone numbers from being blocked by Twilio, tests normally wait ${minutesText(RETEST_COOLDOWN_MIN)} (${minutesText(left)} left).\n\nTest it again anyway?\n\n${REAL_LEAD_WARNING}`
      : `Test "${funnel.name}"?\n\n${REAL_LEAD_WARNING}`;
    if (!window.confirm(ask + smsWarningText)) return;
    setError("");
    setSuccess("");
    // Open the row so the live progress is in view
    setExpanded(prev => new Set(prev).add(funnel.id));
    runTest(funnel, true, left > 0);
  };

  // Test funnels strictly one after another: one site's (from its row) or every
  // site's in the list (from the toolbar). Each starts from the site's homepage.
  // askAboutRecent: a person pressed Run test on one website - ask whether to include
  // its funnels tested within the hour. Test all / Test next 5 just skip those.
  const testAll = async (only?: Funnel[], siteLabel?: string, askAboutRecent = false) => {
    // Without a list: every funnel of the websites the list is showing
    const list = only ?? visibleSites.flatMap(g => testableFunnels(g.funnels));
    if (list.length === 0) return;
    const what = `${list.length} ${list.length === 1 ? "funnel" : "funnels"}${siteLabel ? ` on ${siteLabel}` : ""}`;
    const recent = list.filter(f => cooldownLeft(f) > 0);
    const avgMs = typicalTestMs();
    const toRun = list.length - (askAboutRecent ? 0 : recent.length);
    const estimate = avgMs && toRun > 0 ? `\nThis takes about ${formatDuration(avgMs * toRun)}.` : "\nEach test can take a few minutes.";
    if (!window.confirm(`Test ${what} one by one?\n\n${REAL_LEAD_WARNING}${estimate}${smsWarningText}`)) return;
    let includeRecent = false;
    if (recent.length > 0 && askAboutRecent) {
      includeRecent = window.confirm(
        `${recent.length} of these ${recent.length === 1 ? "was" : "were"} tested in the last ${minutesText(RETEST_COOLDOWN_MIN)} (${recent.map(f => f.name).join(", ")}).\n\nOK = test ${recent.length === 1 ? "it" : "them"} again too\nCancel = skip ${recent.length === 1 ? "it" : "them"}`
      );
    }

    setError("");
    setSuccess("");
    stopTestAllRef.current = false;
    setStopRequested(false);
    let passed = 0;
    let done = 0;
    let skipped = 0;
    const startedAt = Date.now();
    const uiCheckedHosts = new Set<string>();

    for (const funnel of list) {
      if (stopTestAllRef.current) break;
      // Tested within the hour: skipped (unless the person chose to include them)
      if (!includeRecent && cooldownLeft(funnel) > 0) {
        skipped++;
        done++;
        continue;
      }
      setTestAllProgress({ done, total: list.length, current: funnel.name, avgMs: avgMs ?? undefined, startedAt });
      // Open the site and the funnel so the live progress is in view
      setExpanded(prev => new Set(prev).add(funnel.id).add(`site:${hostOf(funnel)}`));
      bulkCurrentRef.current = { id: funnel.id, name: funnel.name };
      // The UI check looks at the site's homepage, so once per site is enough
      const host = hostOf(funnel);
      const result = await runTest(funnel, !uiCheckedHosts.has(host), includeRecent);
      uiCheckedHosts.add(host);
      if (result?.test_status === "passed") passed++;
      done++;
    }

    bulkCurrentRef.current = null;
    setTestAllProgress(null);
    const stopped = done < list.length ? ` (stopped after ${done} of ${list.length})` : "";
    const skippedNote = skipped ? ` · ${skipped} skipped (tested in the last ${minutesText(RETEST_COOLDOWN_MIN)})` : "";
    setSuccess(`Funnel tests finished: ${passed} of ${done - skipped} passed${stopped}${skippedNote} · took ${formatDuration(Date.now() - startedAt)}`);
  };

  // Follow a running UI check until it ends, like pollTest
  const pollUiCheck = async (id: string): Promise<Funnel | null> => {
    while (true) {
      try {
        const res = await fetch(`/api/funnels/ui-check/status?funnelId=${encodeURIComponent(id)}`);
        const data = await res.json();
        if (!res.ok) {
          throw new Error(res.status === 401 ? "Your session has expired. Please sign in again." : data.error);
        }

        replaceFunnel(data.funnel);
        if (data.funnel.ui_status !== "running") {
          setUiMessages(prev => {
            const { [id]: _, ...rest } = prev;
            return rest;
          });
          return data.funnel;
        }
        if (data.message) setUiMessages(prev => ({ ...prev, [id]: data.message }));
      } catch (err: any) {
        setError(err.message);
        return null;
      }
      await sleep(TEST_POLL_MS);
    }
  };

  const runUiCheck = async (funnel: Funnel): Promise<Funnel | null> => {
    if (funnel.ui_status !== "running") {
      try {
        const res = await fetch("/api/funnels/ui-check", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ funnelId: funnel.id }),
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(res.status === 401 ? "Your session has expired. Please sign in again." : data.error);
        }
        replaceFunnel({ ...funnel, ui_status: "running", ui_results: null });
        setUiMessages(prev => ({ ...prev, [funnel.id]: "Starting..." }));
      } catch (err: any) {
        setError(err.message);
        return null;
      }
    }
    return pollUiCheck(funnel.id);
  };

  const uiCheckOne = (funnel: Funnel) => {
    setError("");
    setSuccess("");
    runUiCheck(funnel);
  };

  // Look through every client site for its service funnels (boiler, ASHP, air con,
  // solar, battery...) and add the missing ones. Reads pages only, submits nothing.
  const [discovering, setDiscovering] = useState(false);
  const findFunnels = async () => {
    setError("");
    setSuccess("");
    setDiscovering(true);
    try {
      const res = await fetch("/api/funnels/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(res.status === 401 ? "Your session has expired. Please sign in again." : data.error);
      }
      const marked: string[] = data.markedChoosers ?? [];
      setSuccess(
        (data.added.length
          ? `Checked ${data.checked} sites and added ${data.added.length} new funnel${data.added.length === 1 ? "" : "s"}: ${data.added.slice(0, 6).map((a: { name: string }) => a.name).join(", ")}${data.added.length > 6 ? ", …" : ""}`
          : `Checked ${data.checked} sites - no new funnels found`) +
        (marked.length ? `. Marked ${marked.length} chooser page${marked.length === 1 ? "" : "s"} (tested through their services instead).` : "")
      );
      if (data.added.length || marked.length) await fetchData();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setDiscovering(false);
    }
  };

  // UI-check every funnel in the list, one after another (no leads are created)
  const uiCheckAll = async () => {
    const list = filteredFunnels;
    if (list.length === 0) return;
    if (!window.confirm(`Run the UI check on ${list.length} ${list.length === 1 ? "funnel" : "funnels"} one by one?\n\nIt clicks each quote button and looks for visual problems on mobile and desktop. No forms are submitted.`)) return;

    setError("");
    setSuccess("");
    stopTestAllRef.current = false;
    setStopRequested(false);
    let ok = 0;
    let done = 0;

    for (const funnel of list) {
      if (stopTestAllRef.current) break;
      setUiAllProgress({ done, total: list.length, current: funnel.name });
      bulkCurrentRef.current = { id: funnel.id, name: funnel.name };
      const result = await runUiCheck(funnel);
      if (result?.ui_status === "ok") ok++;
      done++;
    }

    bulkCurrentRef.current = null;
    setUiAllProgress(null);
    const stopped = done < list.length ? ` (stopped after ${done} of ${list.length})` : "";
    setSuccess(`UI checks finished: ${ok} of ${done} with no problems${stopped}`);
  };

  // Test all and UI check all share the progress bar and Stop button
  const bulkProgress = testAllProgress ?? uiAllProgress;
  const bulkLabel = testAllProgress ? "Testing" : "UI checking";

  // One funnel: its pills, Run test / Stop, and the expandable device panels.
  // nested = shown inside its site's group, labelled by service only.
  // One funnel inside a website: its service, how each device did, and its actions
  const renderFunnelRow = (funnel: Funnel) => {
      const isTesting = funnel.test_status === "running";
      const isExpanded = expanded.has(funnel.id);
      const lastTested = funnel.test_finished_at;
      const live = testLive[funnel.id];
      const testingOn = (device: Device) => isTesting && (!live || !!live[device]);
      const reason = funnelState(funnel) === "failed" ? failureReason(funnel) : null;
      return (
        <div key={funnel.id}>
          <div
            className="flex cursor-pointer flex-wrap items-center gap-3 py-3 pl-12 pr-4 hover:bg-muted/50"
            onClick={() => toggleExpand(funnel.id)}
          >
            <StateIcon state={funnelState(funnel)} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{serviceLabel(funnel)}</div>
              {reason ? (
                <div className="truncate text-xs text-red-600 dark:text-red-400">{reason}</div>
              ) : (
                <div className="truncate text-xs text-muted-foreground">{funnel.url}</div>
              )}
            </div>
            <div className="flex items-center gap-2">
              <DevicePill result={deviceResult(funnel, "desktop")} testing={testingOn("desktop")} icon={Monitor} />
              <DevicePill result={deviceResult(funnel, "mobile")} testing={testingOn("mobile")} icon={Smartphone} />
            </div>
            {lastTested && !isTesting && (
              <span className="hidden w-36 text-right text-xs text-muted-foreground md:inline">
                {formatTimeAgo(lastTested)}
                {testDurationMs(funnel) !== null && ` · took ${formatDuration(testDurationMs(funnel)!)}`}
              </span>
            )}
            {isTesting || funnel.ui_status === "running" ? (
              <Button
                size="sm"
                variant="outline"
                className="text-red-600"
                disabled={stoppingIds.has(funnel.id)}
                onClick={e => {
                  e.stopPropagation();
                  stopTest(funnel);
                }}
                title="Stop this test"
              >
                <Square className="mr-1.5 h-3.5 w-3.5" />
                {stoppingIds.has(funnel.id) ? "Stopping…" : "Stop"}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                disabled={!!bulkProgress}
                onClick={e => {
                  e.stopPropagation();
                  testOne(funnel);
                }}
              >
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                Run test
              </Button>
            )}
            {isExpanded ? (
              <ChevronUp className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            )}
          </div>
          {isTesting && testMessages[funnel.id] && (
            <div className="truncate pb-3 pl-12 pr-4 text-xs text-blue-600 dark:text-blue-400" title={testMessages[funnel.id]}>
              {testMessages[funnel.id]}
            </div>
          )}
          {isExpanded && renderFunnelDetail(funnel)}
        </div>
      );
  };

  // Everything about one funnel: the 3 test steps, each device's result, and actions
  const renderFunnelDetail = (funnel: Funnel) => {
      const isTesting = funnel.test_status === "running";
      const isChecking = checkingIds.has(funnel.id);
      const lastTested = funnel.test_finished_at;
      const client = clientName(funnel);
      const live = testLive[funnel.id];
      // A device is part of the running test unless the live data says otherwise
      // (Desktop-only or Mobile-only runs leave the other device's last result alone)
      const testingOn = (device: Device) => isTesting && (!live || !!live[device]);
      return (
            <div className="space-y-3 border-t bg-muted/30 p-4">
              <StepChecklist funnel={funnel} live={live} />
              <div className="grid gap-3 lg:grid-cols-2">
                {(["desktop", "mobile"] as const).map(device => {
                  const label = device === "mobile" ? "Mobile" : "Desktop";
                  return (
                    <DeviceDetail
                      key={device}
                      result={deviceResult(funnel, device)}
                      ui={funnel.ui_results?.[device]}
                      title={label}
                      icon={device === "mobile" ? Smartphone : Monitor}
                      testing={testingOn(device)}
                      live={live?.[device]}
                      uiRunning={funnel.ui_status === "running"}
                      uiMessage={uiMessages[funnel.id]?.startsWith(`${label}:`) ? uiMessages[funnel.id] : undefined}
                    />
                  );
                })}
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
                <span>Client: <span className="text-foreground">{client ?? "Not set"}</span></span>
                <span>
                  Page:{" "}
                  <span className="text-foreground">
                    {funnel.last_status === null
                      ? "not checked"
                      : funnel.last_status
                        ? `up${funnel.last_response_time !== null ? ` (${funnel.last_response_time}ms)` : ""}`
                        : `down${funnel.last_error ? ` (${funnel.last_error})` : ""}`}
                  </span>
                  {funnel.last_checked_at && ` · ${formatTimeAgo(funnel.last_checked_at)}`}
                </span>
                {lastTested && (
                  <span>Last test: <span className="text-foreground">{new Date(lastTested).toLocaleString()}</span></span>
                )}
                <div className="ml-auto flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={funnel.ui_status === "running" || !!bulkProgress}
                    onClick={() => uiCheckOne(funnel)}
                    title="Click every quote button and look for visual problems (no forms submitted)"
                  >
                    <MousePointerClick className="mr-1.5 h-3.5 w-3.5" />
                    {funnel.ui_status === "running" ? "Checking UI…" : "UI check"}
                  </Button>
                  <Button size="sm" variant="outline" disabled={isChecking} onClick={() => { setError(""); checkFunnel(funnel.id); }}>
                    <Globe className="mr-1.5 h-3.5 w-3.5" />
                    {isChecking ? "Checking…" : "Check page"}
                  </Button>
                  <Button size="sm" variant="outline" asChild>
                    <a href={funnel.url} target="_blank" rel="noopener noreferrer">
                      <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
                      Open
                    </a>
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-red-600"
                    disabled={isTesting || funnel.ui_status === "running"}
                    onClick={() => deleteFunnel(funnel)}
                    title="Remove this funnel from funnel testing"
                  >
                    <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                    Remove
                  </Button>
                </div>
              </div>
            </div>
      );
  };

  // ---- One row per website, with its funnels inside -------------------------

  const hostOf = (f: Funnel) => {
    try {
      return new URL(f.url).hostname.replace(/^www\./, "").toLowerCase();
    } catch {
      return f.url;
    }
  };
  const isHomepage = (f: Funnel) => {
    try {
      return new URL(f.url).pathname.replace(/\/+$/, "") === "";
    } catch {
      return false;
    }
  };
  // "Air Conditioning" rather than "ACF Plumbing and Heating - Air Conditioning"
  const serviceLabel = (f: Funnel) =>
    isHomepage(f) ? "Homepage" : f.name.includes(" - ") ? f.name.split(" - ").slice(1).join(" - ") : f.name;

  interface SiteGroup {
    key: string;
    label: string;
    url: string;
    funnels: Funnel[];
  }

  const groupSites = (list: Funnel[]): SiteGroup[] => {
    const byHost = new Map<string, Funnel[]>();
    for (const f of list) {
      const host = hostOf(f);
      byHost.set(host, [...(byHost.get(host) ?? []), f]);
    }
    return Array.from(byHost.entries())
      .map(([host, list]) => {
        const home = list.find(isHomepage) ?? null;
        const funnelsInSite = [...list].sort((a, b) =>
          isHomepage(a) ? -1 : isHomepage(b) ? 1 : serviceLabel(a).localeCompare(serviceLabel(b))
        );
        const first = funnelsInSite[0];
        return {
          key: host,
          label: home?.name ?? clientName(first) ?? (first.name.split(" - ")[0] || host),
          url: home?.url ?? `https://${host}/`,
          funnels: funnelsInSite,
        };
      })
      .sort((a, b) => a.label.localeCompare(b.label));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const siteGroups = useMemo(() => groupSites(filteredFunnels), [filteredFunnels, domainById]);
  // Every site, whatever the filters - for the summary cards
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const allSiteGroups = useMemo(() => groupSites(funnels), [funnels, domainById]);

  // What "test this site" runs: every specific funnel (each entered from the homepage).
  // The bare homepage entry is only tested when a site has no specific funnels, since
  // otherwise it just repeats whichever funnel the walker would pick first.
  // Chooser pages (no form, just cards to each service's form) are skipped the same
  // way: each of their services is tested on its own.
  const candidateFunnels = (list: Funnel[]) => {
    const hostsWithFunnels = new Set(list.filter(f => !isHomepage(f) && !isChooserFunnel(f)).map(hostOf));
    return list.filter(f => !isChooserFunnel(f) && (!isHomepage(f) || !hostsWithFunnels.has(hostOf(f))));
  };
  // ...minus the funnels switched off on the website's report page
  const testableFunnels = (list: Funnel[]) => candidateFunnels(list).filter(f => f.test_enabled !== false);

  // ---- Plain status of a funnel and a website, for the list and the summary --
  // The devices whose results the list is showing
  const viewDevices: Device[] = resultView === "both" ? ["desktop", "mobile"] : [resultView];

  type FunnelState = "running" | "passed" | "failed" | "untested";
  const funnelState = (f: Funnel): FunnelState => {
    if (f.test_status === "running" || f.ui_status === "running") return "running";
    const base: FunnelState =
      resultView === "both"
        ? f.test_status === "passed"
          ? "passed"
          : f.test_status === "failed" || f.test_status === "error"
            ? "failed"
            : "untested"
        : (() => {
            const r = deviceResult(f, resultView);
            return !r ? "untested" : r.status === "passed" ? "passed" : "failed";
          })();
    // "Working" only when every stage worked - a submitted form whose thank-you
    // page buttons (Save quote, Checkout) failed isn't working
    if (base === "passed") {
      const stages = funnelStages(f);
      if (stages && Object.values(stages).includes("failed")) return "failed";
      // ...nor one whose site has no Google Tag Manager
      if (viewDevices.some(d => gtmMissing(deviceResult(f, d)))) return "failed";
    }
    return base;
  };

  // Form → SMS → Thank-you → Save & Checkout for the devices being shown
  const funnelStages = (f: Funnel): FunnelStages | null =>
    combineStages(
      viewDevices
        .map(d => deviceResult(f, d))
        .filter((r): r is NonNullable<DeviceResult> => !!r)
        .map(r => deriveStages(r))
    );

  // Why a funnel failed, in plain words, from the first device that failed
  const failureReason = (f: Funnel): string | null => {
    for (const device of viewDevices) {
      const r = deviceResult(f, device);
      if (r && r.status !== "passed") {
        const why = explainFailure(r.failure, r.site_problem);
        if (why) return `${device === "desktop" ? "Desktop" : "Mobile"}: ${why.title}`;
      }
    }
    // Form went through, but a thank-you page button didn't work
    for (const device of viewDevices) {
      const b = deviceResult(f, device)?.results_buttons;
      if (b && b.total > 0 && b.ok < b.total) {
        return `${device === "desktop" ? "Desktop" : "Mobile"}: thank-you page button${b.failed.length === 1 ? "" : "s"} not working: ${b.failed.join(", ")}`;
      }
    }
    // Everything worked, but the site has no Google Tag Manager
    if (viewDevices.some(d => gtmMissing(deviceResult(f, d)))) return GTM_MISSING;
    return null;
  };

  type SiteState = "running" | "failed" | "passed" | "partial" | "untested";
  const siteSummary = (g: SiteGroup) => {
    const toTest = testableFunnels(g.funnels);
    const states = toTest.map(funnelState);
    const running = g.funnels.find(f => funnelState(f) === "running");
    const passed = states.filter(s => s === "passed").length;
    const failed = states.filter(s => s === "failed").length;
    const untested = states.filter(s => s === "untested").length;
    const state: SiteState = running
      ? "running"
      : failed > 0
        ? "failed"
        : untested === 0 && passed > 0
          ? "passed"
          : passed > 0
            ? "partial"
            : "untested";
    // Only funnels that count: a tested homepage on a site whose real funnel is
    // untested made the row say "Not tested yet" and "Tested 1d ago" together
    const lastTested = toTest
      .map(f => f.test_finished_at)
      .filter((d): d is string => !!d)
      .sort()
      .pop();
    return { toTest, running, passed, failed, untested, state, lastTested };
  };

  // A typical funnel test's length (median of finished tests, landing page check
  // included), for "This takes about…" and the time left during Test all
  const typicalTestMs = () => {
    const times = funnels.map(testDurationMs).filter((ms): ms is number => ms !== null).sort((a, b) => a - b);
    if (times.length === 0) return null;
    // + about a minute for the landing page check that runs before each website
    return times[Math.floor(times.length / 2)] + 60_000;
  };

  // Added on this page by name and landing page, rather than a monitored client
  const isManualSite = (g: SiteGroup) => g.funnels.every(f => !f.domain_id);

  // The websites the list shows: the search/client filters, then the result filter
  // on each whole website - matching the summary cards
  const visibleSites = siteGroups.filter(g => {
    if (!SITE_FILTERS.includes(statusFilter)) return true;
    const s = siteSummary(g);
    return statusFilter === "passed" ? s.state === "passed" : statusFilter === "failed" ? s.state === "failed" : s.untested > 0;
  });

  // "Test next 5 sites": the sites in the list never tested, then the ones tested
  // longest ago - so pressing it again and again works through every site in turn.
  // A site counts as tested as of its oldest funnel test (any untested funnel = never).
  const SITES_PER_BATCH = 5;
  const testNextSites = () => {
    const lastTested = (g: SiteGroup) => {
      const times = testableFunnels(g.funnels).map(f => (f.test_finished_at ? new Date(f.test_finished_at).getTime() : 0));
      return times.length ? Math.min(...times) : Infinity;
    };
    const next = visibleSites
      .filter(g => testableFunnels(g.funnels).length > 0)
      .sort((a, b) => lastTested(a) - lastTested(b))
      .slice(0, SITES_PER_BATCH);
    if (next.length === 0) return;
    testAll(
      next.flatMap(g => testableFunnels(g.funnels)),
      `${next.length} site${next.length === 1 ? "" : "s"} (${next.map(g => g.label).join(", ")})`
    );
  };

  // Remove a website and every one of its funnels from funnel testing (their saved
  // reports go with them). The domain itself stays in uptime monitoring.
  const deleteSite = async (g: SiteGroup) => {
    const all = funnels.filter(f => hostOf(f) === g.key);
    if (all.some(f => f.test_status === "running" || f.ui_status === "running")) {
      setError(`Stop the test running on ${g.label} before deleting it`);
      return;
    }
    if (!window.confirm(
      `Delete ${g.label} from funnel testing?\n\n` +
      `This removes its ${all.length} funnel${all.length === 1 ? "" : "s"} (${all.map(serviceLabel).join(", ")}) and their saved test reports. ` +
      `The domain stays in uptime monitoring.`
    )) return;

    const ids = all.map(f => f.id);
    const { error } = await supabase.from("funnels").delete().in("id", ids);
    if (error) {
      setError(error.message);
      return;
    }
    setFunnels(prev => prev.filter(f => !ids.includes(f.id)));
    setSuccess(`${g.label} removed from funnel testing (${ids.length} funnel${ids.length === 1 ? "" : "s"})`);
  };

  // One row per website - the same layout whether it has one funnel or several
  // One table row per website, laid out like the Home page's domain table
  const renderSiteGroup = (g: SiteGroup) => {
    const single = g.funnels.length === 1 ? g.funnels[0] : null;
    const { toTest, running, failed, untested, state, lastTested } = siteSummary(g);
    // How long the whole website took: its funnels' last tests added up
    const durations = toTest.map(testDurationMs).filter((ms): ms is number => ms !== null);
    const siteTestMs = durations.length ? durations.reduce((a, b) => a + b, 0) : null;
    const total = toTest.length;
    // Every funnel this website could have tested, including ones switched off
    const allFunnels = candidateFunnels(g.funnels);
    const switchedOff = allFunnels.length - total;
    const status =
      total === 0 && allFunnels.length > 0
        ? { text: "All funnels switched off", cls: "bg-gray-100 text-gray-800 dark:bg-muted dark:text-muted-foreground" }
        : state === "running"
        ? { text: `Testing${running && !single ? ` ${serviceLabel(running)}` : ""}…`, cls: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300" }
        : state === "failed"
          ? { text: total === 1 ? "Not working" : `${failed} of ${total} failing`, cls: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300" }
          : state === "passed"
            ? { text: total === 1 ? "Working" : `All ${total} working`, cls: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300" }
            : state === "partial"
              ? { text: `${untested} not tested yet`, cls: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300" }
              : { text: "Not tested yet", cls: "bg-gray-100 text-gray-800 dark:bg-muted dark:text-muted-foreground" };
    // The first failing funnel and why, so the row says what's wrong without opening it
    const firstFailing = toTest.find(f => funnelState(f) === "failed");
    const reason = firstFailing ? failureReason(firstFailing) : null;
    const liveMessage = running ? testMessages[running.id] : undefined;
    // The website's stages: a stage failed if it failed on any of its funnels
    const stages = combineStages(toTest.map(funnelStages).filter((s): s is FunnelStages => !!s));
    const reportHref = `/funnel-test/site/${encodeURIComponent(g.key)}`;

    return (
      <tr key={g.key} className="align-top hover:bg-muted/20">
        <td className="px-4 py-4">
          <div className="flex flex-wrap items-center gap-2">
            <Link href={reportHref} className="text-base font-medium hover:text-brand" title="Open the full report for this website">
              {g.label}
            </Link>
            {isManualSite(g) && (
              <span
                className="rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-medium text-violet-800 dark:bg-violet-950 dark:text-violet-300"
                title="Added on this page by name and landing page - not a monitored client"
              >
                Added manually
              </span>
            )}
          </div>
          <a
            href={g.url}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1 flex items-center gap-1 text-xs text-muted-foreground hover:text-brand"
          >
            <Globe className="h-3.5 w-3.5" />
            {g.key}
            <ExternalLink className="h-3 w-3" />
          </a>
          {allFunnels.length > 1 && (
            <div
              className="mt-1 max-w-[260px] truncate text-xs text-muted-foreground"
              title={`Tested: ${toTest.map(serviceLabel).join(", ") || "none"}${switchedOff ? `\nSwitched off: ${allFunnels.filter(f => f.test_enabled === false).map(serviceLabel).join(", ")}` : ""}`}
            >
              {switchedOff ? `${total} of ${allFunnels.length} funnels tested` : `${total} funnels`}: {toTest.map(serviceLabel).join(", ") || "none"}
            </div>
          )}
        </td>
        <td className="px-4 py-4">
          <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ${status.cls}`}>
            {state === "running" && <RefreshCw className="h-3 w-3 animate-spin" />}
            {status.text}
          </span>
          {/* While testing, the "Testing…" badge alone; the step-by-step log isn't shown here */}
          {state !== "running" && reason ? (
            <div className="mt-1.5 max-w-[240px] text-xs text-red-700 dark:text-red-400" title={reason}>
              {!single && firstFailing ? `${serviceLabel(firstFailing)}: ` : ""}
              {reason}
            </div>
          ) : null}
        </td>
        {STAGES.map(s => (
          <td key={s.key} className="px-2 py-4 text-center">
            <StageCell state={stages?.[s.key] ?? null} label={s.label} />
          </td>
        ))}
        <td className="px-4 py-4">
          {lastTested ? (
            <div className="flex items-start gap-2">
              <Clock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <div>
                <div className="whitespace-nowrap">{formatTimeAgo(lastTested)}</div>
                {siteTestMs !== null && (
                  <div className="text-xs text-muted-foreground">took {formatDuration(siteTestMs)}</div>
                )}
              </div>
            </div>
          ) : (
            <span className="text-xs text-muted-foreground">Never</span>
          )}
        </td>
        {/* Run test: just the icon - the column header says what it does */}
        <td className="px-2 py-4 text-center">
          {running ? (
            <Button
              size="icon"
              variant="outline"
              className="h-8 w-8 text-red-600"
              disabled={stoppingIds.has(running.id)}
              onClick={() => {
                if (bulkProgress) {
                  stopTestAllRef.current = true;
                  setStopRequested(true);
                }
                stopTest(running, !bulkProgress);
              }}
              title={stoppingIds.has(running.id) ? "Stopping…" : "Stop testing this website"}
              aria-label="Stop testing this website"
            >
              <Square className="h-3.5 w-3.5" />
            </Button>
          ) : (
            <Button
              size="icon"
              variant="outline"
              className="h-8 w-8"
              disabled={!!bulkProgress || total === 0}
              onClick={() => (total === 1 ? testOne(toTest[0]) : testAll(toTest, g.label, true))}
              title={total === 0 ? "All funnels are switched off" : single ? "Run test: this funnel, starting from the homepage" : "Run test: every funnel on this website, one by one"}
              aria-label={`Run test on ${g.label}`}
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
          )}
        </td>
        <td className="px-4 py-4 text-right">
          <Link href={reportHref} className="btn-outline inline-flex whitespace-nowrap py-1.5 text-xs">
            See Details
          </Link>
        </td>
      </tr>
    );
  };

  // The websites as a table, with the same look as the Home page
  const renderSiteTable = (sites: SiteGroup[]) => (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-muted/50">
            <th className="px-4 py-3 text-left font-medium">Website</th>
            <th className="px-4 py-3 text-left font-medium">Status</th>
            {STAGES.map(s => (
              <th key={s.key} className="px-2 py-3 text-center font-medium" title={s.label}>
                {s.short}
              </th>
            ))}
            <th className="px-4 py-3 text-left font-medium">Last Test</th>
            <th className="px-2 py-3 text-center font-medium">Run test</th>
            <th className="px-4 py-3 text-right font-medium">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">{sites.map(renderSiteGroup)}</tbody>
      </table>
    </div>
  );

  // Website counts for the result filter, over every website
  const allSummaries = allSiteGroups.map(siteSummary);
  const siteCounts: Record<string, number> = {
    all: allSiteGroups.length,
    passed: allSummaries.filter(s => s.state === "passed").length,
    failed: allSummaries.filter(s => s.state === "failed").length,
    untested: allSummaries.filter(s => s.untested > 0).length,
  };

  return (
    <div className="container mx-auto px-4 py-10">
      {/* Header: same layout as the Home page's "Domain Status" */}
      <div className="mb-4 flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-3xl font-bold text-foreground">Funnel Test</h1>
          <p className="mt-1 text-muted-foreground">
            Check each website&apos;s quote form works: the form, the SMS verification and the thank-you page
          </p>
        </div>
        <div className="flex w-full flex-col flex-wrap items-center gap-3 sm:flex-row lg:w-auto lg:justify-end">
          <div className="relative w-full sm:w-64">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="funnel-search"
              placeholder="Search websites…"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="h-9 pl-9 pr-8"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                title="Clear search"
                aria-label="Clear search"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="h-9 w-full sm:w-44">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              {statusFilters.map(f => (
                <SelectItem key={f.id} value={f.id}>
                  {f.id === "all" ? "Status: All" : f.name}
                  {siteCounts[f.id] !== undefined ? ` (${siteCounts[f.id]})` : f.count !== undefined ? ` (${f.count})` : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {clientOptions.length > 1 && (
            <Select value={clientFilter} onValueChange={setClientFilter}>
              <SelectTrigger className="h-9 w-full sm:w-44">
                <SelectValue placeholder="Client" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Client: All</SelectItem>
                {clientOptions.map(c => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {/* Which device's results the table shows - tests always run on both */}
          <Select value={resultView} onValueChange={v => setResultView(v as DeviceChoice)}>
            <SelectTrigger className="h-9 w-full whitespace-nowrap sm:w-56" title="Which device's results the table shows. Tests always run on both.">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="both">Results: Desktop + Mobile</SelectItem>
              <SelectItem value="desktop">Results: Desktop</SelectItem>
              <SelectItem value="mobile">Results: Mobile</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Pop-up when a test number is blocked, used up or nearly used up */}
      {smsPopupOpen && smsWarnings.length > 0 && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={dismissSmsPopup}
          role="dialog"
          aria-modal="true"
          aria-labelledby="sms-warning-title"
        >
          <div className="w-full max-w-lg rounded-xl border bg-background p-5 shadow-xl" onClick={e => e.stopPropagation()}>
            <div className="mb-3 flex items-center gap-2">
              <span
                className={`flex h-9 w-9 items-center justify-center rounded-full ${
                  smsWarnings.some(w => w.level === "red")
                    ? "bg-red-100 text-red-600 dark:bg-red-950 dark:text-red-400"
                    : "bg-amber-100 text-amber-600 dark:bg-amber-950 dark:text-amber-400"
                }`}
              >
                <AlertCircle className="h-5 w-5" />
              </span>
              <h2 id="sms-warning-title" className="text-lg font-semibold">SMS test numbers need attention</h2>
            </div>
            <ul className="space-y-2">
              {smsWarnings.map((w, i) => (
                <li
                  key={i}
                  className={`rounded-md border p-3 text-sm ${
                    w.level === "red"
                      ? "border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/50 dark:text-red-400"
                      : "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-400"
                  }`}
                >
                  {w.text}
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-muted-foreground">
              Each number may receive {smsUsage?.limit ?? 20} SMS codes a day. Funnels with an SMS step need a free number to pass.
            </p>
            <div className="mt-4 flex justify-end">
              <Button onClick={dismissSmsPopup} autoFocus>OK, got it</Button>
            </div>
          </div>
        </div>
      )}

      {/* Toolbar: what's shown and SMS codes on the left, actions on the right */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-y py-3">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-muted-foreground">
          <span>
            Showing <span className="font-medium text-foreground">{visibleSites.length}</span> of {allSiteGroups.length} websites
          </span>
          <Link href="/funnel-test/issues" className="inline-flex items-center gap-1 hover:text-foreground hover:underline">
            <AlertCircle className="h-3.5 w-3.5" /> Issues overview
          </Link>
          {smsUsage && smsUsage.numbers.length > 0 && (
            <span
              className="inline-flex flex-wrap items-center gap-x-2"
              title={`SMS verification codes each test number has received today, out of ${smsUsage.limit} a day.`}
            >
              <Smartphone className="h-3.5 w-3.5" /> SMS today:
              {smsUsage.numbers.map(n => (
                <span
                  key={n.number}
                  className={
                    n.blockedAt || n.used >= smsUsage.limit
                      ? "font-medium text-red-600 dark:text-red-400"
                      : n.used >= Math.ceil(smsUsage.limit * 0.75)
                        ? "font-medium text-amber-600"
                        : ""
                  }
                >
                  …{n.number.slice(-4)} {n.blockedAt ? "blocked" : `${n.used}/${smsUsage.limit}`}
                </span>
              ))}
              {smsWarnings.length > 0 && (
                <button
                  type="button"
                  onClick={() => setSmsPopupOpen(true)}
                  className={`font-medium underline-offset-2 hover:underline ${
                    smsWarnings.some(w => w.level === "red") ? "text-red-600 dark:text-red-400" : "text-amber-600"
                  }`}
                >
                  ⚠ View warnings
                </button>
              )}
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={checkAll}
            disabled={loading || !!checkProgress || filteredFunnels.length === 0}
            title="Check every page in the list loads (no forms submitted)"
          >
            <Globe className={`mr-1.5 h-3.5 w-3.5 ${checkProgress ? "animate-pulse" : ""}`} />
            {checkProgress ? `Checking ${checkProgress.done}/${checkProgress.total}` : "Check pages"}
          </Button>
          {bulkProgress ? (
            <Button
              size="sm"
              variant="outline"
              className="border-red-300 text-red-600 hover:bg-red-50 dark:border-red-900 dark:hover:bg-red-950"
              onClick={stopBulk}
              disabled={stopRequested}
              title="Stop now: ends the current test after the step it's on and skips the rest"
            >
              <Square className="mr-1.5 h-3.5 w-3.5" />
              Stop testing
            </Button>
          ) : (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={() => testAll()}
                disabled={loading || filteredFunnels.length === 0}
                title="Test every website shown, one by one"
              >
                <Play className="mr-1.5 h-3.5 w-3.5" />
                Test all
              </Button>
              <Button
                size="sm"
                onClick={testNextSites}
                disabled={loading || filteredFunnels.length === 0}
                title="Test the next 5 websites (never tested first, then the longest ago) one by one, then stop by itself"
              >
                <Play className="mr-1.5 h-3.5 w-3.5" />
                Test next 5 sites
              </Button>
            </>
          )}
          <Button size="sm" variant="outline" onClick={() => setShowAddForm(s => !s)}>
            {showAddForm ? <X className="mr-1.5 h-3.5 w-3.5" /> : <Plus className="mr-1.5 h-3.5 w-3.5" />}
            {showAddForm ? "Cancel" : "Add website"}
          </Button>
        </div>
      </div>

      {bulkProgress && (
        <div className="sticky top-2 z-20 mb-4 rounded-lg border bg-background p-4 shadow-sm">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-sm">
            <span>
              {bulkLabel} <span className="font-medium">{bulkProgress.current}</span>
              <span className="text-muted-foreground"> ({bulkProgress.done + 1} of {bulkProgress.total})</span>
            </span>
            <div className="flex items-center gap-3">
              <span className="font-medium">
                {Math.round((bulkProgress.done / bulkProgress.total) * 100)}%
                {(() => {
                  // Time left: from this run's own pace once a test has finished, else the usual test length
                  const p = testAllProgress;
                  if (!p) return null;
                  const left = p.total - p.done;
                  const perTest = p.done > 0 && p.startedAt ? (Date.now() - p.startedAt) / p.done : p.avgMs;
                  return perTest ? <span className="font-normal text-muted-foreground"> · about {formatDuration(perTest * left)} left</span> : null;
                })()}
              </span>
              <Button
                size="sm"
                variant="destructive"
                onClick={stopBulk}
                disabled={stopRequested}
                title="Stop now: ends the current test after the step it's on and skips the rest"
              >
                <Square className="mr-1.5 h-3.5 w-3.5" />
                {stopRequested ? "Stopping…" : "Stop testing"}
              </Button>
            </div>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-brand transition-all"
              style={{ width: `${(bulkProgress.done / bulkProgress.total) * 100}%` }}
            />
          </div>
          {stopRequested && (
            <p className="mt-2 text-xs text-muted-foreground">Stopping - the current test ends after the step it's on…</p>
          )}
        </div>
      )}

      {showAddForm && (
        <form onSubmit={addFunnel} className="mb-4 rounded-lg border p-4">
          <div className="grid gap-4 md:grid-cols-[1fr_1.5fr_auto] md:items-end">
            <div>
              <label htmlFor="site-name" className="mb-1 block text-sm font-medium">Website name</label>
              <Input
                id="site-name"
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="Smith Heating"
              />
            </div>
            <div>
              <label htmlFor="site-url" className="mb-1 block text-sm font-medium">Landing page</label>
              <Input
                id="site-url"
                value={form.url}
                onChange={e => setForm(f => ({ ...f, url: e.target.value }))}
                placeholder="https://smithheating.co.uk"
              />
            </div>
            <Button type="submit" disabled={saving}>
              {saving ? "Adding…" : "Add website"}
            </Button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Its quote funnels (boiler, air con, solar…) are found on the landing page and added with it. It joins the list
            with an &quot;Added manually&quot; tag and is tested like every other website.
          </p>
        </form>
      )}

      {error && (
        <div className="mb-4 flex items-center gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-400">
          <AlertCircle className="h-4 w-4" /> {error}
        </div>
      )}

      {success && (
        <div className="mb-4 flex items-center gap-2 rounded-md border border-green-200 bg-green-50 p-3 text-sm text-green-700 dark:border-green-900 dark:bg-green-950 dark:text-green-400">
          <CheckCircle className="h-4 w-4" /> {success}
        </div>
      )}

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full rounded-lg" />
          ))}
        </div>
      ) : visibleSites.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground">
          {funnels.length === 0 ? 'No websites yet. Click "Add website" to add one.' : "No websites match these filters."}
        </p>
      ) : (
        <>
          {/* Client websites first, then the ones added by hand on this page */}
          {/* One list for every website; ones added by hand carry an "Added manually" tag */}
          {renderSiteTable(visibleSites)}
        </>
      )}
    </div>
  );
}
