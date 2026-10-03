import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, startFunnelTest } from "@/utils/funnel-tester";

// Start an AI funnel walk on the funnel-tester backend. The walk submits the
// funnel's form for real, so every run creates a real lead on the client's site.
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
      .select("id, name, url, test_status")
      .eq("id", funnelId)
      .single();

    // PGRST116 = no row came back; anything else is a real database error worth showing
    if (funnelError && funnelError.code !== "PGRST116") throw funnelError;
    if (!funnel) {
      return NextResponse.json({ error: "Funnel not found" }, { status: 404 });
    }
    if (funnel.test_status === "running") {
      return NextResponse.json({ error: "A test is already running for this funnel" }, { status: 409 });
    }

    const { runId, startedAt } = await startFunnelTest(supabase, funnel);

    return NextResponse.json({ success: true, run_id: runId, started_at: startedAt });
  } catch (error: any) {
    console.error("Funnel test start error:", error);
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    );
  }
}
