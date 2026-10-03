import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, funnelTesterFetch } from "@/utils/funnel-tester";

// Screenshots stay on the funnel-tester backend; this passes one through so the
// browser never talks to the backend (or needs its API key) directly.
export async function GET(request: NextRequest) {
  try {
    const { error } = await requireAdmin();
    if (error) return error;

    const path = request.nextUrl.searchParams.get("path");
    // The backend only serves files under its screenshots folder; only ask for PNGs
    if (!path || !path.toLowerCase().endsWith(".png")) {
      return NextResponse.json({ error: "A .png screenshot path is required" }, { status: 400 });
    }

    const res = await funnelTesterFetch(`/screenshot?path=${encodeURIComponent(path)}`);
    if (!res.ok) {
      return NextResponse.json(
        { error: res.status === 404 ? "Screenshot no longer exists on the funnel tester" : `Funnel tester responded with status ${res.status}` },
        { status: res.status === 404 ? 404 : 502 }
      );
    }

    return new NextResponse(await res.arrayBuffer(), {
      headers: {
        "Content-Type": "image/png",
        // A given path never changes once written
        "Cache-Control": "private, max-age=86400",
      },
    });
  } catch (error: any) {
    console.error("Funnel screenshot error:", error);
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    );
  }
}
