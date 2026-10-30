import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, syncUiCheck } from "@/utils/funnel-tester";
import { apiErrorMessage } from "@/utils/api-error";

// Poll a running UI check. Once both devices are done, saves the outcome on the
// funnel row (and the full results to funnel_reports) and returns it.
export async function GET(request: NextRequest) {
  try {
    const { supabase, error } = await requireAdmin();
    if (error) return error;

    const funnelId = request.nextUrl.searchParams.get("funnelId");
    if (!funnelId) {
      return NextResponse.json({ error: "Funnel ID is required" }, { status: 400 });
    }

    const { data: funnel, error: funnelError } = await supabase
      .from("funnels")
      .select("*")
      .eq("id", funnelId)
      .single();

    // PGRST116 = no row came back; anything else is a real database error worth showing
    if (funnelError && funnelError.code !== "PGRST116") throw funnelError;
    if (!funnel) {
      return NextResponse.json({ error: "Funnel not found" }, { status: 404 });
    }

    return NextResponse.json(await syncUiCheck(supabase, funnel));
  } catch (error: any) {
    console.error("UI check status error:", error);
    // testerOffline: see /api/funnels/test/status
    return NextResponse.json(
      { error: apiErrorMessage(error), testerOffline: error?.code === "TESTER_OFFLINE" },
      { status: error?.code === "TESTER_OFFLINE" ? 503 : 500 }
    );
  }
}
