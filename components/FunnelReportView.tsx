"use client";

// The full report of one funnel test or UI check, as saved in funnel_reports - used
// on its own page and opened in place on a website's report page.

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/utils/supabase/client";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertCircle, CheckCircle, XCircle } from "lucide-react";
import {
  buildSummary,
  describeSiteRequestProblem,
  detectKnownLimitation,
  detectSiteRequestProblem,
  explainFailure,
  OWNER_LABEL,
  type ProblemOwner,
  formatAction,
  parseFailure,
  TONE_CLASS,
  type FinalActionLike,
  type WalkReport,
} from "@/utils/funnel-report";

// Full report for one funnel test or UI check on one device, as saved in
// funnel_reports. Screenshots are still files on the funnel tester, fetched
// through /api/funnels/screenshot.

interface ReportRow {
  id: string;
  funnel_id: string;
  kind: "test" | "ui";
  viewport: "desktop" | "mobile";
  status: string | null;
  report: any;
  created_at: string;
}

// Same colours as the Funnel Test page: whose problem it is at a glance
const OWNER_STYLE: Record<ProblemOwner, string> = {
  website: "border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-900 dark:bg-rose-950/50 dark:text-rose-300",
  tester: "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-300",
  setup: "border-violet-200 bg-violet-50 text-violet-800 dark:border-violet-900 dark:bg-violet-950/50 dark:text-violet-300",
  unclear: "border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-900 dark:bg-sky-950/50 dark:text-sky-300",
  stopped: "border-border bg-muted/50 text-muted-foreground",
};

const shot = (path: string) => `/api/funnels/screenshot?path=${encodeURIComponent(path)}`;

