"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/utils/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import {
  Gauge,
  Search,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Smartphone,
  Monitor,
  AlertCircle,
  Zap,
} from "lucide-react";

interface Domain {
  id: string;
  domain_name: string;
  display_name: string | null;
  uptime_url: string;
  category: string | null;
}

interface ResultRow {
  domain_id: string;
  url: string;
  strategy: "mobile" | "desktop";
  performance_score: number | null;
  accessibility_score: number | null;
  best_practices_score: number | null;
  seo_score: number | null;
  first_contentful_paint: number | null;
  largest_contentful_paint: number | null;
  total_blocking_time: number | null;
  cumulative_layout_shift: number | null;
  speed_index: number | null;
  time_to_interactive: number | null;
  tested_at: string;
}

type ResultsMap = Record<string, { mobile?: ResultRow; desktop?: ResultRow }>;

const TEST_TIMEOUT_MS = 4 * 60 * 1000;
const POLL_MS = 5000;

function normalizeUrl(url: string): string {
  let n = (url || "").trim();
  if (n && !n.startsWith("http://") && !n.startsWith("https://")) n = `https://${n}`;
  return n;
}

const fmtMs = (v: number | null | undefined) =>
  v === null || v === undefined ? "—" : v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`;
const fmtCls = (v: number | null | undefined) => (v === null || v === undefined ? "—" : v.toFixed(3));

function scoreColor(score: number | null | undefined): string {
  if (score === null || score === undefined || score < 0) return "bg-muted text-muted-foreground";
  if (score >= 90) return "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-400";
  if (score >= 50) return "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400";
  return "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400";
}

function ScorePill({ row, testing, icon: Icon }: { row?: ResultRow; testing: boolean; icon: any }) {
  if (testing && (!row || row.performance_score === null)) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-100 px-2.5 py-1 text-xs font-medium text-blue-700 dark:bg-blue-950 dark:text-blue-400">
        <RefreshCw className="h-3 w-3 animate-spin" />
        Testing
      </span>
    );
  }
  const score = row?.performance_score;
  if (score === null || score === undefined) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">
        <Icon className="h-3 w-3" /> —
      </span>
    );
  }
  if (score < 0) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-red-100 px-2.5 py-1 text-xs font-medium text-red-700 dark:bg-red-950 dark:text-red-400">
        <AlertCircle className="h-3 w-3" /> Error
      </span>
    );
  }
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${scoreColor(score)}`}>
      <Icon className="h-3 w-3" />
      {score}
    </span>
  );
}

const METRICS: Array<{ key: keyof ResultRow; label: string; fmt: (v: any) => string }> = [
  { key: "first_contentful_paint", label: "First Contentful Paint", fmt: fmtMs },
  { key: "largest_contentful_paint", label: "Largest Contentful Paint", fmt: fmtMs },
  { key: "total_blocking_time", label: "Total Blocking Time", fmt: fmtMs },
  { key: "cumulative_layout_shift", label: "Cumulative Layout Shift", fmt: fmtCls },
  { key: "speed_index", label: "Speed Index", fmt: fmtMs },
  { key: "time_to_interactive", label: "Time to Interactive", fmt: fmtMs },
];

const CATEGORIES: Array<{ key: keyof ResultRow; label: string }> = [
  { key: "performance_score", label: "Performance" },
  { key: "accessibility_score", label: "Accessibility" },
  { key: "best_practices_score", label: "Best Practices" },
  { key: "seo_score", label: "SEO" },
];

