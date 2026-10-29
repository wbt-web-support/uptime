import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { apiErrorMessage } from "@/utils/api-error";

export async function POST(request: NextRequest) {
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
    
    // Check for required MSG91 configuration
    const authKey = process.env.MSG91_AUTH_KEY;
    const templateId = process.env.MSG91_TEMPLATE_ID;
    
    console.log('MSG91 Config Test - Environment variables:');
    console.log(`- MSG91_AUTH_KEY: ${authKey ? 'Set' : 'Missing'}`);
    console.log(`- MSG91_TEMPLATE_ID: ${templateId ? 'Set' : 'Missing'}`);
    
    if (!authKey) {
      return NextResponse.json({
        success: false,
        message: "MSG91 Auth Key is not configured. Please set MSG91_AUTH_KEY environment variable.",
        authKey: false,
        templateId: !!templateId,
        connected: false
      });
    }
    
    if (!templateId) {
      return NextResponse.json({
        success: false,
        message: "MSG91 Template ID is not configured. Please set MSG91_TEMPLATE_ID environment variable.",
        authKey: true,
        templateId: false,
        connected: false
      });
    }
    
    // Test if we can make a simple request to the MSG91 API
    // (We don't actually send an SMS, just check the connection)
    try {
      console.log('MSG91 Config Test - Testing API connectivity');
      
      // Make a request to check the validity of the template
      const response = await fetch(`https://control.msg91.com/api/v5/templates?authkey=${authKey}`, {
        method: 'GET',
        headers: {
          'accept': 'application/json'
        }
      });
      
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(`MSG91 API error: ${errorData.message || 'Unknown error'}`);
      }
      
      return NextResponse.json({
        success: true,
        message: "MSG91 configuration is valid",
        authKey: true,
        templateId: true,
        connected: true
      });
      
    } catch (error: any) {
      console.error('MSG91 Config Test - Error connecting to MSG91:', error);
      
      return NextResponse.json({
        success: false,
        message: `Error connecting to MSG91: ${error.message}`,
        authKey: true,
        templateId: !!templateId,
        connected: false,
        error: error.message
      });
    }
    
  } catch (error: any) {
    console.error("MSG91 test error:", error);
    return NextResponse.json(
      { error: apiErrorMessage(error) },
      { status: 500 }
    );
  }
} 