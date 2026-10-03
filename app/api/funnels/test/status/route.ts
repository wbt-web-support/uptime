import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, syncFunnelTest } from "@/utils/funnel-tester";

// Poll a running funnel walk. While it runs, returns the walker's latest progress
// message; once it ends, saves the outcome on the funnel row and returns it.
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

    return NextResponse.json(await syncFunnelTest(supabase, funnel));
  } catch (error: any) {
    console.error("Funnel test status error:", error);
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    );
  }
}
