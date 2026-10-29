import { NextRequest, NextResponse } from "next/server";
import { apiErrorMessage } from "@/utils/api-error";

export async function GET(request: NextRequest) {
  try {
    // Get domain from URL query parameter
    const searchParams = request.nextUrl.searchParams;
    const domain = searchParams.get('domain');

    if (!domain) {
      return NextResponse.json({ error: "Domain parameter is required" }, { status: 400 });
    }

    // Use the API Layer Whois API - try both environment variables
    const apiKey = process.env.API_LAYER_KEY || process.env.NEXT_PUBLIC_API_LAYER_KEY;
    if (!apiKey) {
      return NextResponse.json({ 
        error: "API_LAYER_KEY environment variable is not set",
        env_vars: Object.keys(process.env).filter(key => key.includes('API') || key.includes('KEY')).map(key => `${key}: ${process.env[key] ? 'set' : 'not set'}`)
      }, { status: 500 });
    }
    
    console.log(`Testing WHOIS API for ${domain} with API key: ${apiKey.substring(0, 3)}...`);
    
    const response = await fetch(`https://api.apilayer.com/whois/query?domain=${domain}`, {
      method: 'GET',
      headers: {
        'apikey': apiKey,
      },
      cache: 'no-store'
    });
    
    if (!response.ok) {
      const responseText = await response.text();
      return NextResponse.json({ 
        error: `API request failed with status ${response.status}`, 
        details: responseText 
      }, { status: response.status });
    }
    
    const data = await response.json();
    
    return NextResponse.json({
      message: "WHOIS API test successful",
      data: data,
      api_key_prefix: apiKey.substring(0, 3) + "...",
    });
    
  } catch (error: any) {
    console.error("WHOIS API test error:", error);
    return NextResponse.json(
      { error: apiErrorMessage(error) },
      { status: 500 }
    );
  }
} 