function Screenshot({ path, alt, className = "" }: { path?: string | null; alt: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  if (!path) return null;
  if (failed) {
    return (
      <div className={`flex items-center justify-center rounded-md border bg-muted p-6 text-xs text-muted-foreground ${className}`}>
        Screenshot no longer available on the funnel tester
      </div>
    );
  }
  return (
    <a href={shot(path)} target="_blank" rel="noopener noreferrer">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={shot(path)}
        alt={alt}
        loading="lazy"
        onError={() => setFailed(true)}
        className={`rounded-md border object-contain object-top ${className}`}
      />
    </a>
  );
}

function StatusBadge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold ${
        ok
          ? "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-400"
          : "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400"
      }`}
    >
      {ok ? <CheckCircle className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
      {label}
    </span>
  );
}

function Collapsible({ title, items }: { title: string; items: string[] }) {
  if (!items?.length) return null;
  return (
    <details className="rounded-lg border bg-background p-4">
      <summary className="cursor-pointer text-sm font-medium">
        {title} <span className="text-muted-foreground">({items.length})</span>
      </summary>
      <ul className="mt-3 space-y-1.5">
        {items.map((item, i) => (
          <li key={i} className="break-all rounded bg-muted px-2 py-1 font-mono text-xs">{item}</li>
        ))}
      </ul>
    </details>
  );
}

function FinalActions({ actions, depth = 0 }: { actions: FinalActionLike[]; depth?: number }) {
  if (!actions?.length) return null;
  return (
    <div className={depth ? "ml-4 mt-3 space-y-3 border-l-2 pl-4" : "space-y-3"}>
      {actions.map((a, i) => (
        <div key={i}>
          <div className="flex gap-3 rounded-lg border bg-background p-3">
            {a.screenshot ? (
              <Screenshot path={a.screenshot} alt={a.label} className="w-36 shrink-0" />
            ) : (
              <div className="flex w-36 shrink-0 items-center justify-center rounded-md bg-red-50 text-xs text-red-700 dark:bg-red-950 dark:text-red-400">
                No screenshot
              </div>
            )}
            <div className="min-w-0 flex-1 text-sm">
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <span className="font-semibold">{a.label}</span>
                <span
                  className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                    a.error ? TONE_CLASS.bad.value + " bg-red-100 dark:bg-red-950" : a.warning ? TONE_CLASS.warn.value + " bg-amber-100 dark:bg-amber-950" : TONE_CLASS.good.value + " bg-green-100 dark:bg-green-950"
                  }`}
                >
                  {a.error ? "Failed" : a.warning ? "No change" : "OK"}
                </span>
              </div>
              {a.error ? (
                <p className="text-xs text-red-600 dark:text-red-400">{a.error}</p>
              ) : (
                <p className="truncate text-xs text-muted-foreground">
                  Landed on: <a href={a.resultingUrl} target="_blank" rel="noreferrer" className="underline-offset-2 hover:underline">{a.resultingUrl}</a>
                </p>
              )}
              {a.warning && !a.error && <p className="mt-1 text-xs text-amber-600">{a.warning}</p>}
            </div>
          </div>
          {a.nestedActions && a.nestedActions.length > 0 && (
            <div className="mt-2">
              <p className="text-xs font-medium text-muted-foreground">
                Buttons tested on the page &quot;{a.label}&quot; led to ({a.nestedActions.length}):
              </p>
              <FinalActions actions={a.nestedActions} depth={depth + 1} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function Notice({ tone, title, children }: { tone: "danger" | "warning" | "violet"; title: string; children: React.ReactNode }) {
  const style = {
    danger: "border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400",
    warning: "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-400",
    violet: "border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-900 dark:bg-violet-950/40 dark:text-violet-400",
  }[tone];
  return (
    <div className={`flex items-start gap-2 rounded-md border p-3 text-sm ${style}`}>
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <strong className="mb-1 block">{title}</strong>
        {children}
      </div>
    </div>
  );
}

function TestReport({ report }: { report: WalkReport }) {
  const steps = report.steps || [];
  const parsedFailure = !report.completed ? parseFailure(report.failure) : null;
  const trackingGap = (!report.gtmPresentThroughout || !report.gtagPresentThroughout) && steps.length > 0;
  const limitation = !report.completed ? detectKnownLimitation(report.failure, steps) : null;
  const siteProblem = !report.completed ? detectSiteRequestProblem(report) : null;
  const explanation = !report.completed
    ? explainFailure(report.failure, siteProblem ? describeSiteRequestProblem(siteProblem) : null)
    : null;

  return (
    <div className="space-y-4">
      {/* Same six cards as the funnel tester's own report */}
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
        {buildSummary(report).map(item => {
          const t = TONE_CLASS[item.tone];
          return (
            <div key={item.title} className={`rounded-lg border p-3 ${t.card}`}>
              <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{item.title}</div>
              <div className={`mt-1 text-base font-bold ${t.value}`}>{t.dot} {item.value}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">{item.note}</div>
            </div>
          );
        })}
      </div>

      {steps.length > 0 && (
        <div className="flex gap-2 overflow-x-auto pb-2">
          {steps.map(step => (
            <a key={step.stepNumber} href={`#step-${step.stepNumber}`} className="shrink-0 text-center">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={shot(step.screenshot)}
                alt={`Step ${step.stepNumber}`}
                loading="lazy"
                className="h-16 w-24 rounded border object-cover object-top"
              />
              <span className="text-xs text-muted-foreground">{step.stepNumber}</span>
            </a>
          ))}
        </div>
      )}

      {explanation && (
        <div className={`rounded-md border p-4 text-sm ${OWNER_STYLE[explanation.owner]}`}>
          <div className="text-[11px] font-semibold uppercase tracking-wide opacity-80">
            {OWNER_LABEL[explanation.owner]} · this funnel did not submit
          </div>
          <div className="mt-1 text-base font-semibold">{explanation.title}</div>
          <p className="mt-1.5">{explanation.what}</p>
          <p className="mt-2"><span className="font-semibold">How to fix: </span>{explanation.fix}</p>
          {limitation && <p className="mt-2">🔒 Known limitation: {limitation}</p>}
          <details className="mt-3 text-xs opacity-90">
            <summary className="cursor-pointer">Technical details</summary>
            {siteProblem && (
              <p className="mt-2">
                Failing request: {siteProblem.method} {siteProblem.path} → {siteProblem.status}
                {siteProblem.message ? ` ("${siteProblem.message}")` : ""}. Every call the page made is under &quot;API calls&quot; below.
              </p>
            )}
            {parsedFailure && (
              <>
                <p className="mt-2">What the tester reported: {parsedFailure.headline}</p>
                {parsedFailure.actions && parsedFailure.actions.length > 0 && (
                  <ul className="mt-2 space-y-1 font-mono">
                    {parsedFailure.actions.map((a, i) => <li key={i}>{formatAction(a)}</li>)}
                  </ul>
                )}
                {parsedFailure.raw !== parsedFailure.headline && (
                  <pre className="mt-2 whitespace-pre-wrap break-all rounded bg-background/60 p-2">{parsedFailure.raw}</pre>
                )}
              </>
            )}
          </details>
        </div>
      )}

      {trackingGap && (
        <Notice tone="warning" title="Tracking missing on at least one step">
          <p>
            GTM {report.gtmPresentThroughout ? "✅ present throughout" : "❌ missing somewhere"} · gtag{" "}
            {report.gtagPresentThroughout ? "✅ present throughout" : "❌ missing somewhere"}. See the per-step tracking indicators below to see exactly where it dropped off.
          </p>
        </Notice>
      )}

      <Collapsible title="Console errors" items={report.consoleErrors} />
      <Collapsible title="Page errors" items={report.pageErrors} />
      <Collapsible title="API calls (XHR/fetch)" items={report.apiCalls} />

      {steps.map(step => (
        <div key={step.stepNumber} id={`step-${step.stepNumber}`} className="scroll-mt-20 rounded-lg border bg-background p-4">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className="font-medium">Step {step.stepNumber}</span>
            <span className="truncate text-xs text-muted-foreground">{step.url}</span>
            {step.tracking && (
              <span className="ml-auto flex gap-1.5">
                <StatusBadge ok={!!step.tracking.gtmPresent} label="GTM" />
                <StatusBadge ok={!!step.tracking.gtagPresent} label="gtag" />
              </span>
            )}
          </div>
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <Screenshot path={step.screenshot} alt={`Step ${step.stepNumber}`} className="max-h-[420px] w-full" />
            <div className="space-y-3 text-sm">
              {step.reasoning && (
                <div>
                  <div className="text-xs font-medium text-muted-foreground">What the AI saw and decided</div>
                  <p className="mt-1">{step.reasoning}</p>
                </div>
              )}
              {step.actions?.length > 0 && (
                <div>
                  <div className="text-xs font-medium text-muted-foreground">Actions</div>
                  <ul className="mt-1 space-y-1">
                    {step.actions.map((a, i) => (
                      <li key={i} className="break-all rounded bg-muted px-2 py-1 font-mono text-xs">{formatAction(a)}</li>
                    ))}
                  </ul>
                </div>
              )}
              {step.actionWarnings?.length > 0 && (
                <ul className="space-y-1 text-xs text-amber-600">
                  {step.actionWarnings.map((w, i) => <li key={i}>⚠ {w}</li>)}
                </ul>
              )}
            </div>
          </div>
        </div>
      ))}

      {report.finalActions?.length > 0 && (
        <div className="rounded-lg border bg-background p-4">
          <div className="mb-3 text-sm font-semibold">Final action buttons tested ({report.finalActions.length})</div>
          <FinalActions actions={report.finalActions} />
        </div>
      )}
    </div>
  );
}

function UiReport({ report }: { report: any }) {
  const buttons: any[] = report.quoteButtons || [];
  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Screenshot path={report.screenshot} alt="Page" className="max-h-[520px] w-full" />
        <div className="space-y-4">
          {report.ctaCheck && (
            <div className="rounded-lg border bg-background p-4 text-sm">
              <div className="mb-2 font-medium">Main call-to-action</div>
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge ok={!!report.ctaCheck.changed} label={report.ctaCheck.changed ? "Works" : "Does nothing"} />
                <span>{report.ctaCheck.label}</span>
              </div>
              {report.ctaCheck.error && <p className="mt-1 text-xs text-red-600">{report.ctaCheck.error}</p>}
            </div>
          )}
        </div>
      </div>

      <div className="rounded-lg border bg-background p-4">
        <div className="mb-3 text-sm font-medium">
          Quote buttons <span className="text-muted-foreground">({buttons.filter(b => b.works).length} of {buttons.length} working)</span>
        </div>
        {buttons.length === 0 ? (
          <p className="text-sm text-muted-foreground">No buttons mentioning &quot;quote&quot; were found on the page.</p>
        ) : (
          <div className="space-y-3">
            {buttons.map((b, i) => (
              <div key={i} className="grid gap-3 border-t pt-3 first:border-t-0 first:pt-0 sm:grid-cols-[minmax(0,1fr)_200px]">
                <div className="text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge ok={!!b.works} label={b.works ? "Works" : "Broken"} />
                    <span className="font-medium">{b.label}</span>
                    {b.position && <span className="text-xs text-muted-foreground">{b.position}</span>}
                  </div>
                  {b.outcome && <p className="mt-1 text-xs text-muted-foreground">{b.outcome}</p>}
                  {b.error && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{b.error}</p>}
                  {b.resultingUrl && <p className="mt-1 truncate text-xs text-muted-foreground">→ {b.resultingUrl}</p>}
                </div>
                <Screenshot path={b.screenshot} alt={b.label} className="max-h-36 w-full" />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export interface ReportMeta {
  kind: "test" | "ui";
  viewport: "desktop" | "mobile";
  created_at: string;
  funnel_id: string;
}

// Loads one saved report and shows it. onLoaded hands the row's details to a page
// that wants to show its own heading.
export function FunnelReportView({ id, onLoaded }: { id: string; onLoaded?: (meta: ReportMeta) => void }) {
  const supabase = useMemo(() => createClient(), []);
  const [row, setRow] = useState<ReportRow | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase.from("funnel_reports").select("*").eq("id", id).maybeSingle();
      if (cancelled) return;
      if (error || !data) {
        setError(error?.message || "Report not found. Only the 2 most recent reports per funnel and device are kept.");
        return;
      }
      setRow(data);
      onLoaded?.(data);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, supabase]);

  if (error) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-400">
        <AlertCircle className="h-4 w-4" /> {error}
      </div>
    );
  }
  if (!row) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  return row.kind === "ui" ? <UiReport report={row.report} /> : <TestReport report={row.report} />;
}