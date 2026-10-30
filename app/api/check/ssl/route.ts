import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { checkSSLExpiry } from "@/utils/monitoring";
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
    
    // Get the domain ID from the request body
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
    
    // Perform the SSL check
    const result = await checkSSLExpiry(domainId, domain);
    
    // If SSL is expiring soon (≤ 30 days), send alert
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
            type: "ssl-expiry",
            domain: domainData.domain_name,
            displayName: domainData.display_name,
            message: `SSL certificate for ${domainData.display_name || domainData.domain_name} is expiring in ${result.daysRemaining} days (${new Date(result.expiryDate).toLocaleDateString()}).`,
            daysRemaining: result.daysRemaining,
          });
          console.log(`SSL expiry alert sent for ${domainData.domain_name}`);
        }
      } catch (alertError) {
        console.error("Failed to send SSL expiry alert:", alertError);
      }
    }
    
    return NextResponse.json({
      success: true,
      expiry_date: result.expiryDate,
      days_remaining: result.daysRemaining,
      issuer: result.issuer,
      checked_at: new Date().toISOString(),
    });
    
  } catch (error: any) {
    console.error("SSL check error:", error);
    return NextResponse.json(
      { error: apiErrorMessage(error) },
      { status: 500 }
    );
  }
} 