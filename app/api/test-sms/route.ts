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
    
    // Get phone number from request body
    const { phoneNumber } = await request.json();
    
    if (!phoneNumber) {
      return NextResponse.json({ 
        error: "Phone number is required"
      }, { status: 400 });
    }
    
    // Validate phone number format
    const phoneRegex = /^\+[1-9]\d{1,14}$/;
    if (!phoneRegex.test(phoneNumber)) {
      return NextResponse.json({ 
        error: "Invalid phone number format. Must be in international format (e.g., +1234567890)"
      }, { status: 400 });
    }
    
    // Check MSG91 configuration
    const authKey = process.env.MSG91_AUTH_KEY;
    const templateId = process.env.MSG91_TEMPLATE_ID;
    
    if (!authKey || !templateId) {
      return NextResponse.json({
        error: "MSG91 configuration is incomplete. Please check your environment variables (MSG91_AUTH_KEY and MSG91_TEMPLATE_ID)."
      }, { status: 500 });
    }
    
    try {
      // Prepare the recipient with all required variables for the template
      const recipient = {
        mobiles: phoneNumber.replace(/^\+/, ''), // Remove leading '+' as MSG91 doesn't need it
        "##ALERT_TYPE##": "Test Alert",
        "##ALERT_SUBJECT##": "Test Message",
        "##MESSAGE##": "This is a test message from your Uptime Monitor application.",
        "##DOMAIN_NAME##": "Test Domain",
        "##DOMAIN_URL##": "example.com",
        "##DAYS_REMAINING##": "",
        "##DATE_TIME##": new Date().toLocaleString()
      };
      
      // Prepare the request body according to MSG91 Flow API format
      const requestBody = {
        template_id: templateId,
        short_url: "0", // Default to not using short URLs
        recipients: [recipient]
      };
      
      console.log(`SMS Test - Sending test SMS to ${phoneNumber}`);
      console.log(`SMS Test - Request body: ${JSON.stringify(requestBody)}`);
      
      // Make direct API call to MSG91
      const response = await fetch('https://control.msg91.com/api/v5/flow', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'accept': 'application/json',
          'authkey': authKey
        },
        body: JSON.stringify(requestBody)
      });
      
      const responseData = await response.json();
      
      if (!response.ok) {
        console.error(`SMS Test - Error response: ${JSON.stringify(responseData)}`);
        let errorMessage = responseData.message || JSON.stringify(responseData);
        
        // Add helpful message about template if error appears to be template-related
        if (errorMessage.toLowerCase().includes('template') || responseData.type === 'template_error') {
          errorMessage += `. Make sure your MSG91 template uses variables like ##ALERT_TYPE##, ##MESSAGE##, etc.`;
        }
        
        return NextResponse.json({
          error: `Failed to send SMS: ${errorMessage}`,
          errorDetails: responseData
        }, { status: 500 });
      }
      
      console.log(`SMS Test - Successfully sent! Response:`, responseData);
      
      return NextResponse.json({
        success: true,
        message: "Test SMS sent successfully",
        response: responseData,
        config: {
          templateId,
          helpInfo: "Your template should use variables like ##ALERT_TYPE##, ##ALERT_SUBJECT##, ##MESSAGE##, etc. for the alert details."
        }
      });
      
    } catch (error: any) {
      console.error('SMS Test - Failed to send SMS:', error);
      
      return NextResponse.json({
        error: `Failed to send SMS: ${error.message}`,
        errorCode: error.code,
        errorStatus: error.status
      }, { status: 500 });
    }
    
  } catch (error: any) {
    console.error("SMS test error:", error);
    return NextResponse.json(
      { error: apiErrorMessage(error) },
      { status: 500 }
    );
  }
} 