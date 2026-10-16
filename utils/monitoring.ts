import { createClient } from "@/utils/supabase/server";
import * as https from "https";
import * as http from "http";
import * as tls from "tls";
import * as net from "net";
import * as dns from "dns";
import { promisify } from "util";

const UPTIME_TIMEOUT_MS = 15000;
const MAX_REDIRECTS = 5;
const UPTIME_USER_AGENT =
  "Mozilla/5.0 (compatible; UptimeMonitor/1.0; +https://github.com/wbt-web-support/uptime)";

// Send a single request and report the status line. Redirects are not followed here.
//
// TLS verification is deliberately disabled. Uptime answers "does the server respond
// to visitors", and browsers still load sites whose certificate is expired or missing
// an intermediate. Certificate health is measured separately by checkSSLExpiry and
// shown in its own column, so nothing is lost by ignoring it here.
function probeOnce(
  targetUrl: string,
  method: "HEAD" | "GET"
): Promise<{ status: number; location: string | null }> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(targetUrl);
    } catch {
      reject(new Error(`Invalid URL: ${targetUrl}`));
      return;
    }

    const isHttp = parsed.protocol === "http:";
    const transport = isHttp ? http : https;

    const req = transport.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (isHttp ? 80 : 443),
        path: `${parsed.pathname}${parsed.search}`,
        method,
        rejectUnauthorized: false,
        headers: {
          "User-Agent": UPTIME_USER_AGENT,
          Accept: "*/*",
        },
      },
      (res) => {
        const status = res.statusCode || 0;
        const location = Array.isArray(res.headers.location)
          ? res.headers.location[0]
          : res.headers.location || null;

        // Drain the body so the socket is released instead of hanging on GET fallbacks
        res.resume();
        resolve({ status, location });
      }
    );

    req.setTimeout(UPTIME_TIMEOUT_MS, () => {
      req.destroy(new Error(`Request timed out after ${UPTIME_TIMEOUT_MS}ms`));
    });

    req.once("error", reject);
    req.end();
  });
}

// Follow redirects to the final response, falling back to GET for servers that reject HEAD
async function probe(startUrl: string): Promise<number> {
  let currentUrl = startUrl;
  let method: "HEAD" | "GET" = "HEAD";
  let headRejected = false;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const { status, location } = await probeOnce(currentUrl, method);

    // Some servers refuse HEAD but serve the page fine. Retry once with GET before judging.
    if (method === "HEAD" && !headRejected && (status === 405 || status === 501)) {
      headRejected = true;
      method = "GET";
      continue;
    }

    if (status >= 300 && status < 400 && location) {
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }

    return status;
  }

  throw new Error(`Too many redirects (more than ${MAX_REDIRECTS})`);
}

// Turn low level socket errors into something readable in the dashboard
function describeError(error: any): string {
  const code = error?.code || error?.cause?.code;

  switch (code) {
    case "ENOTFOUND":
      return "DNS lookup failed (domain does not resolve)";
    case "EAI_AGAIN":
      return "DNS lookup timed out";
    case "ECONNREFUSED":
      return "Connection refused";
    case "ECONNRESET":
      return "Connection reset by server";
    case "ETIMEDOUT":
      return "Connection timed out";
    case "EHOSTUNREACH":
      return "Host unreachable";
    case "ENETUNREACH":
      return "Network unreachable";
    case "EPROTO":
      return "TLS handshake failed";
    default:
      return error?.message || "Unknown error";
  }
}

// Function to check if a domain is up and save the result to Supabase
export async function checkDomainUptime(domainId: string, url: string) {
  const supabase = await createClient();
  const startTime = Date.now();

  try {
    const status = await probe(url);
    const responseTime = Date.now() - startTime;

    // A status code below 400 usually indicates the site is up
    const isUp = status < 400;

    // Save the result to Supabase
    await supabase.from("uptime_logs").insert({
      domain_id: domainId,
      status: isUp,
      response_time: responseTime,
      error_message: isUp ? null : `Status code: ${status}`,
    });

    console.log(`Uptime check for ${url}: ${isUp ? "UP" : "DOWN"} (${status})`);
    return isUp;

  } catch (error: any) {
    const message = describeError(error);
    console.error(`Error checking uptime for ${url}:`, message);

    // Save the error to Supabase
    await supabase.from("uptime_logs").insert({
      domain_id: domainId,
      status: false,
      response_time: null,
      error_message: message,
    });

    return false;
  }
}

