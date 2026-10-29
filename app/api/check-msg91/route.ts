import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { apiErrorMessage } from "@/utils/api-error";

interface MSG91Config {
  authKey: string | null;
  templateId: string | null;
  clientInitialized: boolean;
  validCredentials: boolean;
  error: {
    message: string;
    code?: string;
    status?: number;
  } | null;
}

export async function GET(request: NextRequest) {
  try {
    // Authenticate the request
    const supabase = await createClient();
    const { data: { session } } = await supabase.auth.getSession();
    
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    
    // Check if user is admin
    const adminEmail = process.env.ADMIN_EMAIL || "admin@example.com";
    const adminEmails = adminEmail.split(',').map(email => email.trim().toLowerCase());
    
    if (!session.user?.email || !adminEmails.includes(session.user.email.toLowerCase())) {
      return NextResponse.json({ error: "Admin access required" }, { status: 403 });
    }
    
    // Check MSG91 configuration
    const configStatus: MSG91Config = {
      authKey: process.env.MSG91_AUTH_KEY ? 
        `${process.env.MSG91_AUTH_KEY.substring(0, 6)}...` : null,
      templateId: process.env.MSG91_TEMPLATE_ID || null,
      clientInitialized: false,
      validCredentials: false,
      error: null
    };
    
    // Validate the configuration by checking if auth key and template ID are set
    if (process.env.MSG91_AUTH_KEY && process.env.MSG91_TEMPLATE_ID) {
      configStatus.clientInitialized = true;
      configStatus.validCredentials = true;
    } else {
      if (!process.env.MSG91_AUTH_KEY) {
        configStatus.error = {
          message: "MSG91 Auth Key is not configured"
        };
      } else if (!process.env.MSG91_TEMPLATE_ID) {
        configStatus.error = {
          message: "MSG91 Template ID is not configured"
        };
      }
    }
    
    // Get phone recipients from database
    const { data: phoneRecipients, error: phoneError } = await supabase
      .from("notification_phones")
      .select("phone_number");
    
    if (phoneError) {
      return NextResponse.json({ 
        error: "Failed to fetch phone recipients", 
        details: phoneError 
      }, { status: 500 });
    }
    
    return NextResponse.json({
      message: "MSG91 configuration status",
      config: configStatus,
      recipients: phoneRecipients || []
    });
  } catch (error: any) {
    console.error("MSG91 check error:", error);
    return NextResponse.json(
      { error: apiErrorMessage(error) },
      { status: 500 }
    );
  }
} 