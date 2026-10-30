import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { sendAlert } from "@/utils/email";
import { apiErrorMessage } from "@/utils/api-error";

// This endpoint allows testing of the notification system
export async function POST(request: NextRequest) {
  try {
    // Authenticate the request
    const supabase = await createClient();
    const { data: { session } } = await supabase.auth.getSession();
    
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    
    // Check if user is admin (only admins can trigger notifications)
    const adminEmail = process.env.ADMIN_EMAIL || "admin@example.com";
    const adminEmails = adminEmail.split(',').map(email => email.trim().toLowerCase());
    
    if (!session.user?.email || !adminEmails.includes(session.user.email.toLowerCase())) {
      return NextResponse.json({ error: "Admin access required" }, { status: 403 });
    }
    
    // Get test parameters from request
    const { type, domain, message, daysRemaining } = await request.json();
    
    if (!type || !domain) {
      return NextResponse.json({ 
        error: "Required parameters missing. Need type and domain." 
      }, { status: 400 });
    }
    
    // Validate notification type
    if (!['downtime', 'ssl-expiry', 'domain-expiry', 'ip-change'].includes(type)) {
      return NextResponse.json({ 
        error: "Invalid notification type. Must be one of: downtime, ssl-expiry, domain-expiry, ip-change" 
      }, { status: 400 });
    }
    
    // Get domain display name if available
    const { data: domainData } = await supabase
      .from("domains")
      .select("display_name")
      .eq("domain_name", domain)
      .single();
    
    // Prepare the test notification
    const alertOptions = {
      type: type as 'downtime' | 'ssl-expiry' | 'domain-expiry' | 'ip-change',
      domain: domain,
      displayName: domainData?.display_name || domain,
      message: message || getDefaultMessage(type, domain, domainData?.display_name, daysRemaining),
      daysRemaining: daysRemaining !== undefined ? Number(daysRemaining) : undefined
    };
    
    // Send the notification
    const success = await sendAlert(alertOptions);
    
    // Check if we have any notification recipients configured
    const { data: emailRecipients } = await supabase
      .from("notification_emails")
      .select("email");
    
    const { data: phoneRecipients } = await supabase
      .from("notification_phones")
      .select("phone_number");
    
    // Get notification settings
    const { data: notificationSettings } = await supabase
      .from("notification_settings")
      .select("*")
      .limit(1)
      .single();
    
    // Return response
    return NextResponse.json({
      success: success,
      message: "Test notification sent",
      alertOptions,
      recipients: {
        emails: emailRecipients?.map(r => r.email) || [],
        phones: phoneRecipients?.map(r => r.phone_number) || []
      },
      settings: {
        emailEnabled: notificationSettings?.email_enabled ?? true,
        smsEnabled: notificationSettings?.sms_enabled ?? true
      }
    });
    
  } catch (error: any) {
    console.error("Error sending test notification:", error);
    return NextResponse.json(
      { error: apiErrorMessage(error) },
      { status: 500 }
    );
  }
}

// Helper function to generate a default message based on notification type
function getDefaultMessage(
  type: string, 
  domain: string, 
  displayName?: string,
  daysRemaining?: number
): string {
  const domainName = displayName || domain;
  
  switch (type) {
    case 'downtime':
      return `${domainName} is currently DOWN. This is a test notification.`;
    case 'ssl-expiry':
      return `SSL certificate for ${domainName} is expiring in ${daysRemaining || 30} days. This is a test notification.`;
    case 'domain-expiry':
      return `Domain ${domainName} is expiring in ${daysRemaining || 30} days. This is a test notification.`;
    case 'ip-change':
      return `IP address change detected for ${domainName}. This is a test notification.`;
    default:
      return `Test notification for ${domainName}`;
  }
} 