// Function to check SSL certificate expiry
export async function checkSSLExpiry(domainId: string, domain: string) {
  const supabase = await createClient();
  
  try {
    // First try using Node.js TLS to check the SSL certificate
    const sslInfo = await checkSSLWithNodeTLS(domain);
    
    // Calculate days remaining
    const expiryDate = sslInfo.validTo;
    const daysRemaining = calculateDaysRemaining(expiryDate);
    
    // Save the result to Supabase
    await supabase.from("ssl_info").insert({
      domain_id: domainId,
      expiry_date: expiryDate.toISOString(),
      days_remaining: daysRemaining,
      issuer: sslInfo.issuer,
    });
    
    console.log(`SSL check for ${domain}: Expires in ${daysRemaining} days`);
    return { expiryDate, daysRemaining, issuer: sslInfo.issuer };
    
  } catch (error) {
    console.error(`Error checking SSL with Node TLS for ${domain}:`, error);
    
    try {
      // Fallback to using the SSL checker API
      const apiResult = await checkSSLWithAPI(domain);
      
      // Save the result to Supabase
      await supabase.from("ssl_info").insert({
        domain_id: domainId,
        expiry_date: apiResult.expiryDate.toISOString(),
        days_remaining: apiResult.daysRemaining,
        issuer: apiResult.issuer,
      });
      
      console.log(`SSL API check for ${domain}: Expires in ${apiResult.daysRemaining} days`);
      return apiResult;
      
    } catch (fallbackError) {
      console.error(`Error checking SSL with API for ${domain}:`, fallbackError);
      throw fallbackError;
    }
  }
}

// Helper function to extract the main domain from a subdomain
function extractMainDomain(domain: string): string {
  // Remove protocol if present
  let cleanDomain = domain.replace(/^(https?:\/\/)?(www\.)?/i, "");
  
  // Extract domain without path or query parameters
  cleanDomain = cleanDomain.split("/")[0].split("?")[0].split("#")[0];
  
  // Check if it's an IP address
  const ipPattern = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
  if (ipPattern.test(cleanDomain)) {
    return cleanDomain; // Return as is if it's an IP address
  }
  
  // Split by dots and get the main domain (usually last two parts)
  const parts = cleanDomain.split(".");
  
  // If domain has only two parts (e.g., example.com), return as is
  if (parts.length <= 2) {
    return cleanDomain;
  }
  
  // Handle special TLDs like .co.uk, .com.au, etc.
  const specialTLDs = [
    "co.uk", "org.uk", "me.uk", "com.au", "net.au", "org.au", 
    "co.nz", "net.nz", "org.nz", "co.za", "com.br", "com.mx"
  ];
  
  // Check if we have a special TLD
  const lastTwoParts = parts.slice(-2).join(".");
  if (specialTLDs.includes(lastTwoParts)) {
    // Return last three parts for special TLDs (e.g., example.co.uk)
    return parts.slice(-3).join(".");
  }
  
  // Return main domain (last two parts)
  return parts.slice(-2).join(".");
}

