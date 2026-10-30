import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";

// Generate a status badge SVG for the given domain
export async function GET(
  request: NextRequest,
  // Next.js passes route params as a Promise
  { params }: { params: Promise<{ domain: string }> }
) {
  try {
    const { domain } = await params;
    if (!domain) {
      return new NextResponse("Domain parameter is required", { status: 400 });
    }

    const supabase = await createClient();

    // Find the domain in the database
    const { data: domainData, error: domainError } = await supabase
      .from("domains")
      .select("*")
      .eq("domain_name", domain)
      .single();

    if (domainError || !domainData) {
      return new Response(generateBadgeSVG("unknown", "Domain not found", "#9CA3AF"), {
        headers: {
          "Content-Type": "image/svg+xml",
          "Cache-Control": "max-age=60", // Cache for 1 minute
        },
      });
    }

    // Get the latest uptime status
    const { data: uptimeData, error: uptimeError } = await supabase
      .from("uptime_logs")
      .select("*")
      .eq("domain_id", domainData.id)
      .order("checked_at", { ascending: false })
      .limit(1)
      .single();

    // Generate the badge based on the status
    let status = "unknown";
    let color = "#9CA3AF"; // Gray for unknown
    let label = domainData.display_name || domainData.domain_name;

    if (!uptimeError && uptimeData) {
      status = uptimeData.status ? "up" : "down";
      color = uptimeData.status ? "#22C55E" : "#EF4444"; // Green for up, red for down
    }

    // Return the SVG image
    return new Response(generateBadgeSVG(status, label, color), {
      headers: {
        "Content-Type": "image/svg+xml",
        "Cache-Control": "max-age=60", // Cache for 1 minute
      },
    });
  } catch (error) {
    console.error("Error generating badge:", error);
    return new Response(generateBadgeSVG("error", "Error", "#9CA3AF"), {
      headers: {
        "Content-Type": "image/svg+xml",
        "Cache-Control": "max-age=60",
      },
    });
  }
}

// Helper function to generate the SVG badge
function generateBadgeSVG(status: string, label: string, color: string): string {
  // Escape special characters in label for SVG
  label = label.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  
  // Calculate the width based on the label length
  const labelWidth = label.length * 7; // Approximate width per character
  const statusWidth = 40; // Fixed width for status
  const totalWidth = labelWidth + statusWidth;

  return `
<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="20" role="img" aria-label="${label} status: ${status}">
  <title>${label} status: ${status}</title>
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r">
    <rect width="${totalWidth}" height="20" rx="3" fill="#fff"/>
  </clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelWidth}" height="20" fill="#555"/>
    <rect x="${labelWidth}" width="${statusWidth}" height="20" fill="${color}"/>
    <rect width="${totalWidth}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="11">
    <text x="${labelWidth / 2}" y="15" fill="#010101" fill-opacity=".3">${label}</text>
    <text x="${labelWidth / 2}" y="14">${label}</text>
    <text x="${labelWidth + statusWidth / 2}" y="15" fill="#010101" fill-opacity=".3">${status}</text>
    <text x="${labelWidth + statusWidth / 2}" y="14">${status}</text>
  </g>
</svg>`.trim();
} 