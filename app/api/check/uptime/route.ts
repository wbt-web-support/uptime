import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { checkDomainUptime } from "@/utils/monitoring";
import { sendAlert } from "@/utils/email";
import { apiErrorMessage } from "@/utils/api-error";

export async function POST(request: NextRequest) {
  try {
    // Authenticate the request
    const supabase = await createClient();
    const { data: { session } } = await supabase.auth.getSession();
    
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    
    // Get the domain info from the request body
    const { domainId, url } = await request.json();
    
    if (!domainId || !url) {
      return NextResponse.json({ error: "Domain ID and URL are required" }, { status: 400 });
    }
    
    // Check if user is admin (only admins can trigger checks)
    const adminEmail = process.env.ADMIN_EMAIL || "admin@example.com";
    const adminEmails = adminEmail.split(',').map(email => email.trim().toLowerCase());
    
    if (!session.user?.email || !adminEmails.includes(session.user.email.toLowerCase())) {
      return NextResponse.json({ error: "Admin access required" }, { status: 403 });
    }
    
    // Perform the uptime check
    const result = await checkDomainUptime(domainId, url);
    
    // If site is down, send alert
    if (!result) {
      try {
        // Get domain info for notification
        const { data: domainData } = await supabase
          .from("domains")
          .select("domain_name, display_name, notify_on_downtime")
          .eq("id", domainId)
          .single();
          
        if (domainData && domainData.notify_on_downtime) {
          await sendAlert({
            type: "downtime",
            domain: domainData.domain_name,
            displayName: domainData.display_name,
            message: `${domainData.display_name || domainData.domain_name} (${url}) is currently DOWN.`,
          });
          console.log(`Downtime alert sent for ${domainData.domain_name}`);
        }
      } catch (alertError) {
        console.error("Failed to send downtime alert:", alertError);
      }
    }
    
    return NextResponse.json({
      success: true,
      status: result,
      checked_at: new Date().toISOString(),
    });
    
  } catch (error: any) {
    console.error("Uptime check error:", error);
    return NextResponse.json(
      { error: apiErrorMessage(error) },
      { status: 500 }
    );
  }
} 