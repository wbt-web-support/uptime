"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { createClient } from "@/utils/supabase/client";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertCircle, ArrowLeft, CheckCircle, ExternalLink, Monitor, MousePointerClick, Smartphone, XCircle } from "lucide-react";

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

function FinalActions({ actions, depth = 0 }: { actions: any[]; depth?: number }) {
  if (!actions?.length) return null;
  return (
    <ul className={depth ? "ml-4 mt-2 space-y-2 border-l pl-3" : "space-y-2"}>
      {actions.map((a, i) => (
        <li key={i} className="text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge ok={!a.error} label={a.error ? "Failed" : "Worked"} />
            <span className="font-medium">{a.label}</span>
            {a.resultingUrl && <span className="truncate text-xs text-muted-foreground">→ {a.resultingUrl}</span>}
          </div>
          {(a.error || a.warning) && (
            <p className={`mt-1 text-xs ${a.error ? "text-red-600 dark:text-red-400" : "text-amber-600"}`}>{a.error || a.warning}</p>
          )}
          {a.screenshot && <Screenshot path={a.screenshot} alt={a.label} className="mt-2 max-h-48" />}
          <FinalActions actions={a.nestedActions} depth={depth + 1} />
        </li>
      ))}
    </ul>
  );
}

function TestReport({ report }: { report: any }) {
  const steps: any[] = report.steps || [];
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border bg-background p-4">
          <div className="text-xs text-muted-foreground">Result</div>
          <div className="mt-1"><StatusBadge ok={!!report.completed} label={report.completed ? "Completed" : "Did not complete"} /></div>
        </div>
        <div className="rounded-lg border bg-background p-4">
          <div className="text-xs text-muted-foreground">Steps walked</div>
          <div className="mt-1 text-lg font-semibold">{steps.length}</div>
        </div>
        <div className="rounded-lg border bg-background p-4">
          <div className="text-xs text-muted-foreground">Tracking on every step</div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            <StatusBadge ok={!!report.gtmPresentThroughout} label="GTM" />
            <StatusBadge ok={!!report.gtagPresentThroughout} label="gtag" />
          </div>
        </div>
      </div>

      {report.failure && (
        <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-400">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> {report.failure}
        </div>
      )}

      {steps.length > 0 && (
        <div className="flex gap-2 overflow-x-auto pb-2">
          {steps.map(step => (
            <a key={step.stepNumber} href={`#step-${step.stepNumber}`} className="shrink-0 text-center">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={shot(step.screenshot)}
                alt={`Step ${step.stepNumber}`}
                loading="lazy"
                className="h-24 w-36 rounded border object-cover object-top"
              />
              <span className="text-xs text-muted-foreground">Step {step.stepNumber}</span>
            </a>
          ))}
        </div>
      )}

      {steps.map(step => (
        <div key={step.stepNumber} id={`step-${step.stepNumber}`} className="scroll-mt-20 rounded-lg border bg-background p-4">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className="font-medium">Step {step.stepNumber}</span>
            <span className="truncate text-xs text-muted-foreground">{step.url}</span>
            <span className="ml-auto flex gap-1.5">
              <StatusBadge ok={!!step.tracking?.gtmPresent} label="GTM" />
              <StatusBadge ok={!!step.tracking?.gtagPresent} label="gtag" />
            </span>
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
                    {step.actions.map((a: any, i: number) => (
                      <li key={i} className="break-all rounded bg-muted px-2 py-1 font-mono text-xs">
                        {a.type} {a.selector}{a.value !== undefined ? ` = "${a.value}"` : ""}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {step.actionWarnings?.length > 0 && (
                <ul className="space-y-1 text-xs text-amber-600">
                  {step.actionWarnings.map((w: string, i: number) => <li key={i}>⚠ {w}</li>)}
                </ul>
              )}
              {step.uiIssues?.length > 0 && (
                <div>
                  <div className="text-xs font-medium text-muted-foreground">UI issues spotted</div>
                  <ul className="mt-1 list-disc space-y-1 pl-4 text-xs">
                    {step.uiIssues.map((u: string, i: number) => <li key={i}>{u}</li>)}
                  </ul>
                </div>
              )}
            </div>
          </div>
        </div>
      ))}

      {report.finalActions?.length > 0 && (
        <div className="rounded-lg border bg-background p-4">
          <div className="mb-3 text-sm font-medium">Buttons on the results page</div>
          <FinalActions actions={report.finalActions} />
        </div>
      )}

      <Collapsible title="Console errors" items={report.consoleErrors} />
      <Collapsible title="Page errors" items={report.pageErrors} />
      <Collapsible title="API calls" items={report.apiCalls} />
    </div>
  );
}

function UiReport({ report }: { report: any }) {
  const buttons: any[] = report.quoteButtons || [];
  const issues: string[] = report.uiIssues || [];
  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Screenshot path={report.screenshot} alt="Page" className="max-h-[520px] w-full" />
        <div className="space-y-4">
          <div className="rounded-lg border bg-background p-4">
            <div className="mb-2 text-sm font-medium">Visual problems</div>
            {issues.length === 0 ? (
              <p className="text-sm text-green-600 dark:text-green-400">None found.</p>
            ) : (
              <ul className="list-disc space-y-1 pl-4 text-sm">
                {issues.map((u, i) => <li key={i}>{u}</li>)}
              </ul>
            )}
          </div>
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

export default function FunnelReportPage() {
  const { id } = useParams<{ id: string }>();
  const supabase = useMemo(() => createClient(), []);
  const [row, setRow] = useState<ReportRow | null>(null);
  const [funnel, setFunnel] = useState<{ name: string; url: string } | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase.from("funnel_reports").select("*").eq("id", id).maybeSingle();
      if (error || !data) {
        setError(error?.message || "Report not found. Only the 5 most recent reports per funnel and device are kept.");
        setLoading(false);
        return;
      }
      setRow(data);
      const { data: f } = await supabase.from("funnels").select("name, url").eq("id", data.funnel_id).maybeSingle();
      setFunnel(f);
      setLoading(false);
    })();
  }, [id, supabase]);

  const DeviceIcon = row?.viewport === "mobile" ? Smartphone : Monitor;

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8">
      <Link href="/funnel-test" className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Funnel Test
      </Link>

      {loading ? (
        <div className="space-y-3">
          <Skeleton className="h-10 w-72" />
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : error || !row ? (
        <div className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-400">
          <AlertCircle className="h-4 w-4" /> {error}
        </div>
      ) : (
        <>
          <div className="mb-6">
            <h1 className="flex flex-wrap items-center gap-2 text-2xl font-bold">
              {row.kind === "ui" ? <MousePointerClick className="h-6 w-6" /> : <DeviceIcon className="h-6 w-6" />}
              {funnel?.name || "Funnel"}
            </h1>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
              <span>{row.kind === "ui" ? "UI check" : "Funnel test"}</span>
              <span>·</span>
              <span className="inline-flex items-center gap-1"><DeviceIcon className="h-3.5 w-3.5" />{row.viewport === "mobile" ? "Mobile" : "Desktop"}</span>
              <span>·</span>
              <span>{new Date(row.created_at).toLocaleString()}</span>
              {funnel?.url && (
                <a href={funnel.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:text-foreground">
                  · {funnel.url} <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </p>
          </div>
          {row.kind === "ui" ? <UiReport report={row.report} /> : <TestReport report={row.report} />}
        </>
      )}
    </div>
  );
}
