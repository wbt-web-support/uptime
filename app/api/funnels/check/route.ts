import { NextRequest, NextResponse } from "next/server";
import { probeUrl } from "@/utils/monitoring";
import { requireAdmin } from "@/utils/funnel-tester";

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
      .select("id, url")
      .eq("id", funnelId)
      .single();

    // PGRST116 = no row came back; anything else is a real database error worth showing
    if (funnelError && funnelError.code !== "PGRST116") throw funnelError;
    if (!funnel) {
      return NextResponse.json({ error: "Funnel not found" }, { status: 404 });
    }

    const result = await probeUrl(funnel.url);
    const checkedAt = new Date().toISOString();

    const { error: updateError } = await supabase
      .from("funnels")
      .update({
        last_status: result.isUp,
        last_status_code: result.statusCode,
        last_response_time: result.responseTime,
        last_error: result.error,
        last_checked_at: checkedAt,
      })
      .eq("id", funnelId);

    if (updateError) throw updateError;

    return NextResponse.json({
      success: true,
      status: result.isUp,
      status_code: result.statusCode,
      response_time: result.responseTime,
      error: result.error,
      checked_at: checkedAt,
    });

  } catch (error: any) {
    console.error("Funnel check error:", error);
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    );
  }
}
