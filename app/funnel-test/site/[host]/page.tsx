"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { createClient } from "@/utils/supabase/client";
import { Skeleton } from "@/components/ui/skeleton";
import { FunnelStageMarks } from "@/components/FunnelStageMarks";
import { FunnelReportView } from "@/components/FunnelReportView";
import { AlertCircle, ArrowLeft, ChevronDown, ChevronUp, ExternalLink, Monitor, MousePointerClick, Smartphone, X } from "lucide-react";
import { deriveStages, explainFailure, OWNER_LABEL, type ProblemOwner } from "@/utils/funnel-report";
import { isChooserFunnel } from "@/utils/funnel-discovery";

// Everything about one website's funnel tests on one page: the landing page
// "Get a quote" check, then every funnel's stages on desktop and mobile and why any
// failed. Each step-by-step report opens right here, under the funnel it belongs to.

type Device = "desktop" | "mobile";
const DEVICES: Device[] = ["desktop", "mobile"];
const DEVICE_LABEL: Record<Device, string> = { desktop: "Desktop", mobile: "Mobile" };
const DEVICE_ICON = { desktop: Monitor, mobile: Smartphone };

interface DeviceResult {
  status: "passed" | "failed" | "error";
  failure: string | null;
  steps: number | null;
  tracking_ok: boolean | null;
  report_id?: string | null;
  site_problem?: string | null;
  results_buttons?: { ok: number; total: number; failed: string[]; payment: string } | null;
  otp_seen?: boolean;
}

interface UiResult {
  status: "ok" | "issues" | "error";
  ui_issues: string[];
  quote_buttons_found: number;
  quote_buttons_working: number;
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
}

