"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/utils/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Search,
  RefreshCw,
  ExternalLink,
  AlertCircle,
  MapPin,
  ChevronDown,
  ChevronUp,
  Zap,
} from "lucide-react";

interface Domain {
  id: string;
  domain_name: string;
  display_name: string | null;
  uptime_url: string;
}

interface GTRow {
  id: string;
  domain_id: string;
  url: string;
  location: string | null;
  gtmetrix_grade: string | null;
  performance_score: number | null;
  structure_score: number | null;
  first_contentful_paint: number | null;
  largest_contentful_paint: number | null;
  total_blocking_time: number | null;
  cumulative_layout_shift: number | null;
  speed_index: number | null;
  time_to_interactive: number | null;
  onload_time: number | null;
  fully_loaded_time: number | null;
  page_bytes: number | null;
  page_requests: number | null;
  report_url: string | null;
  error: string | null;
  tested_at: string;
}

const POLL_MS = 5000;
const TEST_TIMEOUT_MS = 5 * 60 * 1000;

const fmtMs = (v: number | null | undefined) =>
  v === null || v === undefined ? "—" : v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`;
const fmtBytes = (v: number | null | undefined) =>
  v === null || v === undefined ? "—" : v >= 1048576 ? `${(v / 1048576).toFixed(1)}MB` : `${Math.round(v / 1024)}KB`;

function gradeColor(grade: string | null): string {
  if (!grade) return "bg-muted text-muted-foreground";
  if (grade.startsWith("A")) return "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-400";
  if (grade.startsWith("B")) return "bg-lime-100 text-lime-700 dark:bg-lime-950 dark:text-lime-400";
  if (grade.startsWith("C")) return "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400";
  return "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400";
}

function scoreColor(score: number | null | undefined): string {
  if (score === null || score === undefined) return "bg-muted text-muted-foreground";
  if (score >= 90) return "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-400";
  if (score >= 50) return "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400";
  return "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400";
}

const DETAIL_METRICS: Array<{ key: keyof GTRow; label: string; fmt: (v: any) => string }> = [
  { key: "first_contentful_paint", label: "First Contentful Paint", fmt: fmtMs },
  { key: "largest_contentful_paint", label: "Largest Contentful Paint", fmt: fmtMs },
  { key: "total_blocking_time", label: "Total Blocking Time", fmt: fmtMs },
  {
    key: "cumulative_layout_shift",
    label: "Cumulative Layout Shift",
    fmt: (v) => (v === null || v === undefined ? "—" : Number(v).toFixed(3)),
  },
  { key: "speed_index", label: "Speed Index", fmt: fmtMs },
  { key: "time_to_interactive", label: "Time to Interactive", fmt: fmtMs },
  { key: "onload_time", label: "Onload Time", fmt: fmtMs },
  { key: "fully_loaded_time", label: "Fully Loaded", fmt: fmtMs },
  { key: "page_bytes", label: "Page Size", fmt: fmtBytes },
  {
    key: "page_requests",
    label: "Requests",
    fmt: (v) => (v === null || v === undefined ? "—" : String(v)),
  },
];

function RunRecord({ row, isLatest }: { row: GTRow; isLatest: boolean }) {
  const [open, setOpen] = useState(isLatest);
  const running = row.performance_score === null && !row.error;

  return (
    <div className="rounded-lg border bg-background">
      <div
        className="flex cursor-pointer flex-wrap items-center gap-3 p-4 hover:bg-muted/50"
        onClick={() => setOpen((o) => !o)}
      >
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">{new Date(row.tested_at).toLocaleString()}</div>
          <div className="truncate text-xs text-muted-foreground">{row.url}</div>
        </div>
        {running ? (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-100 px-2.5 py-1 text-xs font-medium text-blue-700 dark:bg-blue-950 dark:text-blue-400">
            <RefreshCw className="h-3 w-3 animate-spin" /> Testing
          </span>
        ) : row.error ? (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-red-100 px-2.5 py-1 text-xs font-medium text-red-700 dark:bg-red-950 dark:text-red-400">
            <AlertCircle className="h-3 w-3" /> Failed
          </span>
        ) : (
          <div className="flex items-center gap-2">
            <span
              className={`inline-flex h-8 w-8 items-center justify-center rounded-full text-sm font-bold ${gradeColor(row.gtmetrix_grade)}`}
              title="GTmetrix Grade"
            >
              {row.gtmetrix_grade || "—"}
            </span>
            <span
              className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${scoreColor(row.performance_score)}`}
              title="Performance"
            >
              Perf {row.performance_score}
            </span>
            <span
              className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${scoreColor(row.structure_score)}`}
              title="Structure"
            >
              Struct {row.structure_score ?? "—"}
            </span>
          </div>
        )}
        {open ? (
          <ChevronUp className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        )}
      </div>
      {open && (
        <div className="border-t p-4">
          {running ? (
            <p className="text-sm text-muted-foreground">
              Test in progress on the London (UK) server — usually takes 30–90 seconds.
            </p>
          ) : row.error ? (
            <p className="text-sm text-red-600 dark:text-red-400">{row.error}</p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-5">
                {DETAIL_METRICS.map(({ key, label, fmt }) => (
                  <div key={key} className="flex flex-col">
                    <span className="text-muted-foreground">{label}</span>
                    <span className="font-medium">{fmt(row[key])}</span>
                  </div>
                ))}
              </div>
              {row.report_url && (
                <a
                  href={row.report_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-3 inline-flex items-center gap-1 text-xs text-blue-600 underline-offset-2 hover:underline dark:text-blue-400"
                >
                  Full GTmetrix report (waterfall, video, recommendations)
                  <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default function GTmetrixPage() {
  const [authChecked, setAuthChecked] = useState(false);
  const [domains, setDomains] = useState<Domain[]>([]);
  const [loadingDomains, setLoadingDomains] = useState(true);
  const [search, setSearch] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selected, setSelected] = useState<Domain | null>(null);
  const [history, setHistory] = useState<GTRow[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [runningSince, setRunningSince] = useState<number | null>(null);
  const [runError, setRunError] = useState("");
  const [credits, setCredits] = useState<number | null>(null);
  const [configured, setConfigured] = useState<boolean | null>(null);

  const supabase = useRef(createClient()).current;
  const router = useRouter();

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (!data?.session) {
        router.push("/sign-in");
        return;
      }
      setAuthChecked(true);
    });
  }, [supabase, router]);

  useEffect(() => {
    if (!authChecked) return;
    (async () => {
      setLoadingDomains(true);
      const { data } = await supabase
        .from("domains")
        .select("id, domain_name, display_name, uptime_url")
        .order("domain_name", { ascending: true });
      setDomains((data || []) as Domain[]);
      setLoadingDomains(false);
    })();
    fetch("/api/gtmetrix")
      .then((r) => r.json())
      .then((d) => {
        setConfigured(!!d.configured);
        setCredits(typeof d.credits === "number" ? d.credits : null);
      })
      .catch(() => setConfigured(null));
  }, [authChecked, supabase]);

  const fetchHistory = async (domainId: string): Promise<GTRow[]> => {
    const { data } = await supabase
      .from("gtmetrix_results")
      .select("*")
      .eq("domain_id", domainId)
      .order("tested_at", { ascending: false })
      .limit(20);
    return (data || []) as GTRow[];
  };

  const selectDomain = async (domain: Domain) => {
    setSelected(domain);
    setPickerOpen(false);
    setSearch("");
    setRunError("");
    setRunningSince(null);
    setLoadingHistory(true);
    setHistory(await fetchHistory(domain.id));
    setLoadingHistory(false);
  };

  // Poll history while a run is in flight; done when the newest row resolves.
  useEffect(() => {
    if (!runningSince || !selected) return;
    const interval = setInterval(async () => {
      const rows = await fetchHistory(selected.id);
      setHistory(rows);
      const newest = rows[0];
      const resolved = newest && (newest.performance_score !== null || newest.error);
      if (resolved) {
        setRunningSince(null);
        // refresh remaining credits after a completed run
        fetch("/api/gtmetrix")
          .then((r) => r.json())
          .then((d) => setCredits(typeof d.credits === "number" ? d.credits : null))
          .catch(() => {});
      } else if (Date.now() - runningSince > TEST_TIMEOUT_MS) {
        setRunningSince(null);
        setRunError("Test timed out — check GTmetrix or try again.");
      }
    }, POLL_MS);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runningSince, selected?.id]);

  const runTest = async () => {
    if (!selected) return;
    setRunError("");
    setRunningSince(Date.now());
    try {
      const res = await fetch("/api/gtmetrix", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domainId: selected.id, url: selected.uptime_url }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Failed to start test (${res.status})`);
      }
      setHistory(await fetchHistory(selected.id));
    } catch (err: any) {
      setRunningSince(null);
      setRunError(err.message || "Failed to start test");
    }
  };

  const q = search.trim().toLowerCase();
  const filtered = q
    ? domains.filter(
        (d) =>
          d.domain_name.toLowerCase().includes(q) ||
          (d.display_name || "").toLowerCase().includes(q) ||
          d.uptime_url.toLowerCase().includes(q)
      )
    : domains;

  if (!authChecked) return null;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8">
      <div className="mb-2 flex items-center justify-between">
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <Zap className="h-6 w-6" />
          GTmetrix
        </h1>
        {credits !== null && (
          <span className="rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground">
            {credits} API credit{credits === 1 ? "" : "s"} left
          </span>
        )}
      </div>
      <p className="mb-6 flex items-center gap-1.5 text-sm text-muted-foreground">
        <MapPin className="h-3.5 w-3.5" />
        Tests run from London, UK · one credit-costing test per click, no bulk runs
      </p>

      {configured === false && (
        <div className="mb-4 flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-400">
          <AlertCircle className="h-4 w-4 shrink-0" />
          GTmetrix API key is not configured. Add GTMETRIX_API_KEY to the environment variables.
        </div>
      )}

      {/* Big domain picker */}
      <div className="relative mb-6">
        <Search className="absolute left-3 top-3.5 h-5 w-5 text-muted-foreground" />
        <Input
          placeholder={selected ? selected.display_name || selected.domain_name : "Search and select a domain…"}
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPickerOpen(true);
          }}
          onFocus={() => setPickerOpen(true)}
          className="h-12 pl-10 text-base"
        />
        {pickerOpen && (
          <div className="absolute z-10 mt-1 max-h-72 w-full overflow-y-auto rounded-lg border bg-background shadow-lg">
            {loadingDomains ? (
              <div className="p-3">
                <Skeleton className="h-8 w-full" />
              </div>
            ) : filtered.length === 0 ? (
              <p className="p-3 text-sm text-muted-foreground">No matching domains.</p>
            ) : (
              filtered.map((d) => (
                <button
                  key={d.id}
                  className="flex w-full flex-col items-start px-4 py-2.5 text-left hover:bg-muted"
                  onClick={() => selectDomain(d)}
                >
                  <span className="text-sm font-medium">{d.display_name || d.domain_name}</span>
                  <span className="text-xs text-muted-foreground">{d.uptime_url}</span>
                </button>
              ))
            )}
          </div>
        )}
      </div>
      {pickerOpen && <div className="fixed inset-0 z-0" onClick={() => setPickerOpen(false)} />}

      {selected && (
        <div className="space-y-4">
          <div className="flex items-center justify-between rounded-lg border bg-muted/30 p-4">
            <div className="min-w-0">
              <div className="font-medium">{selected.display_name || selected.domain_name}</div>
              <div className="truncate text-xs text-muted-foreground">{selected.uptime_url}</div>
            </div>
            <Button onClick={runTest} disabled={!!runningSince || configured === false}>
              <RefreshCw className={`mr-1.5 h-4 w-4 ${runningSince ? "animate-spin" : ""}`} />
              {runningSince ? "Testing…" : "Run GTmetrix test"}
            </Button>
          </div>

          {runError && (
            <div className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-400">
              <AlertCircle className="h-4 w-4" /> {runError}
            </div>
          )}

          <div>
            <h2 className="mb-2 text-sm font-medium text-muted-foreground">Run history</h2>
            {loadingHistory ? (
              <Skeleton className="h-16 w-full rounded-lg" />
            ) : history.length === 0 ? (
              <p className="rounded-lg border p-6 text-center text-sm text-muted-foreground">
                No GTmetrix runs yet for this domain — hit "Run GTmetrix test" above.
              </p>
            ) : (
              <div className="space-y-2">
                {history.map((row, i) => (
                  <RunRecord key={row.id} row={row} isLatest={i === 0} />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
