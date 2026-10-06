import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/utils/funnel-tester";
import { discoverAndAddFunnels } from "@/utils/funnel-discovery";

// Looks through client sites for their quote funnels (boiler, ASHP, air con, solar,
// battery...) and adds any not already listed. Reads public pages only; nothing is
// submitted. Pass domainId to check one client, or nothing to check them all.
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  try {
    const { supabase, error } = await requireAdmin();
    if (error) return error;

    const { domainId, site } = await request.json().catch(() => ({}));

    // A website added by hand: { site: { name, url } } - its funnels get no client
    if (site?.url) {
      let url: URL;
      try {
        url = new URL(/^https?:\/\//i.test(site.url) ? site.url : `https://${site.url}`);
      } catch {
        return NextResponse.json({ error: "Please enter a valid landing page URL" }, { status: 400 });
      }
      const result = await discoverAndAddFunnels(supabase, [
        {
          id: null,
          domain_name: url.hostname.replace(/^www\./, ""),
          display_name: String(site.name || "").trim() || url.hostname,
          uptime_url: url.toString(),
        },
      ]);
      return NextResponse.json({ success: true, ...result });
    }

    let query = supabase.from("domains").select("id, domain_name, display_name, uptime_url");
    if (domainId) query = query.eq("id", domainId);
    const { data: domains, error: domainsError } = await query;
    if (domainsError) throw domainsError;

    const result = await discoverAndAddFunnels(supabase, domains || []);
    return NextResponse.json({ success: true, ...result });
  } catch (error: any) {
    console.error("Funnel discovery error:", error);
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    );
  }
}
