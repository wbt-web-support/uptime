import { NextResponse } from "next/server";
import { requireAdmin, funnelTesterFetch } from "@/utils/funnel-tester";

// How many SMS verification codes each test phone number has received today,
// against the funnel tester's daily limit per number
export async function GET() {
  try {
    const { error } = await requireAdmin();
    if (error) return error;

    const res = await funnelTesterFetch("/sms-usage");
    if (!res.ok) {
      return NextResponse.json({ error: `Funnel tester responded with status ${res.status}` }, { status: 502 });
    }
    return NextResponse.json(await res.json());
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "Internal server error" }, { status: 500 });
  }
}
