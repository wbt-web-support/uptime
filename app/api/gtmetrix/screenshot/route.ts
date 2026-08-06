import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/pagespeed";
import { fetchGTmetrixResource } from "@/utils/gtmetrix";

// Proxies the GTmetrix report screenshot for a saved result row. The
// screenshot URL in the report's links requires API-key auth, so the browser
// can't load it directly. Free to fetch — report resources don't cost credits.

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const id = request.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  const admin = createAdminClient();
  const { data: row } = await admin
    .from("gtmetrix_results")
    .select("raw_data")
    .eq("id", id)
    .single();

  const screenshotUrl = row?.raw_data?.links?.screenshot;
  if (!screenshotUrl) {
    return NextResponse.json({ error: "No screenshot for this result" }, { status: 404 });
  }

  const res = await fetchGTmetrixResource(screenshotUrl);
  if (!res.ok) {
    return NextResponse.json({ error: "Failed to fetch screenshot" }, { status: 502 });
  }

  return new NextResponse(res.body, {
    headers: {
      "Content-Type": res.headers.get("content-type") || "image/jpeg",
      "Cache-Control": "private, max-age=86400", // screenshots are immutable per report
    },
  });
}
