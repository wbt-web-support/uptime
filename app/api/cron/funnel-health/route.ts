import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/utils/pagespeed";
import { runFunnelHealthCheck } from "@/utils/funnel-health";

// Daily no-submit check of every quote funnel (see utils/funnel-health.ts): page
// loads, quote form shows, GTM, postcode lookup, Stripe key, phone links. Nothing
// is filled in or sent, so it can run every day without creating leads.
//
// Each run checks the next few funnels not checked in the last CHECK_EVERY_HOURS,
// a couple at a time (each takes ~25s). Run it every 5 minutes (see vercel.json):
// ~240 quote pages are covered well within a day.
// Set FUNNEL_HEALTH_CHECK=false to switch it off.
//
// Auth: send `Authorization: Bearer <CRON_SECRET>` (Vercel Cron does this when
// CRON_SECRET is set).

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CHECK_EVERY_HOURS = Number(process.env.FUNNEL_HEALTH_EVERY_HOURS || 20);
const PER_RUN = Number(process.env.FUNNEL_HEALTH_PER_RUN || 2);

export async function GET(request: NextRequest) {
  const expectedSecret = process.env.CRON_SECRET;
  if (!expectedSecret) {
    console.warn("[cron/funnel-health] CRON_SECRET is not set - endpoint is unprotected.");
  } else if (request.headers.get("authorization") !== `Bearer ${expectedSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (process.env.FUNNEL_HEALTH_CHECK === "false") {
    return NextResponse.json({ message: "The daily funnel check is switched off (FUNNEL_HEALTH_CHECK=false)" });
  }

  try {
    const supabase = createAdminClient();
    const { data: funnels, error } = await supabase.from("funnels").select("*").order("created_at", { ascending: true });
    if (error) throw error;

    // Funnels checked recently are skipped
    const since = new Date(Date.now() - CHECK_EVERY_HOURS * 60 * 60 * 1000).toISOString();
    const { data: recent } = await supabase
      .from("funnel_reports")
      .select("funnel_id")
      .eq("kind", "health")
      .gte("created_at", since)
      .limit(5000);
    const checkedRecently = new Set((recent ?? []).map(r => r.funnel_id));

    // Quote pages only - a funnel that is just a site's homepage has no form on it
    const isQuotePage = (url: string) => {
      try {
        return new URL(url).pathname.replace(/\/+$/, "") !== "";
      } catch {
        return false;
      }
    };
    const due = (funnels ?? []).filter(f => f.test_enabled !== false && isQuotePage(f.url) && !checkedRecently.has(f.id));
    if (due.length === 0) return NextResponse.json({ message: "Every funnel has had its daily check" });

    const batch = due.slice(0, PER_RUN);
    const results = await Promise.all(
      batch.map(async f => {
        try {
          const r = await runFunnelHealthCheck(supabase, f);
          return { funnel: f.name, ok: r.ok, problems: r.checks.filter(c => c.status === "problem").map(c => c.label) };
        } catch (err: any) {
          return { funnel: f.name, error: err.message };
        }
      })
    );
    return NextResponse.json({ checked: results, still_due: due.length - batch.length });
  } catch (err: any) {
    console.error("[cron/funnel-health]", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
