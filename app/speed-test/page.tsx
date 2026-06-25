"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/utils/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Gauge, Globe, ExternalLink, AlertCircle, Search, Plus, X, Trash2, Link as LinkIcon, RefreshCw, CheckCircle, Clock, Table as TableIcon, LayoutGrid, Smartphone, Monitor } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";

interface Domain {
  id: string;
  domain_name: string;
  display_name: string | null;
  uptime_url: string;
  created_at: string;
  notify_on_expiry: boolean | null;
  notify_on_downtime: boolean | null;
  category: string | null;
  tag: string | null;
  inner_pages: string[] | null;
}

export default function SpeedTestPage() {
  const [domains, setDomains] = useState<Domain[]>([]);
  const [loading, setLoading] = useState(true);
  const [authChecked, setAuthChecked] = useState(false);
  const [loadingResults, setLoadingResults] = useState(false);
  const [error, setError] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [performanceFilter, setPerformanceFilter] = useState<string>("all");
  const [analysisDataFilter, setAnalysisDataFilter] = useState<string>("all");
  const [sortBy, setSortBy] = useState<"domain" | "newest" | "oldest" | "category">("domain");
  const [viewMode, setViewMode] = useState<"cards" | "table">("cards");
  const [openModal, setOpenModal] = useState<string | null>(null);
  const [newUrl, setNewUrl] = useState("");
  const [savingUrl, setSavingUrl] = useState<string | null>(null);
  const [addingUrls, setAddingUrls] = useState<Set<string>>(new Set());
  const [testingUrls, setTestingUrls] = useState<Set<string>>(new Set());
  const [speedTestResults, setSpeedTestResults] = useState<Record<string, {
    url: string;
    responseTime: number | null;
    status: 'success' | 'error' | 'testing';
    error?: string;
    timestamp: number;
  }>>({});
  const [latestResults, setLatestResults] = useState<Record<string, any>>({});
  const [mobileResults, setMobileResults] = useState<Record<string, any>>({});
  const [desktopResults, setDesktopResults] = useState<Record<string, any>>({});
  const [selectedDomains, setSelectedDomains] = useState<Set<string>>(new Set());
  const [analyzingBatch, setAnalyzingBatch] = useState(false);
  const [analysisLog, setAnalysisLog] = useState<
    { domainId: string; name: string; status: "queued" | "running" | "done" | "error"; finishedAt?: number; message?: string }[]
  >([]);
  const [addDomainData, setAddDomainData] = useState({
    domain_name: "",
    display_name: "",
    uptime_url: "",
    category: "",
    tag: "",
  });
  const [useCustomCategory, setUseCustomCategory] = useState(false);
  const [addingDomain, setAddingDomain] = useState(false);
  const [addDomainError, setAddDomainError] = useState("");
  const [showAddDomain, setShowAddDomain] = useState(false);

  const supabase = createClient();
  const router = useRouter();

  // Gate access: redirect unauthenticated users to login
  useEffect(() => {
    const ensureAuth = async () => {
      const { data, error } = await supabase.auth.getSession();
      if (error) {
        console.error("Auth check failed:", error);
      }
      if (!data?.session) {
        router.push("/login");
        return;
      }
      setAuthChecked(true);
    };
    ensureAuth();
  }, [supabase, router]);

  const fetchDomains = async () => {
    setLoading(true);
    setError("");
    try {
      const { data: domainsData, error: domainsError } = await supabase
        .from("domains")
        .select("*")
        .order("domain_name", { ascending: true });

      if (domainsError) throw domainsError;

      // Parse inner_pages if it's stored as JSON string
      const domainsWithParsedPages = (domainsData || []).map((domain: any) => {
        let innerPages: string[] = [];
        if (domain.inner_pages) {
          try {
            innerPages = typeof domain.inner_pages === 'string'
              ? JSON.parse(domain.inner_pages)
              : domain.inner_pages;
            // Ensure it's an array
            if (!Array.isArray(innerPages)) {
              innerPages = [];
            }
          } catch (e) {
            console.error("Error parsing inner_pages for domain", domain.id, e);
            innerPages = [];
          }
        }
        return {
          ...domain,
          inner_pages: innerPages
        };
      });

      setDomains(domainsWithParsedPages);
      fetchLatestResults(domainsWithParsedPages);
    } catch (err: any) {
      console.error("Error fetching domains:", err);
      setError(err.message || "Failed to fetch domains");
    } finally {
      setLoading(false);
    }
  };

  const fetchLatestResults = async (domainList: Domain[]) => {
    const ids = domainList.map((d) => d.id);
    if (ids.length === 0) return;
    setLoadingResults(true);
    try {
      const { data, error: resultsError } = await supabase
        .from("pagespeed_results")
        .select(
          "id, domain_id, url, strategy, performance_score, accessibility_score, best_practices_score, seo_score, first_contentful_paint, speed_index, time_to_interactive, tested_at"
        )
        .in("domain_id", ids)
        .order("tested_at", { ascending: false });

      if (resultsError) throw resultsError;

      const map: Record<string, any> = {};
      const mobileMap: Record<string, any> = {};
      const desktopMap: Record<string, any> = {};
      // data is ordered tested_at desc, so the first row seen per key is newest.
      (data || []).forEach((row: any) => {
        // Prefer newest mobile result; if none, take newest overall
        if (!map[row.domain_id]) {
          map[row.domain_id] = row;
        } else if (map[row.domain_id].strategy !== "mobile" && row.strategy === "mobile") {
          map[row.domain_id] = row;
        }

        // Newest result per domain for each strategy independently
        if (row.strategy === "mobile" && !mobileMap[row.domain_id]) {
          mobileMap[row.domain_id] = row;
        } else if (row.strategy === "desktop" && !desktopMap[row.domain_id]) {
          desktopMap[row.domain_id] = row;
        }
      });

      setLatestResults(map);
      setMobileResults(mobileMap);
      setDesktopResults(desktopMap);
    } catch (err: any) {
      console.error("Error fetching latest PageSpeed results:", err);
    } finally {
      setLoadingResults(false);
    }
  };

  const toggleDomainSelection = (id: string) => {
    setSelectedDomains((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAllFiltered = () => {
    setSelectedDomains(new Set(filteredDomains.map((d) => d.id)));
  };

  const clearSelection = () => {
    setSelectedDomains(new Set());
  };

  const startBackgroundTestsForDomain = async (domain: Domain): Promise<{ success: boolean; errors: string[] }> => {
    const urlsToTest = [domain.uptime_url, ...(domain.inner_pages || [])];
    const strategies: Array<"mobile" | "desktop"> = ["mobile", "desktop"];

    const errors: string[] = [];

    // Start all background tests (fire and forget with await for queue awareness) for both strategies
    const results = await Promise.allSettled(
      urlsToTest.flatMap((url) =>
        strategies.map(async (strategy) => {
          try {
            const res = await fetch("/api/pagespeed/background", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                domainId: domain.id,
                url,
                strategy,
              }),
            });
            if (!res.ok) {
              errors.push(`Queue failed for ${url} (${strategy}): ${res.status}`);
            }
          } catch (err: any) {
            console.error(`Error starting background test for ${url} (${strategy}):`, err);
            errors.push(`Queue failed for ${url} (${strategy}): ${err?.message || "unknown error"}`);
          }
        })
      )
    );

    const success = errors.length === 0 && results.every((r) => r.status === "fulfilled");
    return { success, errors };
  };

  const validateRequiredMetrics = async (domainId: string) => {
    const requiredFields: Array<keyof Domain> = [];
    try {
      const { data, error } = await supabase
        .from("pagespeed_results")
        .select(
          "strategy, performance_score, accessibility_score, best_practices_score, seo_score, first_contentful_paint, speed_index, time_to_interactive"
        )
        .eq("domain_id", domainId)
        .order("tested_at", { ascending: false })
        .limit(20);

      if (error) {
        console.error("Error validating metrics:", error);
        return { hasBadData: false, message: "" };
      }

      const latestByStrategy: Record<string, any> = {};
      (data || []).forEach((row) => {
        if (!latestByStrategy[row.strategy]) {
          latestByStrategy[row.strategy] = row;
        }
      });

      const strategiesToCheck: Array<"mobile" | "desktop"> = ["mobile", "desktop"];
      for (const strat of strategiesToCheck) {
        const row = latestByStrategy[strat];
        if (row && row.performance_score !== null && row.performance_score >= 0) {
          const missing =
            row.accessibility_score === null ||
            row.best_practices_score === null ||
            row.seo_score === null ||
            row.first_contentful_paint === null ||
            row.speed_index === null ||
            row.time_to_interactive === null;
          if (missing) {
            return {
              hasBadData: true,
              message: `Missing required metrics for ${strat}`,
            };
          }
        }
      }

      return { hasBadData: false, message: "" };
    } catch (err: any) {
      console.error("Validation exception:", err);
      return { hasBadData: false, message: "" };
    }
  };

  const waitForDomainResults = async (domain: Domain, maxWaitTime = 300000): Promise<{ success: boolean; message?: string }> => {
    const urlsToTest = [domain.uptime_url, ...(domain.inner_pages || [])];
    const strategies: Array<"mobile" | "desktop"> = ["mobile", "desktop"];
    const totalExpectedResults = urlsToTest.length * strategies.length;

    const startTime = Date.now();
    const pollInterval = 3000; // Check every 3 seconds

    while (Date.now() - startTime < maxWaitTime) {
      try {
        // Check all URLs and strategies for this domain
        const { data: results, error } = await supabase
          .from("pagespeed_results")
          .select("url, strategy, performance_score")
          .eq("domain_id", domain.id)
          .in("strategy", strategies);

        if (error) {
          console.error("Error checking results:", error);
          await new Promise(resolve => setTimeout(resolve, pollInterval));
          continue;
        }

        // Count how many have valid results (performance_score >= 0)
        const validResults = (results || []).filter(
          r => r.performance_score !== null && r.performance_score !== undefined && r.performance_score >= 0
        );

        // Check for errors (performance_score === -1)
        const errorResults = (results || []).filter(
          r => r.performance_score !== null && r.performance_score === -1
        );

        // If we have all valid results, we're done
        if (validResults.length === totalExpectedResults) {
          return { success: true };
        }

        // If we have all results (valid + errors), we're done (but with some errors)
        if (validResults.length + errorResults.length === totalExpectedResults) {
          if (errorResults.length > 0) {
            return {
              success: true,
              message: `Completed with ${errorResults.length} error${errorResults.length > 1 ? 's' : ''}`
            };
          }
          return { success: true };
        }

        // Still waiting for results
        await new Promise(resolve => setTimeout(resolve, pollInterval));
      } catch (err: any) {
        console.error("Error polling for results:", err);
        await new Promise(resolve => setTimeout(resolve, pollInterval));
      }
    }

    // Timeout
    return { success: false, message: "Timeout waiting for results" };
  };

  const analyzeSelectedDomains = async () => {
    if (selectedDomains.size === 0 || analyzingBatch) return;
    setAnalyzingBatch(true);
    setAnalysisLog([]);
    const targets = domains.filter((d) => selectedDomains.has(d.id));

    // First, remove any existing PageSpeed data for the selected domains
    try {
      const targetIds = targets.map((d) => d.id);
      if (targetIds.length > 0) {
        const { error: deleteError } = await supabase
          .from("pagespeed_results")
          .delete()
          .in("domain_id", targetIds);

        if (deleteError) {
          console.error("Error deleting existing PageSpeed results:", deleteError);
          setError("Failed to clear previous PageSpeed data for selected domains.");
        }
      }
    } catch (deleteException: any) {
      console.error("Exception while deleting PageSpeed results:", deleteException);
      setError(deleteException?.message || "Failed to clear previous PageSpeed data.");
    }

    const concurrency = Math.min(5, targets.length || 1);
    let index = 0;

    const delay = (ms: number) => new Promise((res) => setTimeout(res, ms));

    const runNext = async (): Promise<void> => {
      const currentIndex = index++;
      if (currentIndex >= targets.length) return;
      const domain = targets[currentIndex];
      await delay(2000);
      setAnalysisLog((prev) => [
        ...prev,
        { domainId: domain.id, name: domain.display_name || domain.domain_name, status: "running" },
      ]);
      try {
        let attempt = 0;
        let queueSuccess = false;
        let lastErrors: string[] = [];

        // Step 1: Queue the tests
        while (attempt < 3 && !queueSuccess) {
          attempt += 1;
          try {
            const res = await startBackgroundTestsForDomain(domain);
            queueSuccess = res.success;
            lastErrors = res.errors;
            if (!queueSuccess && attempt < 3) {
              await delay(2000);
            }
          } catch (err: any) {
            lastErrors = [err?.message || "Failed"];
            if (attempt < 3) {
              await delay(2000);
            }
          }
        }

        if (!queueSuccess) {
          setAnalysisLog((prev) =>
            prev.map((item) =>
              item.domainId === domain.id
                ? {
                  ...item,
                  status: "error",
                  finishedAt: Date.now(),
                  message: `Failed to queue tests after ${attempt} attempt${attempt > 1 ? "s" : ""}: ${lastErrors.join("; ")}`,
                }
                : item
            )
          );
          await runNext();
          return;
        }

        // Step 2: Wait for actual results
        const waitResult = await waitForDomainResults(domain);

        setAnalysisLog((prev) =>
          prev.map((item) =>
            item.domainId === domain.id
              ? {
                ...item,
                status: waitResult.success ? "done" : "error",
                finishedAt: Date.now(),
                message: waitResult.message,
              }
              : item
          )
        );
      } catch (err: any) {
        setAnalysisLog((prev) =>
          prev.map((item) =>
            item.domainId === domain.id ? { ...item, status: "error", message: err?.message || "Failed" } : item
          )
        );
      }
      await runNext();
    };

    await Promise.all(Array.from({ length: concurrency }).map(() => runNext()));
    setAnalyzingBatch(false);
    fetchLatestResults(domains);
  };

  const handleAddDomain = async () => {
    setAddDomainError("");
    const { domain_name, display_name, uptime_url, category, tag } = addDomainData;

    if (!domain_name.trim() || !uptime_url.trim()) {
      setAddDomainError("Domain name and uptime URL are required.");
      return;
    }

    let normalizedUptime = uptime_url.trim();
    if (!normalizedUptime.startsWith("http://") && !normalizedUptime.startsWith("https://")) {
      normalizedUptime = `https://${normalizedUptime}`;
    }

    setAddingDomain(true);

    // Check for duplicates in local state first to avoid unnecessary API calls
    const duplicate = domains.find(
      (d) =>
        d.domain_name.toLowerCase() === domain_name.trim().toLowerCase() ||
        d.uptime_url === normalizedUptime
    );

    if (duplicate) {
      setAddDomainError("Domain with this name or URL already exists.");
      setAddingDomain(false);
      return;
    }

    try {
      const { error: insertError } = await supabase.from("domains").insert({
        domain_name: domain_name.trim(),
        display_name: display_name.trim() || null,
        uptime_url: normalizedUptime,
        category: category.trim() || null,
        tag: tag.trim() || null,
      });

      if (insertError) throw insertError;

      // Refresh list
      await fetchDomains();

      // Reset form
      setAddDomainData({
        domain_name: "",
        display_name: "",
        uptime_url: "",
        category: "",
        tag: "",
      });
      setUseCustomCategory(false);
    } catch (err: any) {
      console.error("Error adding domain:", err);
      setAddDomainError(err.message || "Failed to add domain");
    } finally {
      setAddingDomain(false);
    }
  };

  useEffect(() => {
    if (authChecked) {
      fetchDomains();
    }
  }, [authChecked]);

  // Get all unique categories from domains
  const categories = ["all", ...Array.from(new Set(domains
    .filter(domain => domain.category)
    .map(domain => domain.category as string)
  ))];

  // Filter and sort domains
  const filteredDomains = domains
    .filter(domain => {
      const matchesSearch =
        domain.domain_name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        searchQuery.toLowerCase().includes(domain.domain_name.toLowerCase()) ||
        (domain.display_name && domain.display_name.toLowerCase().includes(searchQuery.toLowerCase())) ||
        (domain.uptime_url && domain.uptime_url.toLowerCase().includes(searchQuery.toLowerCase()));

      const matchesCategory =
        categoryFilter === 'all' ||
        domain.category === categoryFilter;

      // Performance score filter
      const latest = latestResults[domain.id];
      const performanceScore = latest?.performance_score;
      const matchesPerformance = (() => {
        if (performanceFilter === 'all') return true;
        // Only filter by score if we have valid data
        if (performanceScore === null || performanceScore === undefined || performanceScore < 0) return false;
        if (performanceFilter === 'low') return performanceScore < 50;
        if (performanceFilter === 'medium') return performanceScore >= 50 && performanceScore < 90;
        if (performanceFilter === 'high') return performanceScore >= 90;
        return true;
      })();

      // Analysis data filter
      const matchesAnalysisData = (() => {
        if (analysisDataFilter === 'all') return true;
        if (analysisDataFilter === 'with_data') {
          return latest && latest.performance_score !== null && latest.performance_score !== undefined && latest.performance_score >= 0;
        }
        if (analysisDataFilter === 'without_data') {
          return !latest || latest.performance_score === null || latest.performance_score === undefined || latest.performance_score < 0;
        }
        return true;
      })();

      return matchesSearch && matchesCategory && matchesPerformance && matchesAnalysisData;
    })
    .sort((a, b) => {
      switch (sortBy) {
        case "newest":
          return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
        case "oldest":
          return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
        case "category":
          return (a.category || "").localeCompare(b.category || "");
        case "domain":
        default:
          return (a.display_name || a.domain_name).localeCompare(b.display_name || b.domain_name);
      }
    });

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  };

  const formatMs = (value: number | null | undefined) => {
    if (value === null || value === undefined) return "N/A";
    const ms = Number(value);
    if (Number.isNaN(ms)) return "N/A";
    if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
    return `${Math.round(ms)}ms`;
  };

  const formatScore = (value: number | null | undefined) => {
    if (value === null || value === undefined) return "N/A";
    if (value < 0) return "Error";
    return `${value}`;
  };

  // Helpers to interpret latest PageSpeed result status
  const isResultRunning = (row: any) => !!row && row.performance_score === null;
  const isResultError = (row: any) => !!row && row.performance_score !== null && row.performance_score < 0;

  const scoreColorClass = (score: number | null | undefined) => {
    if (score === null || score === undefined) return "text-muted-foreground";
    if (score >= 90) return "text-green-600 dark:text-green-400";
    if (score >= 50) return "text-amber-600 dark:text-amber-400";
    return "text-red-600 dark:text-red-400";
  };

  // Compact mobile/desktop "last analyzed" pair shown on each domain card/row
  const LastAnalysisPair = ({ domainId, compact = false }: { domainId: string; compact?: boolean }) => {
    const m = mobileResults[domainId];
    const d = desktopResults[domainId];
    const cell = (icon: React.ReactNode, label: string, row: any) => (
      <div className={compact ? "flex items-center gap-1.5" : "flex-1 border rounded-md p-2 bg-muted/30"}>
        <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
          {icon}
          {!compact && <span>{label}</span>}
        </div>
        <div className={compact ? "text-[11px]" : "text-xs font-medium mt-0.5"}>
          {row?.tested_at ? (
            <span title={new Date(row.tested_at).toLocaleString()}>
              {new Date(row.tested_at).toLocaleDateString()}
            </span>
          ) : (
            <span className="text-muted-foreground">Not tested</span>
          )}
        </div>
      </div>
    );

    if (compact) {
      return (
        <div className="flex flex-col gap-0.5">
          {cell(<Smartphone className="h-3 w-3" />, "Mobile", m)}
          {cell(<Monitor className="h-3 w-3" />, "Desktop", d)}
        </div>
      );
    }

    return (
      <div className="flex gap-2">
        {cell(<Smartphone className="h-3 w-3" />, "Mobile", m)}
        {cell(<Monitor className="h-3 w-3" />, "Desktop", d)}
      </div>
    );
  };

  const timeAgo = (date: Date | null) => {
    if (!date) return "Never";
    const diff = Date.now() - date.getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins} min ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs} hour${hrs > 1 ? "s" : ""} ago`;
    const days = Math.floor(hrs / 24);
    return `${days} day${days > 1 ? "s" : ""} ago`;
  };

  // Per-strategy stats: average score, coverage, distribution, last analysis date
  const strategyStats = (resultMap: Record<string, any>) => {
    const rows = Object.values(resultMap) as any[];
    const analyzed = rows.filter((r) => r && r.performance_score !== null && r.performance_score >= 0);
    const scores = analyzed.map((r) => r.performance_score as number);
    const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;

    let last: Date | null = null;
    for (const r of rows) {
      if (r?.tested_at) {
        const d = new Date(r.tested_at);
        if (!last || d > last) last = d;
      }
    }

    return {
      analyzed: analyzed.length,
      avg,
      good: scores.filter((s) => s >= 90).length,
      needsWork: scores.filter((s) => s >= 50 && s < 90).length,
      poor: scores.filter((s) => s < 50).length,
      errored: rows.filter((r) => r && r.performance_score !== null && r.performance_score < 0).length,
      last,
    };
  };

  // Average a Lighthouse score field across all valid rows from both strategies
  const avgField = (field: string) => {
    const rows = [...Object.values(mobileResults), ...Object.values(desktopResults)] as any[];
    const vals = rows
      .filter((r) => r && r.performance_score >= 0 && r[field] !== null && r[field] !== undefined && r[field] >= 0)
      .map((r) => r[field] as number);
    return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
  };

  // Aggregate summary across both strategies
  const summary = (() => {
    const mobile = strategyStats(mobileResults);
    const desktop = strategyStats(desktopResults);

    // Last analysis = most recent run across mobile AND desktop
    const dates = [mobile.last, desktop.last].filter(Boolean) as Date[];
    const lastAnalysis = dates.length ? new Date(Math.max(...dates.map((d) => d.getTime()))) : null;

    // A domain counts as analyzed if it has a valid score in either strategy
    const analyzedIds = new Set<string>();
    for (const [id, r] of Object.entries(mobileResults)) {
      if (r && (r as any).performance_score >= 0) analyzedIds.add(id);
    }
    for (const [id, r] of Object.entries(desktopResults)) {
      if (r && (r as any).performance_score >= 0) analyzedIds.add(id);
    }

    return {
      total: domains.length,
      analyzed: analyzedIds.size,
      pending: domains.length - analyzedIds.size,
      mobile,
      desktop,
      lastAnalysis,
      avgAccessibility: avgField("accessibility_score"),
      avgBestPractices: avgField("best_practices_score"),
      avgSeo: avgField("seo_score"),
    };
  })();

  const parseUrls = (urlString: string): string[] => {
    // Split by newlines, commas, or spaces, then filter and trim
    return urlString
      .split(/[\n,]+/)
      .map((url) => url.trim())
      .filter((url) => url.length > 0);
  };

  const validateUrls = (urls: string[]): { valid: string[]; invalid: string[] } => {
    const valid: string[] = [];
    const invalid: string[] = [];

    urls.forEach((url) => {
      try {
        new URL(url);
        valid.push(url);
      } catch {
        invalid.push(url);
      }
    });

    return { valid, invalid };
  };

  const addSingleUrl = async (domainId: string, url: string) => {
    // Validate URL format
    try {
      new URL(url);
    } catch {
      setError(`Invalid URL: ${url}`);
      return;
    }

    // Get current domain
    const domain = domains.find((d) => d.id === domainId);
    if (!domain) return;

    // Check for duplicates
    const existingUrls = domain.inner_pages || [];
    if (existingUrls.includes(url)) {
      setError("This URL has already been added");
      return;
    }

    setAddingUrls((prev) => new Set(prev).add(url));
    setError("");

    try {
      // Update the domain with the new URL
      const updatedUrls = [...existingUrls, url];
      const { error: updateError } = await supabase
        .from("domains")
        .update({ inner_pages: updatedUrls })
        .eq("id", domainId);

      if (updateError) throw updateError;

      // Update local state
      setDomains((prev) =>
        prev.map((d) =>
          d.id === domainId ? { ...d, inner_pages: updatedUrls } : d
        )
      );

      // Clear input if this was the URL being added
      if (newUrl.trim() === url) {
        setNewUrl("");
      }
    } catch (err: any) {
      console.error("Error saving URL:", err);
      setError(err.message || "Failed to save URL");
    } finally {
      setAddingUrls((prev) => {
        const newSet = new Set(prev);
        newSet.delete(url);
        return newSet;
      });
    }
  };

  const removeUrl = async (domainId: string, urlIndex: number) => {
    const domain = domains.find((d) => d.id === domainId);
    if (!domain) return;

    const currentUrls = domain.inner_pages || [];
    const updatedUrls = currentUrls.filter((_, index) => index !== urlIndex);

    try {
      const { error: updateError } = await supabase
        .from("domains")
        .update({ inner_pages: updatedUrls })
        .eq("id", domainId);

      if (updateError) throw updateError;

      // Update local state
      setDomains((prev) =>
        prev.map((d) =>
          d.id === domainId ? { ...d, inner_pages: updatedUrls } : d
        )
      );
    } catch (err: any) {
      console.error("Error removing URL:", err);
      setError(err.message || "Failed to remove URL");
    }
  };

  const testUrlSpeed = async (url: string) => {
    setTestingUrls((prev) => new Set(prev).add(url));
    setSpeedTestResults((prev) => ({
      ...prev,
      [url]: {
        url,
        responseTime: null,
        status: 'testing',
        timestamp: Date.now(),
      },
    }));

    try {
      const startTime = performance.now();

      // Create an abort controller for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout

      try {
        const response = await fetch(url, {
          method: 'GET',
          cache: 'no-store',
          signal: controller.signal,
          redirect: 'follow',
        });

        const endTime = performance.now();
        const responseTime = Math.round(endTime - startTime);
        clearTimeout(timeoutId);

        const status: 'success' | 'error' = response.ok ? 'success' : 'error';
        const error = response.ok ? undefined : `Status: ${response.status}`;

        setSpeedTestResults((prev) => ({
          ...prev,
          [url]: {
            url,
            responseTime,
            status,
            error,
            timestamp: Date.now(),
          },
        }));
      } catch (fetchError: any) {
        clearTimeout(timeoutId);
        const endTime = performance.now();
        const responseTime = Math.round(endTime - startTime);

        // If it's a timeout or network error, we still got a response time
        if (fetchError.name === 'AbortError') {
          setSpeedTestResults((prev) => ({
            ...prev,
            [url]: {
              url,
              responseTime,
              status: 'error',
              error: 'Timeout (10s)',
              timestamp: Date.now(),
            },
          }));
        } else {
          setSpeedTestResults((prev) => ({
            ...prev,
            [url]: {
              url,
              responseTime: responseTime < 10000 ? responseTime : null,
              status: 'error',
              error: fetchError.message || 'Failed to fetch',
              timestamp: Date.now(),
            },
          }));
        }
      }
    } catch (err: any) {
      setSpeedTestResults((prev) => ({
        ...prev,
        [url]: {
          url,
          responseTime: null,
          status: 'error',
          error: err.message || 'Failed to test URL',
          timestamp: Date.now(),
        },
      }));
    } finally {
      setTestingUrls((prev) => {
        const newSet = new Set(prev);
        newSet.delete(url);
        return newSet;
      });
    }
  };

  const testAllUrlsForDomain = async (domain: Domain) => {
    const urlsToTest = [domain.uptime_url, ...(domain.inner_pages || [])];

    // Test all URLs in parallel
    await Promise.allSettled(
      urlsToTest.map(url => testUrlSpeed(url))
    );
  };

  const openAddUrlModal = (domainId: string) => {
    setOpenModal(domainId);
    setNewUrl("");
    setError("");
  };

  const closeModal = () => {
    setOpenModal(null);
    setNewUrl("");
    setError("");
    setAddingUrls(new Set());
  };

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="mb-8">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-2">
          <div className="flex items-center gap-3">
            <Gauge className="h-8 w-8 text-brand" />
            <h1 className="text-4xl font-bold">Speed Test</h1>
          </div>
          <Button
            className="w-full sm:w-auto"
            onClick={() => {
              setShowAddDomain((prev) => !prev);
              const el = document.getElementById("add-domain-form");
              if (el && !showAddDomain) {
                setTimeout(() => {
                  el.scrollIntoView({ behavior: "smooth", block: "start" });
                }, 50);
              }
            }}
            aria-expanded={showAddDomain}
          >
            <Plus className="h-4 w-4 mr-2" />
            {showAddDomain ? "Hide Add Domain" : "Add New Domain"}
          </Button>
        </div>
        <p className="text-muted-foreground text-lg">
          Test the speed and performance of all monitored domains
        </p>
      </div>

      {/* Performance summary */}
      {domains.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          <Card>
            <CardContent className="p-5">
              <div className="flex items-center gap-2 text-muted-foreground mb-1">
                <Globe className="h-4 w-4" />
                <span className="text-sm font-medium">Domains</span>
              </div>
              <div className="text-3xl font-bold">{summary.total}</div>
              <div className="text-xs text-muted-foreground mt-1">
                {summary.analyzed} analyzed · {summary.pending} pending
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-5">
              <div className="flex items-center gap-2 text-muted-foreground mb-2">
                <Gauge className="h-4 w-4" />
                <span className="text-sm font-medium">Avg Performance</span>
              </div>
              <div className="flex items-center gap-6">
                <div>
                  <div className={`text-3xl font-bold ${scoreColorClass(summary.mobile.avg)}`}>
                    {summary.mobile.avg ?? "N/A"}
                  </div>
                  <div className="text-[10px] text-muted-foreground uppercase mt-0.5">
                    Mobile · {summary.mobile.analyzed}
                  </div>
                </div>
                <div className="border-l border-border pl-6">
                  <div className={`text-3xl font-bold ${scoreColorClass(summary.desktop.avg)}`}>
                    {summary.desktop.avg ?? "N/A"}
                  </div>
                  <div className="text-[10px] text-muted-foreground uppercase mt-0.5">
                    Desktop · {summary.desktop.analyzed}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-5">
              <div className="flex items-center gap-2 text-muted-foreground mb-2">
                <CheckCircle className="h-4 w-4" />
                <span className="text-sm font-medium">Health Breakdown</span>
              </div>
              {([
                { label: "Mobile", s: summary.mobile },
                { label: "Desktop", s: summary.desktop },
              ] as const).map(({ label, s }) => (
                <div key={label} className="flex items-center justify-between gap-2 mb-1.5 last:mb-0">
                  <span className="text-xs font-medium text-muted-foreground w-14">{label}</span>
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-bold text-green-600 dark:text-green-400" title="Good (90+)">{s.good}</span>
                    <span className="text-sm font-bold text-amber-600 dark:text-amber-400" title="Needs work (50-89)">{s.needsWork}</span>
                    <span className="text-sm font-bold text-red-600 dark:text-red-400" title="Poor (<50)">{s.poor}</span>
                    {s.errored > 0 && (
                      <span className="text-sm font-bold text-muted-foreground" title="Errors">{s.errored}</span>
                    )}
                  </div>
                </div>
              ))}
              <div className="flex items-center justify-end gap-3 mt-1 text-[10px] text-muted-foreground uppercase">
                <span className="text-green-600 dark:text-green-400">Good</span>
                <span className="text-amber-600 dark:text-amber-400">Needs</span>
                <span className="text-red-600 dark:text-red-400">Poor</span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-5">
              <div className="flex items-center gap-2 text-muted-foreground mb-2">
                <CheckCircle className="h-4 w-4" />
                <span className="text-sm font-medium">Avg Scores</span>
              </div>
              <div className="space-y-1.5">
                {([
                  { label: "Accessibility", value: summary.avgAccessibility },
                  { label: "Best Practices", value: summary.avgBestPractices },
                  { label: "SEO", value: summary.avgSeo },
                ] as const).map(({ label, value }) => (
                  <div key={label} className="flex items-center justify-between">
                    <span className="text-xs text-muted-foreground">{label}</span>
                    <span className={`text-sm font-bold ${scoreColorClass(value)}`}>{value ?? "N/A"}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {showAddDomain && (
        <div id="add-domain-form" className="mb-8">
          <Card>
            <CardHeader>
              <CardTitle>Add New Domain</CardTitle>
              <CardDescription>Quickly add a domain to start testing.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="text-sm font-medium">Domain Name *</label>
                  <Input
                    value={addDomainData.domain_name}
                    onChange={(e) => setAddDomainData((prev) => ({ ...prev, domain_name: e.target.value }))}
                    placeholder="example.com"
                  />
                </div>
                <div>
                  <label className="text-sm font-medium">Display Name</label>
                  <Input
                    value={addDomainData.display_name}
                    onChange={(e) => setAddDomainData((prev) => ({ ...prev, display_name: e.target.value }))}
                    placeholder="Friendly name"
                  />
                </div>
                <div>
                  <label className="text-sm font-medium">Uptime URL *</label>
                  <Input
                    value={addDomainData.uptime_url}
                    onChange={(e) => setAddDomainData((prev) => ({ ...prev, uptime_url: e.target.value }))}
                    placeholder="https://example.com"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-sm font-medium">Category</label>
                  {categories.filter((c) => c !== "all").length > 0 ? (
                    <>
                      <Select
                        value={useCustomCategory ? "__custom" : addDomainData.category || ""}
                        onValueChange={(val) => {
                          if (val === "__custom") {
                            setUseCustomCategory(true);
                            setAddDomainData((prev) => ({ ...prev, category: "" }));
                          } else {
                            setUseCustomCategory(false);
                            setAddDomainData((prev) => ({ ...prev, category: val }));
                          }
                        }}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Select category" />
                        </SelectTrigger>
                        <SelectContent>
                          {categories
                            .filter((c) => c !== "all")
                            .map((category) => (
                              <SelectItem key={category} value={category}>
                                {category}
                              </SelectItem>
                            ))}
                          <SelectItem value="__custom">Custom...</SelectItem>
                        </SelectContent>
                      </Select>
                      {useCustomCategory && (
                        <Input
                          value={addDomainData.category}
                          onChange={(e) =>
                            setAddDomainData((prev) => ({ ...prev, category: e.target.value }))
                          }
                          placeholder="Enter custom category"
                        />
                      )}
                    </>
                  ) : (
                    <Input
                      value={addDomainData.category}
                      onChange={(e) => setAddDomainData((prev) => ({ ...prev, category: e.target.value }))}
                      placeholder="Category"
                    />
                  )}
                </div>
                <div>
                  <label className="text-sm font-medium">Tag</label>
                  <Input
                    value={addDomainData.tag}
                    onChange={(e) => setAddDomainData((prev) => ({ ...prev, tag: e.target.value }))}
                    placeholder="Tag"
                  />
                </div>
              </div>

              {addDomainError && (
                <div className="text-sm text-red-600 dark:text-red-400">{addDomainError}</div>
              )}

              <div className="flex gap-2 flex-wrap">
                <Button onClick={handleAddDomain} disabled={addingDomain}>
                  {addingDomain ? (
                    <>
                      <div className="h-4 w-4 border-2 border-current border-t-transparent rounded-full animate-spin mr-2" />
                      Adding...
                    </>
                  ) : (
                    <>
                      <Plus className="h-4 w-4 mr-2" />
                      Add Domain
                    </>
                  )}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    setAddDomainData({
                      domain_name: "",
                      display_name: "",
                      uptime_url: "",
                      category: "",
                      tag: "",
                    });
                    setAddDomainError("");
                  }}
                >
                  Clear
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Filters and Search */}
      <div className="mb-6 space-y-4">
        <div className="flex flex-col lg:flex-row gap-4">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground h-4 w-4" />
            <Input
              type="text"
              placeholder="Search domains..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10"
            />
          </div>
          <Select value={categoryFilter} onValueChange={setCategoryFilter}>
            <SelectTrigger className="w-full lg:w-[200px]">
              <SelectValue placeholder="All Categories" />
            </SelectTrigger>
            <SelectContent>
              {categories.map((category) => (
                <SelectItem key={category} value={category}>
                  {category === "all" ? "All Categories" : category}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={performanceFilter} onValueChange={setPerformanceFilter}>
            <SelectTrigger className="w-full lg:w-[200px]">
              <SelectValue placeholder="Performance Score" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Performance</SelectItem>
              <SelectItem value="high">High</SelectItem>
              <SelectItem value="medium">Medium</SelectItem>
              <SelectItem value="low">Low</SelectItem>
            </SelectContent>
          </Select>
          <Select value={analysisDataFilter} onValueChange={setAnalysisDataFilter}>
            <SelectTrigger className="w-full lg:w-[200px]">
              <SelectValue placeholder="Analysis Data" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Domains</SelectItem>
              <SelectItem value="with_data">With Analysis Data</SelectItem>
              <SelectItem value="without_data">Without Analysis Data</SelectItem>
            </SelectContent>
          </Select>
          <Select value={sortBy} onValueChange={(value) => setSortBy(value as any)}>
            <SelectTrigger className="w-full lg:w-[200px]">
              <SelectValue placeholder="Sort by" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="domain">Sort by Domain</SelectItem>
              <SelectItem value="newest">Newest First</SelectItem>
              <SelectItem value="oldest">Oldest First</SelectItem>
              <SelectItem value="category">Sort by Category</SelectItem>
            </SelectContent>
          </Select>
          <div className="flex gap-2">
            <Button
              variant={viewMode === "cards" ? "default" : "outline"}
              size="icon"
              onClick={() => setViewMode("cards")}
              title="Card view"
            >
              <LayoutGrid className="h-4 w-4" />
            </Button>
            <Button
              variant={viewMode === "table" ? "default" : "outline"}
              size="icon"
              onClick={() => setViewMode("table")}
              title="Table view"
            >
              <TableIcon className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <div className="text-sm text-muted-foreground">
          Showing {filteredDomains.length} of {domains.length} domains
        </div>
        <div className="flex flex-col sm:flex-row flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={selectAllFiltered}
            disabled={filteredDomains.length === 0}
            className="w-full sm:w-auto"
          >
            Select All ({filteredDomains.length})
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={clearSelection}
            disabled={selectedDomains.size === 0}
            className="w-full sm:w-auto"
          >
            Clear Selection
          </Button>
          <Button
            variant="default"
            size="sm"
            onClick={analyzeSelectedDomains}
            disabled={selectedDomains.size === 0 || analyzingBatch}
            className="w-full sm:w-auto"
          >
            {analyzingBatch ? (
              <>
                <div className="h-4 w-4 border-2 border-current border-t-transparent rounded-full animate-spin mr-2" />
                Analyzing...
              </>
            ) : (
              <>
                Analyze Selected ({selectedDomains.size})
              </>
            )}
          </Button>
        </div>
      </div>

      {analysisLog.length > 0 && analyzingBatch && (
        <Card className="mb-4">
          <CardContent className="pt-4 h-[600px] flex flex-col">
            <div className="flex items-center justify-between mb-2 flex-shrink-0">
              <span className="text-sm font-semibold">Batch Analysis Status</span>
              {analyzingBatch && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <div className="h-4 w-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                  Running...
                </div>
              )}
            </div>
            <div className="space-y-2 overflow-y-auto flex-1">
              {[...analysisLog]
                .sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0))
                .map((item) => (
                  <div
                    key={item.domainId}
                    className="flex items-center justify-between text-xs border rounded-md px-3 py-2 bg-muted/40"
                  >
                    <div className="flex items-center gap-2">
                      <Checkbox checked disabled className="pointer-events-none" />
                      <span className="font-medium">{item.name}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      {item.status === "running" && <span className="text-amber-600">Running</span>}
                      {item.status === "done" && <span className="text-green-600">Done</span>}
                      {item.status === "error" && (
                        <span className="text-red-600" title={item.message}>
                          Error
                        </span>
                      )}
                      {item.status === "queued" && <span className="text-muted-foreground">Queued</span>}
                    </div>
                  </div>
                ))}
            </div>
          </CardContent>
        </Card>
      )}

      {error && (
        <Card className="mb-6 border-red-300 bg-red-50 dark:bg-red-900/10">
          <CardContent className="pt-6">
            <div className="flex items-center gap-3 text-red-700 dark:text-red-400">
              <AlertCircle className="h-5 w-5" />
              <p>{error}</p>
            </div>
          </CardContent>
        </Card>
      )}

      {loading ? (
        viewMode === "cards" ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {[...Array(6)].map((_, i) => (
              <Card key={i} className="animate-pulse">
                <CardHeader>
                  <div className="flex justify-between items-start gap-4">
                    <Skeleton className="h-5 w-5 rounded" />
                    <div className="flex-1 space-y-2">
                      <Skeleton className="h-5 w-32" />
                      <Skeleton className="h-4 w-48" />
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-2 gap-2">
                    {[...Array(6)].map((_, j) => (
                      <Skeleton key={j} className="h-4 w-full" />
                    ))}
                  </div>
                  <Skeleton className="h-10 w-full rounded-md" />
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <div className="border rounded-lg overflow-hidden">
            <div className="bg-muted p-4 border-b flex gap-4">
              {[...Array(8)].map((_, i) => (
                <Skeleton key={i} className="h-4 flex-1" />
              ))}
            </div>
            {[...Array(8)].map((_, i) => (
              <div key={i} className="p-4 border-b flex gap-4">
                {[...Array(8)].map((_, j) => (
                  <Skeleton key={j} className="h-4 flex-1" />
                ))}
              </div>
            ))}
          </div>
        )
      ) : filteredDomains.length === 0 ? (
        <Card>
          <CardContent className="pt-6">
            <div className="text-center py-16">
              <Globe className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <h3 className="text-xl font-medium mb-2">No domains found</h3>
              <p className="text-muted-foreground">
                {domains.length === 0
                  ? "There are no domains in the database."
                  : "No domains match your search criteria."}
              </p>
            </div>
          </CardContent>
        </Card>
      ) : viewMode === "table" ? (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm border">
            <thead className="bg-muted/50">
              <tr>
                <th className="text-left px-4 py-2 border-b w-10">
                  <Checkbox
                    checked={
                      filteredDomains.length === 0
                        ? false
                        : selectedDomains.size === filteredDomains.length
                          ? true
                          : "indeterminate"
                    }
                    onCheckedChange={(checked) => {
                      if (checked) selectAllFiltered();
                      else clearSelection();
                    }}
                    aria-label="Select all domains"
                  />
                </th>
                <th className="text-left px-4 py-2 border-b">Domain</th>
                <th className="text-left px-4 py-2 border-b">Category</th>
                <th className="text-left px-4 py-2 border-b">Tag</th>
                <th className="text-left px-4 py-2 border-b">Performance</th>
                <th className="text-left px-4 py-2 border-b">Accessibility</th>
                <th className="text-left px-4 py-2 border-b">Best Practices</th>
                <th className="text-left px-4 py-2 border-b">SEO</th>
                <th className="text-left px-4 py-2 border-b">FCP</th>
                <th className="text-left px-4 py-2 border-b">Speed Index</th>
                <th className="text-left px-4 py-2 border-b">TTI</th>
                <th className="text-left px-4 py-2 border-b">Last Analysis</th>
                <th className="text-left px-4 py-2 border-b">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredDomains.map((domain) => {
                const latest = latestResults[domain.id];
                return (
                  <tr
                    key={domain.id}
                    className="hover:bg-muted/50 cursor-pointer"
                    onClick={() => {
                      startBackgroundTestsForDomain(domain);
                      router.push(`/speed-test/${domain.id}`);
                    }}
                  >
                    <td className="px-4 py-2 border-b" onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={selectedDomains.has(domain.id)}
                        onCheckedChange={(checked) => {
                          if (checked) {
                            setSelectedDomains((prev) => new Set(prev).add(domain.id));
                          } else {
                            setSelectedDomains((prev) => {
                              const next = new Set(prev);
                              next.delete(domain.id);
                              return next;
                            });
                          }
                        }}
                        aria-label={`Select ${domain.display_name || domain.domain_name}`}
                      />
                    </td>
                    <td className="px-4 py-2 border-b">
                      <div className="font-medium">{domain.display_name || domain.domain_name}</div>
                      <div className="text-xs text-muted-foreground">{domain.domain_name}</div>
                    </td>
                    <td className="px-4 py-2 border-b text-xs">{domain.category || "-"}</td>
                    <td className="px-4 py-2 border-b text-xs">{domain.tag || "-"}</td>
                    <td className="px-4 py-2 border-b">
                      {isResultRunning(latest) ? (
                        <div className="flex items-center gap-1 text-xs text-muted-foreground">
                          <div className="h-3 w-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
                          <span>Running…</span>
                        </div>
                      ) : isResultError(latest) ? (
                        <span className="text-xs text-red-600 dark:text-red-400">Error</span>
                      ) : (
                        formatScore(latest?.performance_score)
                      )}
                    </td>
                    <td className="px-4 py-2 border-b">
                      {isResultRunning(latest) || isResultError(latest)
                        ? "—"
                        : formatScore(latest?.accessibility_score)}
                    </td>
                    <td className="px-4 py-2 border-b">
                      {isResultRunning(latest) || isResultError(latest)
                        ? "—"
                        : formatScore(latest?.best_practices_score)}
                    </td>
                    <td className="px-4 py-2 border-b">
                      {isResultRunning(latest) || isResultError(latest)
                        ? "—"
                        : formatScore(latest?.seo_score)}
                    </td>
                    <td className="px-4 py-2 border-b">
                      {isResultRunning(latest) || isResultError(latest)
                        ? "—"
                        : formatMs(latest?.first_contentful_paint)}
                    </td>
                    <td className="px-4 py-2 border-b">
                      {isResultRunning(latest) || isResultError(latest)
                        ? "—"
                        : formatMs(latest?.speed_index)}
                    </td>
                    <td className="px-4 py-2 border-b">
                      {isResultRunning(latest) || isResultError(latest)
                        ? "—"
                        : formatMs(latest?.time_to_interactive)}
                    </td>
                    <td className="px-4 py-2 border-b" onClick={(e) => e.stopPropagation()}>
                      <LastAnalysisPair domainId={domain.id} compact />
                    </td>
                    <td className="px-4 py-2 border-b">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          router.push(`/speed-test/${domain.id}`);
                        }}
                      >
                        View
                      </Button>
                      {isResultError(latest) && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="ml-2 text-xs"
                          onClick={(e) => {
                            e.stopPropagation();
                            startBackgroundTestsForDomain(domain);
                          }}
                        >
                          <RefreshCw className="h-3 w-3 mr-1" />
                          Re-analyze
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {loadingResults && (
            <div className="text-xs text-muted-foreground mt-2">Loading recent analysis…</div>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredDomains.map((domain) => {
            const latest = latestResults[domain.id];
            return (
              <Card
                key={domain.id}
                className="hover:shadow-lg transition-shadow cursor-pointer"
                onClick={() => {
                  // Start background tests for this domain before navigating
                  startBackgroundTestsForDomain(domain);
                  router.push(`/speed-test/${domain.id}`);
                }}
              >
                <CardHeader>
                  <div className="flex flex-row items-start justify-between gap-3">
                    <div className="pt-1" onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={selectedDomains.has(domain.id)}
                        onCheckedChange={(checked) => {
                          if (checked) {
                            setSelectedDomains((prev) => new Set(prev).add(domain.id));
                          } else {
                            setSelectedDomains((prev) => {
                              const next = new Set(prev);
                              next.delete(domain.id);
                              return next;
                            });
                          }
                        }}
                        aria-label={`Select ${domain.display_name || domain.domain_name}`}
                      />
                    </div>
                    <div className="flex-1">
                      <CardTitle className="text-lg mb-1">
                        {domain.display_name || domain.domain_name}
                      </CardTitle>
                      <CardDescription className="flex items-center gap-1 mt-1">
                        <Globe className="h-3 w-3" />
                        <a
                          href={domain.uptime_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-sm text-brand hover:underline flex items-center gap-1"
                        > <span className="text-xs">{domain.domain_name}</span>

                        </a>

                      </CardDescription>
                    </div>
                    <div>
                      {domain.category && (
                        <div className="flex items-center gap-1">
                          <span className="text-xs text-muted-foreground">Category:</span>
                          <span className="text-xs font-medium text-blue-600 dark:text-blue-400 truncate max-w-[120px]" title={domain.category}>
                            {domain.category.length > 18 ? `${domain.category.slice(0, 18)}…` : domain.category}
                          </span>
                        </div>
                      )}
                      {domain.tag && (
                        <div className="flex items-center gap-1">
                          <span className="text-xs text-muted-foreground">Tag:</span>
                          <span className="text-xs font-medium text-purple-600 dark:text-purple-400 truncate max-w-[100px]" title={domain.tag}>
                            {domain.tag.length > 15 ? `${domain.tag.slice(0, 15)}…` : domain.tag}
                          </span>
                        </div>
                      )}

                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    <div>
                      <div className="text-[11px] font-semibold text-muted-foreground mb-1 uppercase tracking-wide">
                        Last Analysis
                      </div>
                      <LastAnalysisPair domainId={domain.id} />
                    </div>
                    {latest && (
                      <div className="border rounded-md p-3 bg-muted/40">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-xs font-semibold">Latest Analysis ({latest.strategy})</span>
                        </div>
                        <div className="grid grid-cols-2 gap-2 text-xs">
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">Performance</span>
                            <span className="font-semibold">{formatScore(latest.performance_score)}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">Accessibility</span>
                            <span className="font-semibold">{formatScore(latest.accessibility_score)}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">Best Practices</span>
                            <span className="font-semibold">{formatScore(latest.best_practices_score)}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">SEO</span>
                            <span className="font-semibold">{formatScore(latest.seo_score)}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">FCP</span>
                            <span className="font-semibold">{formatMs(latest.first_contentful_paint)}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">Speed Index</span>
                            <span className="font-semibold">{formatMs(latest.speed_index)}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">TTI</span>
                            <span className="font-semibold">{formatMs(latest.time_to_interactive)}</span>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Speed Test Results */}
                    <div className="pt-2 border-t space-y-2">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-medium text-muted-foreground">
                          Speed Test Results:
                        </span>
                      </div>

                      {/* Main URL Test Result */}
                      <div className="space-y-1">
                        <div
                          className={`flex items-center gap-2 p-2 rounded-md text-xs border ${speedTestResults[domain.uptime_url]?.status === 'success'
                            ? 'bg-green-50 dark:bg-green-900/10 border-green-200 dark:border-green-800'
                            : speedTestResults[domain.uptime_url]?.status === 'error'
                              ? 'bg-red-50 dark:bg-red-900/10 border-red-200 dark:border-red-800'
                              : 'bg-muted/50 border-border'
                            }`}
                        >
                          <Globe className="h-3 w-3 flex-shrink-0" />
                          <span className="flex-1 truncate font-mono text-xs">
                            {domain.uptime_url}
                          </span>
                          {speedTestResults[domain.uptime_url]?.status === 'testing' ? (
                            <div className="flex items-center gap-1 text-muted-foreground">
                              <div className="h-3 w-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
                              <span>Testing...</span>
                            </div>
                          ) : speedTestResults[domain.uptime_url]?.status === 'success' ? (
                            <div className="flex items-center gap-1 text-green-600 dark:text-green-400">
                              <CheckCircle className="h-3 w-3" />
                              <span className="flex items-center gap-1">
                                <Clock className="h-3 w-3" />
                                {speedTestResults[domain.uptime_url]?.responseTime}ms
                              </span>
                            </div>
                          ) : speedTestResults[domain.uptime_url]?.status === 'error' ? (
                            <div className="flex items-center gap-1 text-red-600 dark:text-red-400">
                              <AlertCircle className="h-3 w-3" />
                              <span className="text-xs">{speedTestResults[domain.uptime_url]?.error || 'Error'}</span>
                            </div>
                          ) : (
                            // <Button
                            //   variant="ghost"
                            //   size="sm"
                            //   className="h-6 text-xs"
                            //   onClick={(e) => {
                            //     e.stopPropagation();
                            //     testUrlSpeed(domain.uptime_url);
                            //   }}
                            //   disabled={testingUrls.has(domain.uptime_url)}
                            // >
                            //   <Gauge className="h-3 w-3 mr-1" />
                            //   Test
                            // </Button>
                            <></>
                          )}
                        </div>
                      </div>

                      {/* Inner Pages Test Results */}
                      {(domain.inner_pages || []).length > 0 && (
                        <div className="space-y-1">
                          {(domain.inner_pages || []).map((url, index) => (
                            <div
                              key={index}
                              className={`flex items-center gap-2 p-2 rounded-md text-xs border ${speedTestResults[url]?.status === 'success'
                                ? 'bg-green-50 dark:bg-green-900/10 border-green-200 dark:border-green-800'
                                : speedTestResults[url]?.status === 'error'
                                  ? 'bg-red-50 dark:bg-red-900/10 border-red-200 dark:border-red-800'
                                  : 'bg-muted/50 border-border'
                                }`}
                            >
                              <LinkIcon className="h-3 w-3 flex-shrink-0" />
                              <span className="flex-1 truncate font-mono text-xs">{url}</span>
                              {speedTestResults[url]?.status === 'testing' ? (
                                <div className="flex items-center gap-1 text-muted-foreground">
                                  <div className="h-3 w-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
                                  <span>Testing...</span>
                                </div>
                              ) : speedTestResults[url]?.status === 'success' ? (
                                <div className="flex items-center gap-1 text-green-600 dark:text-green-400">
                                  <CheckCircle className="h-3 w-3" />
                                  <span className="flex items-center gap-1">
                                    <Clock className="h-3 w-3" />
                                    {speedTestResults[url]?.responseTime}ms
                                  </span>
                                </div>
                              ) : speedTestResults[url]?.status === 'error' ? (
                                <div className="flex items-center gap-1 text-red-600 dark:text-red-400">
                                  <AlertCircle className="h-3 w-3" />
                                  <span className="text-xs">{speedTestResults[url]?.error || 'Error'}</span>
                                </div>
                              ) : (
                                <div className="flex items-center gap-1">
                                  {/* <Button
                                variant="ghost"
                                size="sm"
                                className="h-6 w-6 p-0"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  testUrlSpeed(url);
                                }}
                                disabled={testingUrls.has(url)}
                                title="Test Speed"
                              >
                                <Gauge className="h-3 w-3" />
                              </Button> */}
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-6 w-6 p-0 text-red-600 hover:text-red-700"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      removeUrl(domain.id, index);
                                    }}
                                    title="Remove URL"
                                  >
                                    <Trash2 className="h-3 w-3" />
                                  </Button>
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="pt-2 border-t">
                      <Button
                        variant="secondary"
                        size="sm"
                        className="w-full"
                        onClick={(e) => {
                          e.stopPropagation();
                          openAddUrlModal(domain.id);
                        }}
                      >
                        <Plus className="h-4 w-4 mr-2" />
                        Add URL
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        className="w-full mt-2"
                        onClick={(e) => {
                          e.stopPropagation();
                          router.push(`/speed-test/${domain.id}`);
                        }}
                      >
                        <Gauge className="h-4 w-4 mr-2" />
                        View Analysis
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
      {/* Add URL Modal */}
      {openModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <Card className="w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>Add URLs for Speed Test</CardTitle>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={closeModal}
                  className="h-6 w-6"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
              <CardDescription>
                Add URLs or inner pages to test for{" "}
                {domains.find((d) => d.id === openModal)?.display_name ||
                  domains.find((d) => d.id === openModal)?.domain_name}
                <br />
                <span className="text-xs mt-1 block">
                  Enter one URL at a time and click Add
                </span>
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {/* Single URL Input */}
                <div>
                  <label className="text-sm font-medium mb-2 block">
                    Add URL
                  </label>
                  <div className="flex gap-2">
                    <Input
                      type="url"
                      placeholder="https://example.com/page"
                      value={newUrl}
                      onChange={(e) => {
                        setNewUrl(e.target.value);
                        setError("");
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          if (newUrl.trim() && openModal) {
                            addSingleUrl(openModal, newUrl.trim());
                          }
                        }
                      }}
                      className="flex-1"
                    />
                    <Button
                      onClick={() => {
                        if (newUrl.trim() && openModal) {
                          addSingleUrl(openModal, newUrl.trim());
                        }
                      }}
                      disabled={!newUrl.trim() || (openModal ? addingUrls.has(newUrl.trim()) : false)}
                    >
                      {openModal && addingUrls.has(newUrl.trim()) ? (
                        <span className="flex items-center gap-1">
                          <div className="h-4 w-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                          Adding...
                        </span>
                      ) : (
                        <>
                          <Plus className="h-4 w-4 mr-2" />
                          Add
                        </>
                      )}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    Enter one URL at a time and click Add
                  </p>
                </div>

                {/* List of Added URLs */}
                {(() => {
                  const domain = domains.find((d) => d.id === openModal);
                  const existingUrls = domain?.inner_pages || [];

                  if (existingUrls.length === 0) return null;

                  return (
                    <div className="space-y-2">
                      <p className="text-xs font-medium text-foreground">
                        Added URLs ({existingUrls.length}):
                      </p>
                      <div className="space-y-2 max-h-64 overflow-y-auto border rounded-md p-2">
                        {existingUrls.map((url, idx) => (
                          <div
                            key={idx}
                            className="flex items-center gap-2 p-2 rounded-md bg-muted/50"
                          >
                            <LinkIcon className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                            <span className="flex-1 text-xs font-mono truncate">
                              {url}
                            </span>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => removeUrl(openModal!, idx)}
                              className="flex-shrink-0 h-7 w-7 p-0 text-red-600 hover:text-red-700"
                              title="Remove URL"
                            >
                              <Trash2 className="h-3 w-3" />
                            </Button>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })()}

                {error && (
                  <div className="p-3 bg-red-50 dark:bg-red-900/10 rounded-md border border-red-200 dark:border-red-800">
                    <div className="text-xs text-red-600 dark:text-red-400 whitespace-pre-line">
                      {error}
                    </div>
                  </div>
                )}
                <div className="flex gap-2">
                  <Button variant="outline" onClick={closeModal} className="w-full">
                    Close
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

    </div>
  );
}

