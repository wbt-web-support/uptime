"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { isChooserFunnel } from "@/utils/funnel-discovery";
import Link from "next/link";
import {
  classifyMessage,
  deriveProgress,
  explainFailure,
  isWaitingForOtp,
  LOG_STYLE,
  OWNER_LABEL,
  type Explanation,
  type ProblemOwner,
} from "@/utils/funnel-report";
import { createClient } from "@/utils/supabase/client";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import {
  AlertCircle,
  CheckCircle,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  FileText,
  Filter,
  Globe,
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
  }> | null;
  // UI check: quote buttons + visual problems, no forms submitted
  ui_status: "running" | "ok" | "issues" | "error" | null;
  ui_results: Record<"desktop" | "mobile", UiResult> | null;
  ui_checked_at: string | null;
  created_at: string;
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
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
            <div className="flex flex-col">
              <span className="text-muted-foreground">Steps walked</span>
              <span className="font-medium">{result.steps ?? "—"}</span>
            </div>
            <div className="flex flex-col">
              <span className="text-muted-foreground">Tracking (GTM / gtag)</span>
              <span className={`font-medium ${result.tracking_ok === false ? "text-amber-600" : ""}`}>
                {result.tracking_ok === null ? "—" : result.tracking_ok ? "Present on every step" : "Missing"}
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
            {ui.ui_issues.length > 0 ? (
              <ul className="list-disc space-y-0.5 pl-4 text-amber-700 dark:text-amber-400">
                {ui.ui_issues.slice(0, 3).map((issue, i) => <li key={i}>{issue}</li>)}
                {ui.ui_issues.length > 3 && <li>and {ui.ui_issues.length - 3} more</li>}
              </ul>
            ) : (
              <div className="text-green-600 dark:text-green-400">No visual problems found</div>
            )}
            <ReportLink id={ui.report_id} label="Full UI report" />
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
    (n, r) => n + r.ui_issues.length + (r.quote_buttons_found - r.quote_buttons_working) + (r.cta && !r.cta.works ? 1 : 0),
    0
  );
  const ok = funnel.ui_status === "ok";
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
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showAddForm, setShowAddForm] = useState(false);
  const [form, setForm] = useState({ name: "", url: "", domain_id: NO_CLIENT });
  const [saving, setSaving] = useState(false);
  const [checkingIds, setCheckingIds] = useState<Set<string>>(new Set());
  const [checkProgress, setCheckProgress] = useState<{ done: number; total: number } | null>(null);
  // Latest walker message per running funnel test
  const [testMessages, setTestMessages] = useState<Record<string, string>>({});
  const [testAllProgress, setTestAllProgress] = useState<{ done: number; total: number; current: string } | null>(null);
  // Live log, progress and screenshot of a running test, per funnel and device
  const [testLive, setTestLive] = useState<Record<string, Partial<Record<Device, LiveRun>>>>({});
  // Which device(s) Run test / Test all use, like the funnel tester's own "Both / Desktop / Mobile"
  const [deviceChoice, setDeviceChoiceState] = useState<DeviceChoice>("both");
  const setDeviceChoice = (choice: DeviceChoice) => {
    setDeviceChoiceState(choice);
    try { localStorage.setItem("funnel-test-devices", choice); } catch {}
  };
  useEffect(() => {
    try {
      const saved = localStorage.getItem("funnel-test-devices");
      if (saved === "both" || saved === "desktop" || saved === "mobile") setDeviceChoiceState(saved);
    } catch {}
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
  const [smsUsage, setSmsUsage] = useState<{ limit: number; numbers: { number: string; used: number }[] } | null>(null);
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
        (statusFilter === "passed" && funnel.test_status === "passed") ||
        (statusFilter === "failed" && (funnel.test_status === "failed" || funnel.test_status === "error")) ||
        (statusFilter === "untested" && funnel.test_status === null);

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

  const statusFilters = [
    { id: "all", name: "All results", count: funnels.length },
    { id: "passed", name: "Test passed", count: funnels.filter(f => f.test_status === "passed").length },
    { id: "failed", name: "Test failed", count: funnels.filter(f => f.test_status === "failed" || f.test_status === "error").length },
    { id: "untested", name: "Not tested", count: funnels.filter(f => f.test_status === null).length },
    { id: "up", name: "Page up", count: funnels.filter(f => f.last_status === true).length },
    { id: "down", name: "Page down", count: funnels.filter(f => f.last_status === false).length },
    { id: "unchecked", name: "Page not checked", count: funnels.filter(f => f.last_status === null).length },
  ];

  const clientOptions = Array.from(new Set(funnels.map(f => clientName(f) ?? NO_CLIENT_LABEL))).sort();

  const addFunnel = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSuccess("");

    let url = form.url.trim();
    if (!form.name.trim() || !url) {
      setError("Funnel name and URL are required");
      return;
    }
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    try {
      new URL(url);
    } catch {
      setError("Please enter a valid URL");
      return;
    }

    setSaving(true);
    try {
      const { data, error } = await supabase
        .from("funnels")
        .insert({
          name: form.name.trim(),
          url,
          domain_id: form.domain_id === NO_CLIENT ? null : form.domain_id,
        })
        .select()
        .single();
      if (error) throw error;

      setFunnels(prev => [...prev, data].sort((a, b) => a.name.localeCompare(b.name)));
      setForm({ name: "", url: "", domain_id: NO_CLIENT });
      setShowAddForm(false);
      setSuccess(`Funnel "${data.name}" added`);
      checkFunnel(data.id);
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
  const runTest = async (funnel: Funnel, withUiCheck = true): Promise<Funnel | null> => {
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
          body: JSON.stringify({ funnelId: funnel.id, viewports: DEVICES_FOR_CHOICE[deviceChoice], withUiCheck: false }),
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
        return null;
      }
    }
    return pollTest(funnel.id);
  };

  // Stop a running test and its UI check; the polling loops see the stopped status and end
  const [stoppingIds, setStoppingIds] = useState<Set<string>>(new Set());
  const stopTest = async (funnel: { id: string; name: string }, ask = true) => {
    if (ask && !window.confirm(`Stop the test on "${funnel.name}"?\n\nThe walker stops after the step it's on. Anything it has already submitted stays submitted.`)) return;
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
    if (!window.confirm(`Test "${funnel.name}"?\n\n${REAL_LEAD_WARNING}`)) return;
    setError("");
    setSuccess("");
    // Open the row so the live progress is in view
    setExpanded(prev => new Set(prev).add(funnel.id));
    runTest(funnel);
  };

  // Test funnels strictly one after another: one site's (from its row) or every
  // site's in the list (from the toolbar). Each starts from the site's homepage.
  const testAll = async (only?: Funnel[], siteLabel?: string) => {
    const list = only ?? testableFunnels(filteredFunnels);
    if (list.length === 0) return;
    const what = `${list.length} ${list.length === 1 ? "funnel" : "funnels"}${siteLabel ? ` on ${siteLabel}` : ""}`;
    if (!window.confirm(`Test ${what} one by one?\n\n${REAL_LEAD_WARNING}\nEach test can take a few minutes.`)) return;

    setError("");
    setSuccess("");
    stopTestAllRef.current = false;
    setStopRequested(false);
    let passed = 0;
    let done = 0;
    const uiCheckedHosts = new Set<string>();

    for (const funnel of list) {
      if (stopTestAllRef.current) break;
      setTestAllProgress({ done, total: list.length, current: funnel.name });
      // Open the site and the funnel so the live progress is in view
      setExpanded(prev => new Set(prev).add(funnel.id).add(`site:${hostOf(funnel)}`));
      bulkCurrentRef.current = { id: funnel.id, name: funnel.name };
      // The UI check looks at the site's homepage, so once per site is enough
      const host = hostOf(funnel);
      const result = await runTest(funnel, !uiCheckedHosts.has(host));
      uiCheckedHosts.add(host);
      if (result?.test_status === "passed") passed++;
      done++;
    }

    bulkCurrentRef.current = null;
    setTestAllProgress(null);
    const stopped = done < list.length ? ` (stopped after ${done} of ${list.length})` : "";
    setSuccess(`Funnel tests finished: ${passed} of ${done} passed${stopped}`);
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
  const renderFunnelRow = (funnel: Funnel, nested = false) => {
      const isTesting = funnel.test_status === "running";
      const isChecking = checkingIds.has(funnel.id);
      const isExpanded = expanded.has(funnel.id);
      const lastTested = funnel.test_finished_at;
      const client = clientName(funnel);
      const live = testLive[funnel.id];
      // A device is part of the running test unless the live data says otherwise
      // (Desktop-only or Mobile-only runs leave the other device's last result alone)
      const testingOn = (device: Device) => isTesting && (!live || !!live[device]);
      return (
        <div key={funnel.id}>
          <div
            className={`flex cursor-pointer flex-wrap items-center gap-3 p-4 hover:bg-muted/50 ${nested ? "pl-10" : ""}`}
            onClick={() => toggleExpand(funnel.id)}
          >
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{nested ? serviceLabel(funnel) : funnel.name}</div>
              <div className="truncate text-xs text-muted-foreground">{funnel.url}</div>
            </div>
            <div className="flex items-center gap-2">
              <PagePill funnel={funnel} checking={isChecking} />
              <UiPill funnel={funnel} />
              <DevicePill result={deviceResult(funnel, "mobile")} testing={testingOn("mobile")} icon={Smartphone} />
              <DevicePill result={deviceResult(funnel, "desktop")} testing={testingOn("desktop")} icon={Monitor} />
            </div>
            {lastTested && !isTesting && (
              <span className="hidden text-xs text-muted-foreground md:inline">
                {new Date(lastTested).toLocaleDateString()}
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
            {!nested && (
              <Button
                size="sm"
                variant="outline"
                className="px-2 text-red-600"
                disabled={isTesting || funnel.ui_status === "running"}
                onClick={e => {
                  e.stopPropagation();
                  deleteFunnel(funnel);
                }}
                title="Remove this website from funnel testing"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            )}
            {isExpanded ? (
              <ChevronUp className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            )}
          </div>
          {isTesting && testMessages[funnel.id] && (
            <div className="truncate px-4 pb-3 text-xs text-muted-foreground" title={testMessages[funnel.id]}>
              {testMessages[funnel.id]}
            </div>
          )}
          {isExpanded && (
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
                    onClick={() => deleteFunnel(funnel)}
                    title="Delete funnel"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            </div>
          )}
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

  const siteGroups = useMemo<SiteGroup[]>(() => {
    const byHost = new Map<string, Funnel[]>();
    for (const f of filteredFunnels) {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredFunnels, domainById]);

  // What "test this site" runs: every specific funnel (each entered from the homepage).
  // The bare homepage entry is only tested when a site has no specific funnels, since
  // otherwise it just repeats whichever funnel the walker would pick first.
  // Chooser pages (no form, just cards to each service's form) are skipped the same
  // way: each of their services is tested on its own.
  const testableFunnels = (list: Funnel[]) => {
    const hostsWithFunnels = new Set(list.filter(f => !isHomepage(f) && !isChooserFunnel(f)).map(hostOf));
    return list.filter(f => !isChooserFunnel(f) && (!isHomepage(f) || !hostsWithFunnels.has(hostOf(f))));
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

  const renderSiteGroup = (g: SiteGroup) => {
    if (g.funnels.length === 1) return renderFunnelRow(g.funnels[0]);

    const key = `site:${g.key}`;
    const open = expanded.has(key);
    const toTest = testableFunnels(g.funnels);
    const running = g.funnels.find(f => f.test_status === "running" || f.ui_status === "running");
    const passed = toTest.filter(f => f.test_status === "passed").length;
    const failed = toTest.filter(f => f.test_status === "failed" || f.test_status === "error").length;
    const untested = toTest.filter(f => !f.test_status).length;
    const lastTested = g.funnels
      .map(f => f.test_finished_at)
      .filter((d): d is string => !!d)
      .sort()
      .pop();
    const pill = "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold";

    return (
      <div key={key}>
        <div className="flex cursor-pointer flex-wrap items-center gap-3 p-4 hover:bg-muted/50" onClick={() => toggleExpand(key)}>
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium">{g.label}</div>
            <div className="truncate text-xs text-muted-foreground">
              {g.url} · {toTest.length} funnel{toTest.length === 1 ? "" : "s"}: {toTest.map(serviceLabel).join(", ")}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {running ? (
              <span className={`${pill} bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-400`}>
                <RefreshCw className="h-3 w-3 animate-spin" /> Testing {serviceLabel(running)}
              </span>
            ) : (
              <>
                {passed > 0 && <span className={`${pill} ${resultColor("passed")}`}>✓ {passed} passed</span>}
                {failed > 0 && <span className={`${pill} ${resultColor("failed")}`}>✕ {failed} failed</span>}
                {untested > 0 && <span className={`${pill} bg-muted font-normal text-muted-foreground`}>{untested} not tested</span>}
              </>
            )}
          </div>
          {lastTested && !running && (
            <span className="hidden text-xs text-muted-foreground md:inline">{new Date(lastTested).toLocaleDateString()}</span>
          )}
          {running ? (
            <Button
              size="sm"
              variant="outline"
              className="text-red-600"
              disabled={stoppingIds.has(running.id)}
              onClick={e => {
                e.stopPropagation();
                if (bulkProgress) {
                  stopTestAllRef.current = true;
                  setStopRequested(true);
                }
                stopTest(running, !bulkProgress);
              }}
              title="Stop testing this site"
            >
              <Square className="mr-1.5 h-3.5 w-3.5" />
              {stoppingIds.has(running.id) ? "Stopping…" : "Stop"}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={!!bulkProgress}
              onClick={e => {
                e.stopPropagation();
                setExpanded(prev => new Set(prev).add(key));
                testAll(toTest, g.label);
              }}
              title="Test every funnel on this site, one by one, each starting from the homepage"
            >
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              Run test
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            className="px-2 text-red-600"
            disabled={!!running}
            onClick={e => {
              e.stopPropagation();
              deleteSite(g);
            }}
            title="Remove this website and all its funnels from funnel testing"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
          {open ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
        </div>
        {open && <div className="divide-y border-t bg-muted/20">{g.funnels.map(f => renderFunnelRow(f, true))}</div>}
      </div>
    );
  };

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8">
      <div className="mb-4 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <Filter className="h-6 w-6" />
            Funnel Test
          </h1>
          <p className="text-sm text-muted-foreground">
            {funnels.length} funnel{funnels.length === 1 ? "" : "s"} · mobile + desktop, powered by the AI funnel tester
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search funnels…"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="w-56 pl-8"
            />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-40">
              <SelectValue placeholder="Result" />
            </SelectTrigger>
            <SelectContent>
              {statusFilters.map(f => (
                <SelectItem key={f.id} value={f.id}>
                  {f.name} ({f.count})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {clientOptions.length > 1 && (
            <Select value={clientFilter} onValueChange={setClientFilter}>
              <SelectTrigger className="w-40">
                <SelectValue placeholder="Client" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All clients</SelectItem>
                {clientOptions.map(c => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <p className="text-xs text-muted-foreground">
            {siteGroups.length} site{siteGroups.length === 1 ? "" : "s"} · {filteredFunnels.length} of {funnels.length} funnels
          </p>
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="text-muted-foreground">Full test on:</span>
            {(["both", "desktop", "mobile"] as DeviceChoice[]).map(choice => (
              <button
                key={choice}
                type="button"
                onClick={() => setDeviceChoice(choice)}
                disabled={!!bulkProgress}
                aria-pressed={deviceChoice === choice}
                className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 font-medium transition-colors ${
                  deviceChoice === choice ? "border-brand bg-brand text-white" : "border-border hover:bg-muted"
                }`}
              >
                {choice === "both" ? (
                  <><Monitor className="h-3 w-3" />+<Smartphone className="h-3 w-3" /> Both</>
                ) : choice === "desktop" ? (
                  <><Monitor className="h-3 w-3" /> Desktop</>
                ) : (
                  <><Smartphone className="h-3 w-3" /> Mobile</>
                )}
              </button>
            ))}
            {deviceChoice === "both" && (
              <span className="text-amber-600 dark:text-amber-400">Submits twice: 2 real leads per site</span>
            )}
          </div>
          <Link href="/funnel-test/issues" className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
            <AlertCircle className="h-3 w-3" /> Issues overview
          </Link>
          {smsUsage && smsUsage.numbers.length > 0 && (
            <span
              className="inline-flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground"
              title={`SMS verification codes each test number has received today. Each number is limited to ${smsUsage.limit} a day so it doesn't get blocked; tests pause until tomorrow once every number reaches it.`}
            >
              <Smartphone className="h-3 w-3" /> SMS codes today:
              {smsUsage.numbers.map(n => (
                <span
                  key={n.number}
                  className={n.used >= smsUsage.limit ? "font-semibold text-red-600" : n.used >= smsUsage.limit * 0.75 ? "font-semibold text-amber-600" : ""}
                >
                  …{n.number.slice(-4)} {n.used}/{smsUsage.limit}
                </span>
              ))}
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
                onClick={uiCheckAll}
                disabled={loading || filteredFunnels.length === 0}
                title="Click every quote button and look for visual problems, one funnel at a time (no forms submitted)"
              >
                <MousePointerClick className="mr-1.5 h-3.5 w-3.5" />
                UI check all
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => testAll()}
                disabled={loading || filteredFunnels.length === 0}
                title="Test every funnel of every site in the list, one by one"
              >
                <Play className="mr-1.5 h-3.5 w-3.5" />
                Test all
              </Button>
            </>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={findFunnels}
            disabled={discovering || loading}
            title="Find every service funnel (boiler, ASHP, air con, solar, battery...) on each client site and add the missing ones"
          >
            <Search className={`mr-1.5 h-3.5 w-3.5 ${discovering ? "animate-pulse" : ""}`} />
            {discovering ? "Finding funnels…" : "Find funnels"}
          </Button>
          <Button size="sm" onClick={() => setShowAddForm(s => !s)}>
            {showAddForm ? <X className="mr-1.5 h-3.5 w-3.5" /> : <Plus className="mr-1.5 h-3.5 w-3.5" />}
            {showAddForm ? "Cancel" : "Add funnel"}
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
              <span className="font-medium">{Math.round((bulkProgress.done / bulkProgress.total) * 100)}%</span>
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
        <form onSubmit={addFunnel} className="mb-4 grid gap-4 rounded-lg border p-4 md:grid-cols-[1fr_1.5fr_1fr_auto] md:items-end">
          <div>
            <label htmlFor="funnel-name" className="mb-1 block text-sm font-medium">Funnel name</label>
            <Input
              id="funnel-name"
              value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              placeholder="Boiler quote funnel"
            />
          </div>
          <div>
            <label htmlFor="funnel-url" className="mb-1 block text-sm font-medium">Funnel URL</label>
            <Input
              id="funnel-url"
              value={form.url}
              onChange={e => setForm(f => ({ ...f, url: e.target.value }))}
              placeholder="https://example.co.uk/get-a-quote"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Client</label>
            <Select value={form.domain_id} onValueChange={v => setForm(f => ({ ...f, domain_id: v }))}>
              <SelectTrigger>
                <SelectValue placeholder="Select client" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_CLIENT}>No client</SelectItem>
                {domains.map(d => (
                  <SelectItem key={d.id} value={d.id}>{d.display_name || d.domain_name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button type="submit" disabled={saving}>
            {saving ? "Saving..." : "Save"}
          </Button>
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
      ) : filteredFunnels.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground">
          {funnels.length === 0 ? 'No funnels yet. Click "Add funnel" to add one.' : "No funnels found."}
        </p>
      ) : (
        <div className="divide-y rounded-lg border">
          {siteGroups.map(renderSiteGroup)}
        </div>
      )}
    </div>
  );
}
