import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, startUiCheck } from "@/utils/funnel-tester";

// Start a UI check on the funnel-tester backend: loads the page on desktop and
// mobile, clicks every quote button and looks for visual problems. No forms are
// submitted, so unlike the funnel test it creates no leads.
export async function POST(request: NextRequest) {
  try {
    const { supabase, error } = await requireAdmin();
    if (error) return error;

    const { funnelId } = await request.json();
    if (!funnelId) {
      return NextResponse.json({ error: "Funnel ID is required" }, { status: 400 });
    }

    // Use the stored URL rather than one sent by the browser
    const { data: funnel, error: funnelError } = await supabase
      .from("funnels")
      .select("id, name, url, ui_status")
      .eq("id", funnelId)
      .single();

    // PGRST116 = no row came back; anything else is a real database error worth showing
    if (funnelError && funnelError.code !== "PGRST116") throw funnelError;
    if (!funnel) {
      return NextResponse.json({ error: "Funnel not found" }, { status: 404 });
    }
    if (funnel.ui_status === "running") {
      return NextResponse.json({ error: "A UI check is already running for this funnel" }, { status: 409 });
    }

    const { runId, startedAt } = await startUiCheck(supabase, funnel);

    return NextResponse.json({ success: true, run_id: runId, started_at: startedAt });
  } catch (error: any) {
    console.error("UI check start error:", error);
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    );
  }
}
