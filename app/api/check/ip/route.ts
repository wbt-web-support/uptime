import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { checkDomainIpRecords } from "@/utils/monitoring";
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
    const { domainId, domain } = await request.json();
    
    if (!domainId || !domain) {
      return NextResponse.json({ error: "Domain ID and domain name are required" }, { status: 400 });
    }
    
    // Check if user is admin (only admins can trigger checks)
    const adminEmail = process.env.ADMIN_EMAIL || "admin@example.com";
    const adminEmails = adminEmail.split(',').map(email => email.trim().toLowerCase());
    
    if (!session.user?.email || !adminEmails.includes(session.user.email.toLowerCase())) {
      return NextResponse.json({ error: "Admin access required" }, { status: 403 });
    }
    
    // Perform the IP records check
    const result = await checkDomainIpRecords(domainId, domain);
    
    // Check for IP changes from previous records
    if (result.ipChanged) {
      try {
        // Get domain info for notification
        const { data: domainData } = await supabase
          .from("domains")
          .select("domain_name, display_name, notify_on_downtime")  // Using downtime flag for IP changes
          .eq("id", domainId)
          .single();
          
        if (domainData && domainData.notify_on_downtime) {
          await sendAlert({
            type: "ip-change",
            domain: domainData.domain_name,
            displayName: domainData.display_name,
            message: `IP address change detected for ${domainData.display_name || domainData.domain_name}. Old IP: ${result.previousIp}, New IP: ${result.primaryIp}`,
          });
          console.log(`IP change alert sent for ${domainData.domain_name}`);
        }
      } catch (alertError) {
        console.error("Failed to send IP change alert:", alertError);
      }
    }
    
    return NextResponse.json({
      success: true,
      primary_ip: result.primaryIp,
      all_ips: result.allIps,
      nameservers: result.nameservers,
      mx_records: result.mxRecords,
      tag: result.tag,
      checked_at: new Date().toISOString(),
      ip_changed: result.ipChanged || false,
      previous_ip: result.previousIp || null
    });
    
  } catch (error: any) {
    console.error("IP check error:", error);
    return NextResponse.json(
      { error: apiErrorMessage(error) },
      { status: 500 }
    );
  }
} 