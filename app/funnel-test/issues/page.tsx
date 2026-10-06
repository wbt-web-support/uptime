"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient } from "@/utils/supabase/client";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertCircle, ArrowLeft, Monitor, Smartphone, X } from "lucide-react";
import { CATEGORY_CLASS, categorize, explainFailure, OWNER_LABEL, type FailureCategory, type WalkSummary } from "@/utils/funnel-report";

// Every saved funnel test run, grouped by what went wrong - the funnel tester
// dashboard's Issues page, read from funnel_reports instead of the tester's files.
// Only the small _summary stored with each report is fetched, not the full report.

interface Run {
  id: string;
  funnelName: string;
  // Added by hand on the Funnel Test page (no client), shown in its own tab
  manual: boolean;
  viewport: "desktop" | "mobile";
  createdAt: string;
  summary: WalkSummary;
}

function StatTile({ label, value, className = "" }: { label: string; value: number; className?: string }) {
  return (
    <div className="min-w-[140px] flex-1 rounded-lg border bg-background p-4">
      <div className={`text-2xl font-bold ${className}`}>{value}</div>
      <div className="mt-0.5 text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

export default function FunnelIssuesPage() {
  const supabase = useMemo(() => createClient(), []);
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<FailureCategory | "All">("All");
  const [source, setSource] = useState<"clients" | "manual">("clients");

  useEffect(() => {
    (async () => {
      const [reportsRes, funnelsRes] = await Promise.all([
        supabase
          .from("funnel_reports")
          .select("id, funnel_id, viewport, created_at, status, summary:report->_summary, failure:report->>failure, completed:report->completed")
          .eq("kind", "test")
          .order("created_at", { ascending: false })
          .limit(1000),
        supabase.from("funnels").select("id, name, domain_id"),
      ]);
      if (reportsRes.error || funnelsRes.error) {
        setError((reportsRes.error || funnelsRes.error)!.message);
        return;
      }
      const names = new Map((funnelsRes.data || []).map(f => [f.id, f.name]));
      const manualIds = new Set((funnelsRes.data || []).filter(f => !f.domain_id).map(f => f.id));
      setRuns(
        (reportsRes.data || []).map((r: any) => {
          // Reports saved before summaries existed: rebuild what the failure text allows
          const completed = r.completed === true;
          const summary: WalkSummary = r.summary ?? {
            completed,
            failure: r.failure ?? null,
            category: categorize(completed, r.failure ?? null),
            knownLimitation: null,
            uiIssueCount: 0,
            trackingOk: true,
            steps: 0,
          };
          return {
            id: r.id,
            funnelName: names.get(r.funnel_id) ?? "Deleted funnel",
            manual: manualIds.has(r.funnel_id),
            viewport: r.viewport,
            createdAt: r.created_at,
            summary,
          };
        })
      );
    })();
  }, [supabase]);

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
          <AlertCircle className="h-4 w-4" /> Could not load issues: {error}
        </div>
      </div>
    );
  }

  const allRuns = runs;
  const manualCount = allRuns?.filter(r => r.manual).length ?? 0;
  const clientCount = (allRuns?.length ?? 0) - manualCount;
  // Everything below is for the chosen tab only
  const tabRuns = allRuns?.filter(r => r.manual === (source === "manual")) ?? null;
  const total = tabRuns?.length ?? 0;
  const passed = tabRuns?.filter(r => r.summary.category === "Passed").length ?? 0;
  const knownLimitations = tabRuns?.filter(r => !r.summary.completed && r.summary.knownLimitation).length ?? 0;
  const actionable = total - passed - knownLimitations;
  const uiIssues = tabRuns?.reduce((n, r) => n + r.summary.uiIssueCount, 0) ?? 0;

  const counts = new Map<FailureCategory, number>();
  tabRuns?.forEach(r => counts.set(r.summary.category, (counts.get(r.summary.category) ?? 0) + 1));
  const failureCategories = Array.from(counts.entries())
    .filter(([cat]) => cat !== "Passed")
    .sort((a, b) => b[1] - a[1]);

  const visible = !tabRuns ? [] : filter === "All" ? tabRuns : tabRuns.filter(r => r.summary.category === filter);

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8">
      {backLink}
      <h1 className="text-2xl font-bold">Issues</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        Every saved funnel test run, grouped by what went wrong. The last 5 runs per funnel and device are kept.
      </p>

      {!runs ? (
        <div className="space-y-3">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : (
        <>
          {/* Client websites and websites added by hand are kept apart */}
          <div className="mb-4 inline-flex rounded-lg border p-1">
            {([
              { id: "clients", label: "Client websites", count: clientCount },
              { id: "manual", label: "Added manually", count: manualCount },
            ] as const).map(tab => (
              <button
                key={tab.id}
                type="button"
                onClick={() => {
                  setSource(tab.id);
                  setFilter("All");
                }}
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                  source === tab.id ? "bg-brand text-white" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {tab.label} <span className="opacity-75">({tab.count})</span>
              </button>
            ))}
          </div>

          <div className="mb-6 flex flex-wrap gap-3">
            <StatTile label="Total runs" value={total} />
            <StatTile label="Passed" value={passed} className="text-green-600 dark:text-green-400" />
            <StatTile label="Actionable failures" value={actionable} className="text-red-600 dark:text-red-400" />
            <StatTile label="Known limitations" value={knownLimitations} className="text-sky-600 dark:text-sky-400" />
            <StatTile label="UI issues found" value={uiIssues} className="text-violet-600 dark:text-violet-400" />
          </div>

          {failureCategories.length > 0 && (
            <div className="mb-6 rounded-lg border bg-background p-4">
              <div className="text-sm font-semibold">Failure breakdown</div>
              <div className="mt-3 flex flex-wrap gap-2">
                {failureCategories.map(([cat, count]) => (
                  <button
                    key={cat}
                    onClick={() => setFilter(filter === cat ? "All" : cat)}
                    className={`rounded-full px-3 py-1 text-xs font-semibold ${CATEGORY_CLASS[cat]} ${filter === cat ? "ring-2 ring-current ring-offset-1 ring-offset-background" : ""}`}
                  >
                    {cat} · {count}
                  </button>
                ))}
                {filter !== "All" && (
                  <button onClick={() => setFilter("All")} className="inline-flex items-center gap-1 rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground">
                    Clear filter <X className="h-3 w-3" />
                  </button>
                )}
              </div>
            </div>
          )}

          <div className="rounded-lg border bg-background p-4">
            <div className="text-sm font-semibold">
              {filter === "All" ? "All runs" : filter} ({visible.length})
            </div>
            {visible.length === 0 && <p className="mt-3 text-sm text-muted-foreground">No runs yet.</p>}
            <div className="mt-3 space-y-2">
              {visible.map(run => {
                const isLimitation = !run.summary.completed && !!run.summary.knownLimitation;
                return (
                  <Link
                    key={run.id}
                    href={`/funnel-test/report/${run.id}`}
                    className="flex items-start justify-between gap-3 rounded-md border p-3 hover:bg-muted/50"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-semibold">{run.funnelName}</div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
                        <span>{new Date(run.createdAt).toLocaleString()}</span>
                        <span>·</span>
                        <span className="inline-flex items-center gap-1">
                          {run.viewport === "mobile" ? <Smartphone className="h-3 w-3" /> : <Monitor className="h-3 w-3" />}
                          {run.viewport}
                        </span>
                        {run.summary.uiIssueCount > 0 && <span>· 🎨 {run.summary.uiIssueCount} UI issue(s)</span>}
                        {!run.summary.trackingOk && <span>· ⚠️ tracking gap</span>}
                      </div>
                      {isLimitation ? (
                        <div className="mt-1.5 text-xs text-sky-700 dark:text-sky-400">🔒 {run.summary.knownLimitation}</div>
                      ) : (
                        (() => {
                          const e = explainFailure(run.summary.failure, run.summary.siteProblem);
                          return e && (
                            <div className="mt-1.5 text-xs">
                              <span className="font-semibold">{OWNER_LABEL[e.owner]}:</span> {e.title}
                              <div className="mt-0.5 text-muted-foreground">How to fix: {e.fix}</div>
                            </div>
                          );
                        })()
                      )}
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${CATEGORY_CLASS[run.summary.category]}`}>
                        {run.summary.category}
                      </span>
                      {isLimitation && (
                        <span className="rounded-full bg-sky-100 px-2.5 py-0.5 text-xs font-semibold text-sky-700 dark:bg-sky-950 dark:text-sky-400">
                          🔒 Known limitation
                        </span>
                      )}
                    </div>
                  </Link>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