const OWNER_TEXT: Record<ProblemOwner, string> = {
  website: "text-rose-700 dark:text-rose-400",
  tester: "text-amber-700 dark:text-amber-400",
  setup: "text-violet-700 dark:text-violet-400",
  unclear: "text-sky-700 dark:text-sky-400",
  stopped: "text-muted-foreground",
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

function Badge({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
        ok ? "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-400" : "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400"
      }`}
    >
      {children}
    </span>
  );
}

// "Show report" toggle on a device card
function ReportToggle({ open, onClick, label }: { open: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`mt-3 inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
        open ? "border-brand bg-brand text-white" : "hover:bg-muted"
      }`}
    >
      {open ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
      {open ? "Hide report" : label}
    </button>
  );
}

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

export default function SiteReportPage() {
  const params = useParams<{ host: string }>();
  const host = decodeURIComponent(params.host ?? "").toLowerCase();
  const supabase = useMemo(() => createClient(), []);
  const [funnels, setFunnels] = useState<Funnel[] | null>(null);
  const [clientName, setClientName] = useState<string | null>(null);
  const [error, setError] = useState("");
  // The one report open on the page: "<funnel id or landing>:<device>"
  const [openReport, setOpenReport] = useState<string | null>(null);
  const toggleReport = (key: string) => setOpenReport(prev => (prev === key ? null : key));

  useEffect(() => {
    (async () => {
      const { data, error: loadError } = await supabase
        .from("funnels")
        .select("id, name, url, domain_id, test_status, test_failure, test_started_at, test_finished_at, test_results, ui_results, ui_checked_at")
        .order("name", { ascending: true });
      if (loadError) {
        setError(loadError.message);
        return;
      }
      const site = (data as Funnel[]).filter(f => hostOf(f.url) === host);
      setFunnels(site);
      const domainId = site.find(f => f.domain_id)?.domain_id;
      if (domainId) {
        const { data: d } = await supabase.from("domains").select("display_name, domain_name").eq("id", domainId).maybeSingle();
        if (d) setClientName(d.display_name || d.domain_name);
      }
    })();
  }, [supabase, host]);

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
  const tested = specific.length > 0 ? specific : funnels.filter(f => !isChooserFunnel(f));
  // The landing page check is saved on whichever funnel ran it most recently
  const uiSource = funnels.filter(f => f.ui_results).sort((a, b) => (b.ui_checked_at ?? "").localeCompare(a.ui_checked_at ?? ""))[0];
  const lastTested = tested.map(f => f.test_finished_at).filter((d): d is string => !!d).sort().pop();
  const failing = tested.filter(f => f.test_status === "failed" || f.test_status === "error").length;
  const passing = tested.filter(f => f.test_status === "passed").length;

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8">
      {backLink}

      {/* Header: name, address, and how the website is doing overall */}
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4 border-b pb-5">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-bold">{siteName}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
            <a href={home?.url ?? `https://${host}/`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:text-foreground">
              {host} <ExternalLink className="h-3 w-3" />
            </a>
            <span>·</span>
            <span>{clientName ? clientName : "Added manually"}</span>
            {lastTested && (
              <>
                <span>·</span>
                <span>Last tested {shortDate(lastTested)}</span>
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-4 text-sm">
          <span><span className="text-lg font-bold text-green-600 dark:text-green-400">{passing}</span> <span className="text-muted-foreground">working</span></span>
          <span><span className="text-lg font-bold text-red-600 dark:text-red-400">{failing}</span> <span className="text-muted-foreground">failing</span></span>
          <span><span className="text-lg font-bold">{tested.length}</span> <span className="text-muted-foreground">funnel{tested.length === 1 ? "" : "s"}</span></span>
        </div>
      </div>

      {/* 1. Landing page: every "Get a quote" button clicked */}
      <section className="mb-6">
        <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          <MousePointerClick className="h-4 w-4" /> Landing page · &quot;Get a quote&quot; buttons
        </h2>
        {!uiSource ? (
          <p className="text-sm text-muted-foreground">Not checked yet - it runs at the start of every test.</p>
        ) : (
          <>
            <div className="grid gap-3 md:grid-cols-2">
              {DEVICES.map(d => {
                const ui = uiSource.ui_results?.[d];
                const Icon = DEVICE_ICON[d];
                const key = `landing:${d}`;
                const allWork = !!ui && !ui.error && ui.quote_buttons_found > 0 && ui.quote_buttons_working === ui.quote_buttons_found;
                return (
                  <div key={d} className="rounded-lg border p-3">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <Icon className="h-4 w-4 text-muted-foreground" /> {DEVICE_LABEL[d]}
                      {ui && (
                        <span className="ml-auto">
                          <Badge ok={allWork}>
                            {ui.error ? "Couldn't check" : `${ui.quote_buttons_working} of ${ui.quote_buttons_found} work`}
                          </Badge>
                        </span>
                      )}
                    </div>
                    {!ui ? (
                      <p className="mt-1 text-sm text-muted-foreground">Not checked.</p>
                    ) : ui.error ? (
                      <p className="mt-1 text-xs text-red-600 dark:text-red-400">{explainFailure(ui.error)?.title ?? ui.error}</p>
                    ) : (
                      ui.ui_issues.length > 0 && (
                        <details className="mt-2 text-xs">
                          <summary className="cursor-pointer text-amber-700 dark:text-amber-400">
                            {ui.ui_issues.length} design issue{ui.ui_issues.length === 1 ? "" : "s"} spotted
                          </summary>
                          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted-foreground">
                            {ui.ui_issues.map((issue, i) => <li key={i}>{issue}</li>)}
                          </ul>
                        </details>
                      )
                    )}
                    {ui?.report_id && <ReportToggle open={openReport === key} onClick={() => toggleReport(key)} label="Show button report" />}
                  </div>
                );
              })}
            </div>
            {DEVICES.map(d => {
              const id = uiSource.ui_results?.[d]?.report_id;
              return id && openReport === `landing:${d}` ? (
                <InlineReport key={d} id={id} title={`Landing page buttons – ${DEVICE_LABEL[d]}`} onClose={() => setOpenReport(null)} />
              ) : null;
            })}
          </>
        )}
      </section>

      {/* 2. Every funnel: its stages on each device and why any failed */}
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        Quote funnels
      </h2>
      <div className="space-y-4">
        {tested.map(f => (
          <section key={f.id} className="rounded-lg border p-4">
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="font-semibold">{serviceLabel(f)}</h3>
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                {f.test_finished_at && <span>Tested {shortDate(f.test_finished_at)}{tookText(f)}</span>}
                <a href={f.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:text-foreground">
                  Open page <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            </div>

            {f.test_status === "running" ? (
              <p className="text-sm text-blue-600 dark:text-blue-400">Testing right now…</p>
            ) : !f.test_results ? (
              <p className="text-sm text-muted-foreground">
                {f.test_failure ? explainFailure(f.test_failure)?.title ?? f.test_failure : "Not tested yet."}
              </p>
            ) : (
              <>
                <div className="grid gap-3 md:grid-cols-2">
                  {DEVICES.map(d => {
                    const r = f.test_results?.[d];
                    const Icon = DEVICE_ICON[d];
                    const key = `${f.id}:${d}`;
                    const why = r && r.status !== "passed" ? explainFailure(r.failure, r.site_problem) : null;
                    const buttons = r?.results_buttons;
                    return (
                      <div key={d} className="rounded-lg border p-3">
                        <div className="mb-2 flex items-center gap-2 text-sm font-medium">
                          <Icon className="h-4 w-4 text-muted-foreground" /> {DEVICE_LABEL[d]}
                          {r && (
                            <span className="ml-auto">
                              <Badge ok={r.status === "passed"}>{r.status === "passed" ? "Working" : "Failed"}</Badge>
                            </span>
                          )}
                        </div>
                        {!r ? (
                          <p className="text-sm text-muted-foreground">Not tested on {d}.</p>
                        ) : (
                          <>
                            <FunnelStageMarks stages={deriveStages(r)} />
                            {why && (
                              <p className={`mt-2 text-xs ${OWNER_TEXT[why.owner]}`} title={`${why.what}\n\nHow to fix: ${why.fix}`}>
                                <span className="font-semibold">{why.title}</span>
                                <span className="opacity-75"> · {OWNER_LABEL[why.owner]}</span>
                              </p>
                            )}
                            {buttons && buttons.total > 0 && (
                              <p className="mt-2 truncate text-xs text-muted-foreground" title={buttons.failed.length ? `Need a look: ${buttons.failed.join(", ")}` : undefined}>
                                Save &amp; Checkout buttons: {buttons.ok} of {buttons.total} worked
                                {buttons.payment && buttons.payment !== "Not recorded" && ` · payment ${buttons.payment.toLowerCase()}`}
                              </p>
                            )}
                            {r.report_id && (
                              <ReportToggle open={openReport === key} onClick={() => toggleReport(key)} label="Show step-by-step report" />
                            )}
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
                {DEVICES.map(d => {
                  const id = f.test_results?.[d]?.report_id;
                  return id && openReport === `${f.id}:${d}` ? (
                    <InlineReport key={d} id={id} title={`${serviceLabel(f)} – ${DEVICE_LABEL[d]} step by step`} onClose={() => setOpenReport(null)} />
                  ) : null;
                })}
              </>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
