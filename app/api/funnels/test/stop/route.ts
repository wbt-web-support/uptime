import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, stopFunnelTest } from "@/utils/funnel-tester";

// Stop a running funnel test (and its UI check). The walker finishes the step it is
// on, then stops; the device still queued never starts. Anything already submitted
// stays submitted.
export async function POST(request: NextRequest) {
  try {
    const { supabase, error } = await requireAdmin();
    if (error) return error;

    const { funnelId } = await request.json();
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

    return NextResponse.json({ success: true, funnel: await stopFunnelTest(supabase, funnel) });
  } catch (error: any) {
    console.error("Funnel test stop error:", error);
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    );
  }
}
