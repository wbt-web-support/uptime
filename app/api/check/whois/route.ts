import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { checkDomainExpiry } from "@/utils/monitoring";
import { sendAlert } from "@/utils/email";
import { apiErrorMessage } from "@/utils/api-error";

const WHOIS_REUSE_DAYS = 7;

export async function POST(request: NextRequest) {
  try {
    // Authenticate the request
    const supabase = await createClient();
    const { data: { session } } = await supabase.auth.getSession();
    
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    
    // Get the domain info from the request body. reuseRecent (sent by "Check
    // Selected") keeps an expiry date looked up in the last WHOIS_REUSE_DAYS
    // instead of looking it up again - it rarely changes, and a bulk check of
    // ~200 domains otherwise hits the lookup services' request limits
    const { domainId, domain, reuseRecent } = await request.json();
    
    if (!domainId || !domain) {
      return NextResponse.json({ error: "Domain ID and domain name are required" }, { status: 400 });
    }
    
    // Check if user is admin (only admins can trigger checks)
    const adminEmail = process.env.ADMIN_EMAIL || "admin@example.com";
    const adminEmails = adminEmail.split(',').map(email => email.trim().toLowerCase());
    
    if (!session.user?.email || !adminEmails.includes(session.user.email.toLowerCase())) {
      return NextResponse.json({ error: "Admin access required" }, { status: 403 });
    }
    
    if (reuseRecent) {
      const since = new Date(Date.now() - WHOIS_REUSE_DAYS * 24 * 60 * 60 * 1000).toISOString();
      const { data: recent } = await supabase
        .from("domain_expiry")
        .select("expiry_date, days_remaining, registrar, checked_at")
        .eq("domain_id", domainId)
        .gte("checked_at", since)
        .not("expiry_date", "is", null)
        .order("checked_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (recent) {
        return NextResponse.json({ success: true, reused: true, ...recent });
      }
    }

    // Perform the domain expiry check
    const result = await checkDomainExpiry(domainId, domain);
    
    // If domain is expiring soon (≤ 30 days), send alert
    if (result.daysRemaining <= 30) {
      try {
        // Get domain info for notification
        const { data: domainData } = await supabase
          .from("domains")
          .select("domain_name, display_name, notify_on_expiry")
          .eq("id", domainId)
          .single();
          
        if (domainData && domainData.notify_on_expiry) {
          await sendAlert({
            type: "domain-expiry",
            domain: domainData.domain_name,
            displayName: domainData.display_name,
            message: `Domain ${domainData.display_name || domainData.domain_name} is expiring in ${result.daysRemaining} days (${new Date(result.expiryDate).toLocaleDateString()}).`,
            daysRemaining: result.daysRemaining,
          });
          console.log(`Domain expiry alert sent for ${domainData.domain_name}`);
        }
      } catch (alertError) {
        console.error("Failed to send domain expiry alert:", alertError);
      }
    }
    
    return NextResponse.json({
      success: true,
      expiry_date: result.expiryDate,
      days_remaining: result.daysRemaining,
      registrar: result.registrar,
      checked_at: new Date().toISOString(),
    });
    
  } catch (error: any) {
    console.error("Domain expiry check error:", error);
    return NextResponse.json(
      { error: apiErrorMessage(error) },
      { status: 500 }
    );
  }
} 