function StrategyDetail({ row, title, icon: Icon }: { row?: ResultRow; title: string; icon: any }) {
  return (
    <div className="rounded-lg border bg-background p-4">
      <div className="mb-3 flex items-center gap-2 text-sm font-medium">
        <Icon className="h-4 w-4 text-muted-foreground" />
        {title}
        {row && (
          <span className="ml-auto text-xs font-normal text-muted-foreground">
            {new Date(row.tested_at).toLocaleString()}
          </span>
        )}
      </div>
      {!row || row.performance_score === null || row.performance_score < 0 ? (
        <p className="text-sm text-muted-foreground">
          {row && row.performance_score !== null && row.performance_score < 0
            ? "Last test failed — run it again."
            : "No results yet."}
        </p>
      ) : (
        <>
          <div className="mb-3 grid grid-cols-4 gap-2">
            {CATEGORIES.map(({ key, label }) => (
              <div key={key} className="text-center">
                <div
                  className={`mx-auto flex h-11 w-11 items-center justify-center rounded-full text-sm font-bold ${scoreColor(row[key] as number | null)}`}
                >
                  {row[key] ?? "—"}
                </div>
                <div className="mt-1 text-[10px] leading-tight text-muted-foreground">{label}</div>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-3">
            {METRICS.map(({ key, label, fmt }) => (
              <div key={key} className="flex flex-col">
                <span className="text-muted-foreground">{label}</span>
                <span className="font-medium">{fmt(row[key])}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export default function SpeedTestPage() {
  const [authChecked, setAuthChecked] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [domains, setDomains] = useState<Domain[]>([]);
  const [results, setResults] = useState<ResultsMap>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // domainId -> epoch ms when the test was requested
  const [testing, setTesting] = useState<Record<string, number>>({});
  const [testErrors, setTestErrors] = useState<Record<string, string>>({});
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");

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

  // Newest mobile/desktop result per domain for its main URL (fall back to
  // newest of any URL so old data still shows).
  const buildResultsMap = (rows: ResultRow[], domainList: Domain[]): ResultsMap => {
    const mainUrlByDomain: Record<string, string> = {};
    domainList.forEach((d) => (mainUrlByDomain[d.id] = normalizeUrl(d.uptime_url)));

    const map: ResultsMap = {};
    for (const row of rows) {
      // rows are ordered tested_at desc — first match per slot wins
      const slot = (map[row.domain_id] ||= {});
      const isMain = row.url === mainUrlByDomain[row.domain_id];
      const current = slot[row.strategy];
      const currentIsMain = current && current.url === mainUrlByDomain[row.domain_id];
      if (!current || (isMain && !currentIsMain)) slot[row.strategy] = row;
    }
    return map;
  };

  const fetchResults = async (domainList: Domain[]): Promise<ResultsMap> => {
    const { data, error: err } = await supabase
      .from("pagespeed_results")
      .select(
        "domain_id, url, strategy, performance_score, accessibility_score, best_practices_score, seo_score, first_contentful_paint, largest_contentful_paint, total_blocking_time, cumulative_layout_shift, speed_index, time_to_interactive, tested_at"
      )
      .in("domain_id", domainList.map((d) => d.id))
      .order("tested_at", { ascending: false })
      .limit(3000);
    if (err) throw err;
    return buildResultsMap((data || []) as ResultRow[], domainList);
  };

  const loadAll = async () => {
    setLoading(true);
    setError("");
    try {
      const { data: domainsData, error: domainsError } = await supabase
        .from("domains")
        .select("id, domain_name, display_name, uptime_url, category")
        .order("domain_name", { ascending: true });
      if (domainsError) throw domainsError;
      const list = (domainsData || []) as Domain[];
      setDomains(list);
      if (list.length) setResults(await fetchResults(list));
    } catch (err: any) {
      console.error("Error loading speed test data:", err);
      setError(err.message || "Failed to load data");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (authChecked) loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authChecked]);

  // Poll while any test is running; a domain is done when both strategies have
  // a non-null score newer than the request time.
  useEffect(() => {
    const ids = Object.keys(testing);
    if (ids.length === 0) return;
    const interval = setInterval(async () => {
      try {
        const testingDomains = domains.filter((d) => testing[d.id]);
        if (testingDomains.length === 0) return;
        const fresh = await fetchResults(testingDomains);
        setResults((prev) => ({ ...prev, ...fresh }));

        setTesting((prev) => {
          const next = { ...prev };
          for (const d of testingDomains) {
            const since = prev[d.id];
            if (!since) continue;
            const slot = fresh[d.id] || {};
            const done = (["mobile", "desktop"] as const).every((s) => {
              const row = slot[s];
              return row && row.performance_score !== null && new Date(row.tested_at).getTime() >= since;
            });
            if (done) {
              delete next[d.id];
            } else if (Date.now() - since > TEST_TIMEOUT_MS) {
              delete next[d.id];
              setTestErrors((e) => ({ ...e, [d.id]: "Test timed out — try again." }));
            }
          }
          return next;
        });
      } catch (err) {
        console.error("Polling error:", err);
      }
    }, POLL_MS);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Object.keys(testing).join(","), domains]);

  const runTest = async (domain: Domain) => {
    setTestErrors((e) => {
      const next = { ...e };
      delete next[domain.id];
      return next;
    });
    setTesting((t) => ({ ...t, [domain.id]: Date.now() }));
    try {
      const res = await fetch("/api/pagespeed/background", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domainId: domain.id,
          url: domain.uptime_url,
          strategies: ["mobile", "desktop"],
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Failed to start test (${res.status})`);
      }
    } catch (err: any) {
      setTesting((t) => {
        const next = { ...t };
        delete next[domain.id];
        return next;
      });
      setTestErrors((e) => ({ ...e, [domain.id]: err.message || "Failed to start test" }));
    }
  };

  const toggleExpand = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const categories = Array.from(new Set(domains.map((d) => d.category).filter(Boolean))) as string[];
  const filtered = domains.filter((d) => {
    const q = search.trim().toLowerCase();
    const matchesSearch =
      !q ||
      d.domain_name.toLowerCase().includes(q) ||
      (d.display_name || "").toLowerCase().includes(q) ||
      d.uptime_url.toLowerCase().includes(q);
    const matchesCategory = categoryFilter === "all" || d.category === categoryFilter;
    return matchesSearch && matchesCategory;
  });

  if (!authChecked) return null;

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8">
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <Gauge className="h-6 w-6" />
            Page Speed
          </h1>
          <p className="text-sm text-muted-foreground">
            {domains.length} domain{domains.length === 1 ? "" : "s"} · powered by PageSpeed Insights
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" asChild>
            <Link href="/gtmetrix">
              <Zap className="mr-1.5 h-4 w-4" /> GTmetrix
            </Link>
          </Button>
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search domains…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-56 pl-8"
            />
          </div>
          {categories.length > 0 && (
            <Select value={categoryFilter} onValueChange={setCategoryFilter}>
              <SelectTrigger className="w-36">
                <SelectValue placeholder="Category" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All categories</SelectItem>
                {categories.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      </div>

      {error && (
        <div className="mb-4 flex items-center gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-400">
          <AlertCircle className="h-4 w-4" /> {error}
        </div>
      )}

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full rounded-lg" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground">No domains found.</p>
      ) : (
        <div className="divide-y rounded-lg border">
          {filtered.map((domain) => {
            const slot = results[domain.id] || {};
            const isTesting = !!testing[domain.id];
            const isExpanded = expanded.has(domain.id);
            const lastTested = slot.mobile?.tested_at || slot.desktop?.tested_at;
            return (
              <div key={domain.id}>
                <div
                  className="flex cursor-pointer flex-wrap items-center gap-3 p-4 hover:bg-muted/50"
                  onClick={() => toggleExpand(domain.id)}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{domain.display_name || domain.domain_name}</div>
                    <div className="truncate text-xs text-muted-foreground">{domain.uptime_url}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <ScorePill row={slot.mobile} testing={isTesting} icon={Smartphone} />
                    <ScorePill row={slot.desktop} testing={isTesting} icon={Monitor} />
                  </div>
                  {lastTested && !isTesting && (
                    <span className="hidden text-xs text-muted-foreground md:inline">
                      {new Date(lastTested).toLocaleDateString()}
                    </span>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={isTesting}
                    onClick={(e) => {
                      e.stopPropagation();
                      runTest(domain);
                    }}
                  >
                    <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${isTesting ? "animate-spin" : ""}`} />
                    {isTesting ? "Testing…" : "Run test"}
                  </Button>
                  {isExpanded ? (
                    <ChevronUp className="h-4 w-4 text-muted-foreground" />
                  ) : (
                    <ChevronDown className="h-4 w-4 text-muted-foreground" />
                  )}
                </div>
                {testErrors[domain.id] && (
                  <div className="flex items-center gap-2 px-4 pb-3 text-xs text-red-600 dark:text-red-400">
                    <AlertCircle className="h-3.5 w-3.5" /> {testErrors[domain.id]}
                  </div>
                )}
                {isExpanded && (
                  <div className="space-y-3 border-t bg-muted/30 p-4">
                    <div className="grid gap-3 lg:grid-cols-2">
                      <StrategyDetail row={slot.mobile} title="Mobile" icon={Smartphone} />
                      <StrategyDetail row={slot.desktop} title="Desktop" icon={Monitor} />
                    </div>
                    <div className="flex justify-end">
                      <Link
                        href={`/speed-test/${domain.id}`}
                        className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:underline"
                      >
                        Full report incl. inner pages <ExternalLink className="h-3 w-3" />
                      </Link>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
