"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
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

function DeviceDetail({ result, ui, title, icon: Icon, testing, uiRunning, message, uiMessage, liveScreenshot }: {
  result?: DeviceResult;
  ui?: UiResult;
  title: string;
  icon: any;
  testing: boolean;
  uiRunning: boolean;
  message?: string;
  uiMessage?: string;
  liveScreenshot?: string;
}) {
  return (
    <div className="rounded-lg border bg-background p-4">
      <div className="mb-3 flex items-center gap-2 text-sm font-medium">
        <Icon className="h-4 w-4 text-muted-foreground" />
        {title}
        {!testing && result && (
          <span className={`ml-auto rounded-full px-2.5 py-0.5 text-xs font-semibold ${resultColor(result.status)}`}>
            {RESULT_LABEL[result.status]}
          </span>
        )}
      </div>
      {testing ? (
        <>
          <p className="text-sm text-muted-foreground">{message || "Waiting to start..."}</p>
          {liveScreenshot && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={screenshotUrl(liveScreenshot)}
              alt={`What the ${title.toLowerCase()} test is looking at`}
              className="mt-3 max-h-72 w-full rounded-md border object-contain object-top"
            />
          )}
        </>
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
          {result.failure && (
            <p className="mt-3 rounded-md bg-red-50 p-2 text-xs text-red-700 dark:bg-red-950 dark:text-red-400">
              {result.failure}
            </p>
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
          <p className="text-xs text-red-600 dark:text-red-400">{ui.error || "Check failed"}</p>
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
  // Newest screenshot from a running test, per funnel
  const [testScreens, setTestScreens] = useState<Record<string, string>>({});
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

  useEffect(() => {
    fetchData();
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
    if (!window.confirm(`Delete funnel "${funnel.name}"?`)) return;
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
          setTestScreens(prev => {
            const { [id]: _, ...rest } = prev;
            return rest;
          });
          return data.funnel;
        }
        if (data.message) setTestMessages(prev => ({ ...prev, [id]: data.message }));
        if (data.screenshot) setTestScreens(prev => ({ ...prev, [id]: data.screenshot }));
      } catch (err: any) {
        setError(err.message);
        return null;
      }
      await sleep(TEST_POLL_MS);
    }
  };

  // Start a walk (or join one already running) and wait for it to finish
  const runTest = async (funnel: Funnel): Promise<Funnel | null> => {
    if (funnel.test_status !== "running") {
      try {
        const res = await fetch("/api/funnels/test", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ funnelId: funnel.id }),
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

  const REAL_LEAD_WARNING = "The funnel test fills in and submits the form for real on desktop and on mobile, so each test creates 2 real leads on the client's site.";

  const testOne = (funnel: Funnel) => {
    if (!window.confirm(`Test "${funnel.name}"?\n\n${REAL_LEAD_WARNING}`)) return;
    setError("");
    setSuccess("");
    runTest(funnel);
  };

  // Test every funnel in the list, strictly one after another
  const testAll = async () => {
    const list = filteredFunnels;
    if (list.length === 0) return;
    if (!window.confirm(`Test ${list.length} ${list.length === 1 ? "funnel" : "funnels"} one by one?\n\n${REAL_LEAD_WARNING}\nEach test can take a few minutes.`)) return;

    setError("");
    setSuccess("");
    stopTestAllRef.current = false;
    setStopRequested(false);
    let passed = 0;
    let done = 0;

    for (const funnel of list) {
      if (stopTestAllRef.current) break;
      setTestAllProgress({ done, total: list.length, current: funnel.name });
      const result = await runTest(funnel);
      if (result?.test_status === "passed") passed++;
      done++;
    }

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
      const result = await runUiCheck(funnel);
      if (result?.ui_status === "ok") ok++;
      done++;
    }

    setUiAllProgress(null);
    const stopped = done < list.length ? ` (stopped after ${done} of ${list.length})` : "";
    setSuccess(`UI checks finished: ${ok} of ${done} with no problems${stopped}`);
  };

  // Test all and UI check all share the progress bar and Stop button
  const bulkProgress = testAllProgress ?? uiAllProgress;
  const bulkLabel = testAllProgress ? "Testing" : "UI checking";

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
        <p className="text-xs text-muted-foreground">
          Showing {filteredFunnels.length} of {funnels.length}
        </p>
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
              onClick={() => { stopTestAllRef.current = true; setStopRequested(true); }}
              disabled={stopRequested}
              title="Stop after the current funnel finishes"
            >
              <Square className="mr-1.5 h-3.5 w-3.5" />
              Stop
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
                onClick={testAll}
                disabled={loading || filteredFunnels.length === 0}
                title="Test every funnel in the list, one by one"
              >
                <Play className="mr-1.5 h-3.5 w-3.5" />
                Test all
              </Button>
            </>
          )}
          <Button size="sm" onClick={() => setShowAddForm(s => !s)}>
            {showAddForm ? <X className="mr-1.5 h-3.5 w-3.5" /> : <Plus className="mr-1.5 h-3.5 w-3.5" />}
            {showAddForm ? "Cancel" : "Add funnel"}
          </Button>
        </div>
      </div>

      {bulkProgress && (
        <div className="mb-4 rounded-lg border p-4">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-sm">
            <span>
              {bulkLabel} <span className="font-medium">{bulkProgress.current}</span>
              <span className="text-muted-foreground"> ({bulkProgress.done + 1} of {bulkProgress.total})</span>
            </span>
            <span className="font-medium">{Math.round((bulkProgress.done / bulkProgress.total) * 100)}%</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-brand transition-all"
              style={{ width: `${(bulkProgress.done / bulkProgress.total) * 100}%` }}
            />
          </div>
          {stopRequested && (
            <p className="mt-2 text-xs text-muted-foreground">Stopping after this funnel finishes...</p>
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
          {filteredFunnels.map(funnel => {
            const isTesting = funnel.test_status === "running";
            const isChecking = checkingIds.has(funnel.id);
            const isExpanded = expanded.has(funnel.id);
            const lastTested = funnel.test_finished_at;
            const client = clientName(funnel);
            return (
              <div key={funnel.id}>
                <div
                  className="flex cursor-pointer flex-wrap items-center gap-3 p-4 hover:bg-muted/50"
                  onClick={() => toggleExpand(funnel.id)}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{funnel.name}</div>
                    <div className="truncate text-xs text-muted-foreground">{funnel.url}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <PagePill funnel={funnel} checking={isChecking} />
                    <UiPill funnel={funnel} />
                    <DevicePill result={deviceResult(funnel, "mobile")} testing={isTesting} icon={Smartphone} />
                    <DevicePill result={deviceResult(funnel, "desktop")} testing={isTesting} icon={Monitor} />
                  </div>
                  {lastTested && !isTesting && (
                    <span className="hidden text-xs text-muted-foreground md:inline">
                      {new Date(lastTested).toLocaleDateString()}
                    </span>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={isTesting || !!bulkProgress}
                    onClick={e => {
                      e.stopPropagation();
                      testOne(funnel);
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
                {isTesting && testMessages[funnel.id] && (
                  <div className="truncate px-4 pb-3 text-xs text-muted-foreground" title={testMessages[funnel.id]}>
                    {testMessages[funnel.id]}
                  </div>
                )}
                {isExpanded && (
                  <div className="space-y-3 border-t bg-muted/30 p-4">
                    <div className="grid gap-3 lg:grid-cols-2">
                      {(["mobile", "desktop"] as const).map(device => {
                        const label = device === "mobile" ? "Mobile" : "Desktop";
                        // Messages and the live screenshot belong to whichever device is running
                        const onThisDevice = testMessages[funnel.id]?.startsWith(`${label}:`);
                        return (
                          <DeviceDetail
                            key={device}
                            result={deviceResult(funnel, device)}
                            ui={funnel.ui_results?.[device]}
                            title={label}
                            icon={device === "mobile" ? Smartphone : Monitor}
                            testing={isTesting}
                            uiRunning={funnel.ui_status === "running"}
                            message={onThisDevice ? testMessages[funnel.id] : undefined}
                            uiMessage={uiMessages[funnel.id]?.startsWith(`${label}:`) ? uiMessages[funnel.id] : undefined}
                            liveScreenshot={onThisDevice ? testScreens[funnel.id] : undefined}
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
          })}
        </div>
      )}
    </div>
  );
}
