import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, startFunnelTest, startUiCheck, parseViewports } from "@/utils/funnel-tester";

// Start a run on the funnel-tester backend, the way its own dashboard does: the full
// funnel walk on the chosen device(s) (desktop first, then mobile) together with the
// UI check. The walk submits the funnel's form for real, so each device creates a
// real lead on the client's site; the UI check submits nothing.
export async function POST(request: NextRequest) {
  try {
    const { supabase, error } = await requireAdmin();
    if (error) return error;

    const { funnelId, viewports: rawViewports, withUiCheck = true, testResultsButtons = true, ignoreCooldown = false } = await request.json();
    if (!funnelId) {
      return NextResponse.json({ error: "Funnel ID is required" }, { status: 400 });
    }
    const viewports = parseViewports(rawViewports);

    // Use the stored URL rather than one sent by the browser
    const { data: funnel, error: funnelError } = await supabase
      .from("funnels")
      .select("id, name, url, domain_id, test_status, ui_status")
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

    const { runId, startedAt } = await startFunnelTest(supabase, funnel, viewports, testResultsButtons !== false, ignoreCooldown === true);

    // The UI check is a bonus here: if it can't start, the funnel test still runs
    let uiStarted = false;
    if (withUiCheck && funnel.ui_status !== "running") {
      try {
        await startUiCheck(supabase, funnel);
        uiStarted = true;
      } catch (uiError) {
        console.error("UI check alongside funnel test failed to start:", uiError);
      }
    }

    return NextResponse.json({ success: true, run_id: runId, started_at: startedAt, viewports, ui_started: uiStarted });
  } catch (error: any) {
    console.error("Funnel test start error:", error);
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    );
  }
}
