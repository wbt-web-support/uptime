import type { SupabaseClient } from "@supabase/supabase-js";
import { funnelTesterFetch } from "@/utils/funnel-tester";
import { sendFunnelAlert } from "@/utils/notifications";

// The daily no-submit check of a funnel (tester/src/quickCheck.ts):
// page loads, quote form shows, GTM, the site's postcode lookup, the checkout's
// Stripe key, phone links. Nothing is filled in or sent, so no leads and no
// payments. Saved as funnel_reports rows of kind "health".

export type HealthStatus = "ok" | "problem" | "skipped";

export interface HealthItem {
  key: string;
  label: string;
  status: HealthStatus;
  detail: string;
}

export interface HealthResult {
  url: string;
  checked_at: string;
  ok: boolean;
  checks: HealthItem[];
}

// How many daily checks are kept per funnel
const HEALTH_KEPT = 14;
// A quick check takes ~20-30s; allow for a slow site
const QUICK_CHECK_TIMEOUT_MS = 90_000;

// The problems in a result, as one line: "Postcode lookup, Stripe"
export function healthProblems(result: HealthResult | null | undefined): HealthItem[] {
  return (result?.checks ?? []).filter(c => c.status === "problem");
}

export async function runFunnelHealthCheck(
  supabase: SupabaseClient,
  funnel: { id: string; name: string; url: string }
): Promise<HealthResult> {
  let result: HealthResult;
  try {
    const res = await funnelTesterFetch(
      "/quick-check",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: funnel.url }) },
      QUICK_CHECK_TIMEOUT_MS
    );
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.error || `Daily check failed (status ${res.status})`);
    result = body as HealthResult;
  } catch (err: any) {
    // Saved too, so the cron counts the funnel as checked and moves on instead of
    // retrying the same site every 5 minutes
    await supabase.from("funnel_reports").insert({
      funnel_id: funnel.id,
      kind: "health",
      viewport: "both",
      status: "error",
      report: { url: funnel.url, checked_at: new Date().toISOString(), error: err.message },
    });
    throw err;
  }

  // The previous daily check that ran - to tell whether this one found a new problem
  // or a fix (a check that couldn't run says neither)
  const { data: previousRows } = await supabase
    .from("funnel_reports")
    .select("report")
    .eq("funnel_id", funnel.id)
    .eq("kind", "health")
    .neq("status", "error")
    .order("created_at", { ascending: false })
    .limit(1);
  const previous = (previousRows?.[0]?.report as HealthResult | undefined) ?? null;

  // Not saved means the next run would compare against the same previous check and
  // email the same problem again - so stop before emailing
  const { error: insertError } = await supabase
    .from("funnel_reports")
    .insert({ funnel_id: funnel.id, kind: "health", viewport: "both", status: result.ok ? "ok" : "problem", report: result });
  if (insertError) throw new Error(`Daily check result not saved: ${insertError.message}`);

  // Email when a problem shows up that wasn't there last time, or when the
  // problems are all gone - not again every day while nothing changes
  const nowProblems = healthProblems(result).map(c => c.key);
  const before = new Set(healthProblems(previous).map(c => c.key));
  const fresh = healthProblems(result).filter(c => !before.has(c.key));
  const alert = fresh.length > 0 ? "broken" : previous && before.size > 0 && nowProblems.length === 0 ? "fixed" : null;
  if (alert) {
    const base = (process.env.NEXT_PUBLIC_SITE_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000")).replace(/\/$/, "");
    await sendFunnelAlert({
      kind: alert,
      funnelName: funnel.name,
      funnelUrl: funnel.url,
      reason: alert === "broken" ? fresh.map(c => `${c.label}: ${c.detail}`).join(" | ") : null,
      reportUrl: `${base}/funnel-test/site/${new URL(funnel.url).hostname.replace(/^www\./, "")}`,
      source: "daily check",
    });
  }

  const { data: older } = await supabase
    .from("funnel_reports")
    .select("id")
    .eq("funnel_id", funnel.id)
    .eq("kind", "health")
    .order("created_at", { ascending: false })
    .range(HEALTH_KEPT, HEALTH_KEPT + 100);
  if (older?.length) await supabase.from("funnel_reports").delete().in("id", older.map(r => r.id));

  return result;
}