// Function to check domain expiry using Whois API
export async function checkDomainExpiry(domainId: string, domain: string) {
  const supabase = await createClient();
  
  try {
    // Extract the main domain for WHOIS lookup
    const mainDomain = extractMainDomain(domain);
    console.log(`Extracted main domain ${mainDomain} from ${domain} for WHOIS lookup`);
    
    // Use the API Layer Whois API - try both environment variables
    const apiKey = process.env.API_LAYER_KEY || process.env.NEXT_PUBLIC_API_LAYER_KEY;
    if (!apiKey) {
      throw new Error("API_LAYER_KEY environment variable is not set");
    }
    
    console.log(`Checking domain expiry for ${mainDomain} with API key: ${apiKey.substring(0, 3)}...`);
    
    const response = await fetch(`https://api.apilayer.com/whois/query?domain=${mainDomain}`, {
      method: 'GET',
      headers: {
        'apikey': apiKey,
      },
      cache: 'no-store'
    });
    
    if (!response.ok) {
      console.error(`WHOIS API Error: Status ${response.status}`);
      const responseText = await response.text();
      console.error(`Response body: ${responseText}`);

      // 429 means the plan's quota is gone, so every remaining domain in this run
      // would fail too. Mark it so the caller can stop instead of burning through
      // another 180 requests that cannot succeed.
      const error: any = new Error(
        `API request failed with status ${response.status}: ${responseText}`,
      );
      if (response.status === 429) error.code = "WHOIS_QUOTA_EXCEEDED";
      throw error;
    }
    
    const data = await response.json();
    console.log(`WHOIS Response for ${mainDomain}:`, JSON.stringify(data).substring(0, 300) + "...");
    
    // Extract domain expiry date from the response
    let expiryDateStr = null;
    
    if (data.result && typeof data.result === 'object' && data.result.expiration_date) {
      // If response has structured data
      expiryDateStr = data.result.expiration_date;
    } else if (data.expiration_date) {
      // Direct expiration_date field
      expiryDateStr = data.expiration_date;
    } else if (data.result && typeof data.result === 'string') {
      // Try to extract expiry date from the raw WHOIS response
      const matches = data.result.match(/expir(?:y|ation)[\s_-]*date:?\s*([^\n\r]+)/i);
      expiryDateStr = matches ? matches[1].trim() : null;
    }
    
    if (!expiryDateStr) {
      console.error("Full WHOIS response:", data);
      throw new Error("Could not extract expiry date from WHOIS response");
    }
    
    // Parse the date
    const expiryDate = new Date(expiryDateStr);
    if (isNaN(expiryDate.getTime())) {
      throw new Error(`Invalid date format in WHOIS response: ${expiryDateStr}`);
    }
    
    const daysRemaining = calculateDaysRemaining(expiryDate);
    
    // Extract registrar information if available
    let registrar = "Unknown";
    if (data.result && typeof data.result === 'object' && data.result.registrar) {
      registrar = data.result.registrar;
    } else if (data.registrar) {
      registrar = data.registrar;
    }
    
    // Save the result to Supabase
    await supabase.from("domain_expiry").insert({
      domain_id: domainId,
      expiry_date: expiryDate.toISOString(),
      days_remaining: daysRemaining,
      registrar: registrar,
    });
    
    console.log(`Domain expiry check for ${mainDomain}: Expires in ${daysRemaining} days (${expiryDate.toISOString()})`);
    return { expiryDate, daysRemaining, registrar };
    
  } catch (error: any) {
    console.error(`Error checking domain expiry for ${domain}:`, error.message);
    throw error;
  }
}

