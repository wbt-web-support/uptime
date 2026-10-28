import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/utils/funnel-tester";
import { runFunnelHealthCheck } from "@/utils/funnel-health";

export const maxDuration = 300;

// "Check now" on a website's page: the daily no-submit check of the funnels given
// (nothing is filled in or sent), two at a time, answered when all are done
export async function POST(request: NextRequest) {
  try {
    const { supabase, error } = await requireAdmin();
    if (error) return error;

    const { funnelIds } = await request.json();
    if (!Array.isArray(funnelIds) || funnelIds.length === 0) {
      return NextResponse.json({ error: "funnelIds is required" }, { status: 400 });
    }

    // Use the stored URLs rather than ones sent by the browser
    const { data: funnels, error: funnelsError } = await supabase
      .from("funnels")
      .select("id, name, url")
      // 16 at ~30s each, two at a time, fits in maxDuration
      .in("id", funnelIds.slice(0, 16));
    if (funnelsError) throw funnelsError;

    const results: Record<string, unknown> = {};
    const queue = [...(funnels ?? [])];
    const worker = async () => {
      for (let f = queue.shift(); f; f = queue.shift()) {
        try {
          results[f.id] = await runFunnelHealthCheck(supabase, f);
        } catch (err: any) {
          results[f.id] = { error: err.message };
        }
      }
    };
    await Promise.all([worker(), worker()]);
    return NextResponse.json({ results });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