// Function to check domain IP records
export async function checkDomainIpRecords(domainId: string, domain: string) {
  const supabase = await createClient();
  
  try {
    // Use Node.js DNS to resolve the domain
    const resolve4 = promisify(dns.resolve4);
    
    // Get IPv4 addresses
    const ipv4Addresses = await resolve4(domain);
    
    // Get primary IP (first in the list)
    const primaryIp = ipv4Addresses.length > 0 ? ipv4Addresses[0] : null;
    
    // Try to get MX records (mail servers)
    let mxRecords: dns.MxRecord[] = [];
    try {
      const resolveMx = promisify(dns.resolveMx);
      mxRecords = await resolveMx(domain);
    } catch (mxError) {
      console.log(`No MX records found for ${domain}`);
    }
    
    // Try to get nameservers
    let nameservers: string[] = [];
    try {
      const resolveNs = promisify(dns.resolveNs);
      nameservers = await resolveNs(domain);
    } catch (nsError) {
      console.log(`No NS records found for ${domain}`);
    }
    
    // Check for IP address changes from previous records
    let ipChanged = false;
    let previousIp: string | null = null;
    
    // Get the most recent IP record for this domain
    const { data: previousRecord } = await supabase
      .from("ip_records")
      .select("primary_ip")
      .eq("domain_id", domainId)
      .order("checked_at", { ascending: false })
      .limit(1)
      .single();
    
    if (previousRecord && previousRecord.primary_ip !== primaryIp && previousRecord.primary_ip && primaryIp) {
      ipChanged = true;
      previousIp = previousRecord.primary_ip;
      console.log(`IP change detected for ${domain}: ${previousIp} -> ${primaryIp}`);
    }
    
    // Determine tag based on IP
    let tag: string | null = null;
    if (primaryIp) {
      const ipMappings: Record<string, string> = {
        "91.204.209.205": "uranium Direct Admin",
        "91.204.209.204": "iridium Direct Admin",
        "109.70.148.64": "cPanel draftforclients.com",
        "91.204.209.29": "cPanel webuildtrades.com",
        "91.204.209.39": "cPanel webuildtrades.io",
        "35.214.4.69": "SiteGround",
        "165.22.127.156": "Cloudways",
        "64.227.39.249": "Digitalocean"
      };
      
      tag = ipMappings[primaryIp] || null;
      
      // Update domain with tag if found
      if (tag) {
        await supabase
          .from("domains")
          .update({ tag })
          .eq("id", domainId);
      }
    }
    
    // Save the IP records to the database
    await supabase.from("ip_records").insert({
      domain_id: domainId,
      primary_ip: primaryIp,
      all_ips: JSON.stringify(ipv4Addresses),
      mx_records: JSON.stringify(mxRecords),
      nameservers: JSON.stringify(nameservers),
    });
    
    return {
      primaryIp,
      allIps: ipv4Addresses,
      mxRecords,
      nameservers,
      tag,
      ipChanged,
      previousIp
    };
    
  } catch (error: any) {
    console.error(`Error checking IP records for ${domain}:`, error.message);
    throw error;
  }
}

// Private helper function to check SSL with Node.js TLS
async function checkSSLWithNodeTLS(domain: string): Promise<{
  validTo: Date;
  issuer: string;
}> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({
      host: domain,
      port: 443,
    });
    
    socket.once('error', (err) => {
      socket.destroy();
      reject(err);
    });
    
    socket.once('connect', () => {
      const tlsSocket = tls.connect({
        socket,
        servername: domain,
        rejectUnauthorized: false, // We want to check even invalid/expired certs
      });
      
      tlsSocket.once('error', (err) => {
        tlsSocket.destroy();
        reject(err);
      });
      
      tlsSocket.once('secureConnect', () => {
        const cert = tlsSocket.getPeerCertificate();
        
        if (!cert.valid_to) {
          tlsSocket.destroy();
          reject(new Error("Could not get certificate expiry date"));
          return;
        }
        
        // Node TLS returns the date in a format like: "May 30 00:00:00 2023 GMT"
        const validTo = new Date(cert.valid_to);
        const issuer = cert.issuer?.O || "Unknown";
        
        tlsSocket.destroy();
        resolve({ validTo, issuer });
      });
    });
    
    // Set a timeout in case the connection hangs
    socket.setTimeout(10000, () => {
      socket.destroy();
      reject(new Error("Connection timeout"));
    });
  });
}

// Private helper function to check SSL with API
async function checkSSLWithAPI(domain: string): Promise<{
  expiryDate: Date;
  daysRemaining: number;
  issuer: string;
}> {
  const response = await fetch(`https://api.ssl-checker.io/ssl?host=${domain}`);
  
  if (!response.ok) {
    throw new Error(`API request failed with status ${response.status}`);
  }
  
  const data = await response.json();
  
  if (!data.valid || !data.expiry) {
    throw new Error("Invalid SSL certificate or missing expiry data");
  }
  
  const expiryDate = new Date(data.expiry);
  const daysRemaining = calculateDaysRemaining(expiryDate);
  const issuer = data.issuer || "Unknown";
  
  return { expiryDate, daysRemaining, issuer };
}

// Helper function to calculate days remaining until a date
function calculateDaysRemaining(targetDate: Date): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0); // Set to beginning of day
  
  const diffTime = targetDate.getTime() - today.getTime();
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  
  return diffDays;
} 