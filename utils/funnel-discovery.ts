import type { SupabaseClient } from "@supabase/supabase-js";

// Finds each client site's quote funnels (boiler, ASHP, air con, solar, battery...)
// so every one can be tested, not just whichever the walker happens to pick from the
// homepage. Looks at the homepage, then one level into its service pages, since
// some homepages only link to e.g. /boilers/ and the funnel is linked from there.

// Last path segment of a funnel page, e.g. /boiler-quote/, /solar/solar-quote/, /e-survey
const FUNNEL_SLUG = /^(?:[a-z-]*-)?(?:quote|quotes|survey|e-survey|instant-price|get-a-price|estimate)$|^(?:quick|instant|get-a|free|online|instant-video|video)-quotes?$|^(?:[a-z]+-)?e-survey$|^(?:[a-z]+-)?book-survey$/;
// Pages that mention quotes but aren't the form itself
const NOT_A_FUNNEL = /success|thank|review|testimonial|blog|news|category|tag|author|privacy|terms|cookie|wp-|feed/;
// Service pages worth opening to look for their own quote link
const SERVICE_SLUG = /boiler|heat-?pump|ashp|air-?con|cooling|solar|battery|batteries|ev-?charg|plumbing|bathroom|heating|renewable|insulation|damp|roofing|windows|kitchens/;

const SERVICE_NAMES: [RegExp, string][] = [
  [/boiler-repair/, "Boiler Repair"],
  [/boiler-service/, "Boiler Service"],
  [/boiler-cover/, "Boiler Cover"],
  [/boiler/, "Boiler"],
  [/ashp|heat-?pump/, "Air Source Heat Pump"],
  [/(^|[-/])ac-|air-?con|cooling/, "Air Conditioning"],
  [/battery|batteries/, "Battery Storage"],
  [/solar/, "Solar"],
  [/ev-?charg/, "EV Charger"],
  [/bathroom/, "Bathroom"],
  [/plumbing/, "Plumbing"],
  [/damp/, "Damp"],
  [/insulation/, "Insulation"],
  [/roof/, "Roofing"],
  [/survey/, "Survey"],
  [/video/, "Video Quote"],
];

export function serviceName(path: string): string {
  const p = path.toLowerCase();
  for (const [pattern, name] of SERVICE_NAMES) if (pattern.test(p)) return name;
  return "Quote";
}

function lastSegment(pathname: string) {
  return pathname.toLowerCase().replace(/\/+$/, "").split("/").pop() ?? "";
}

export function isFunnelPath(pathname: string): boolean {
  const p = pathname.toLowerCase();
  const segments = p.replace(/\/+$/, "").split("/").filter(Boolean);
  // Funnels sit near the root; long nested paths are articles about quotes
  if (segments.length === 0 || segments.length > 2) return false;
  if (NOT_A_FUNNEL.test(p)) return false;
  const slug = lastSegment(p);
  return slug.length <= 30 && FUNNEL_SLUG.test(slug);
}

async function fetchPage(url: string): Promise<{ url: string; html: string } | null> {
  try {
    const res = await fetch(url, {
      // A bot-looking user agent gets blocked by some hosts' firewalls
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36" },
      signal: AbortSignal.timeout(20000),
      redirect: "follow",
    });
    if (!res.ok || !(res.headers.get("content-type") || "").includes("html")) return null;
    return { url: res.url, html: await res.text() };
  } catch {
    return null;
  }
}

function sameSiteLinks(pageUrl: string, html: string): URL[] {
  const host = new URL(pageUrl).hostname.replace(/^www\./, "");
  const out: URL[] = [];
  for (const m of Array.from(html.matchAll(/<a\b[^>]*href="([^"#]+)"/gi))) {
    try {
      const u = new URL(m[1].replace(/&amp;/g, "&"), pageUrl);
      if ((u.protocol === "https:" || u.protocol === "http:") && u.hostname.replace(/^www\./, "") === host) out.push(u);
    } catch {
      // ignore malformed hrefs
    }
  }
  return out;
}

// Canonical form so /boiler-quote and /boiler-quote/ count as one funnel
export function normalizeFunnelUrl(url: string): string {
  const u = new URL(url);
  const path = u.pathname.replace(/\/+$/, "") || "/";
  return `${u.protocol}//${u.hostname.replace(/^www\./, "")}${path === "/" ? "/" : `${path}/`}`.toLowerCase();
}

// Marks a funnel that is really a "chooser" page: no form of its own, just cards
// linking to each service's quote form (e.g. /quote/ -> New Boilers, Boiler Repairs,
// ASHP). It stays listed, but isn't tested by itself - its services are.
export const CHOOSER_SUFFIX = " (chooser page)";
export const isChooserFunnel = (f: { name: string }) => f.name.endsWith(CHOOSER_SUFFIX);

// Any input a visitor fills in (not hidden/search/button ones), select or textarea
function hasFormFields(html: string): boolean {
  return /<input\b(?![^>]*type=["']?(hidden|search|submit|button)\b)[^>]*>|<select\b|<textarea\b/i.test(html);
}

export interface SiteFunnels {
  funnels: string[];
  choosers: string[];
}

export async function discoverSiteFunnels(siteUrl: string, maxServicePages = 8): Promise<SiteFunnels> {
  const found = await discoverFunnelUrls(siteUrl, maxServicePages);
  if (found.length === 0) return { funnels: [], choosers: [] };

  // Open each quote page once: a page linking to 2+ other quote pages is a chooser.
  // Its cards may lead to forms the homepage never linked, so add those too.
  const all = new Map(found.map(u => [normalizeFunnelUrl(u), u]));
  const choosers = new Set<string>();
  const pages = await Promise.all(found.map(fetchPage));
  pages.forEach((page, i) => {
    if (!page) return;
    const targets = new Map<string, string>();
    for (const u of sameSiteLinks(page.url, page.html)) {
      const clean = `${u.origin}${u.pathname}`;
      const key = normalizeFunnelUrl(clean);
      if (isFunnelPath(u.pathname) && key !== normalizeFunnelUrl(found[i])) targets.set(key, clean);
    }
    // A real form page can also link to other quote pages (menus, footers), so it
    // only counts as a chooser when it has no form fields of its own
    if (targets.size >= 2 && !hasFormFields(page.html)) {
      choosers.add(normalizeFunnelUrl(found[i]));
      targets.forEach((url, key) => {
        if (!all.has(key)) all.set(key, url);
      });
    }
  });

  return {
    funnels: Array.from(all.entries()).filter(([key]) => !choosers.has(key)).map(([, url]) => url),
    choosers: Array.from(all.entries()).filter(([key]) => choosers.has(key)).map(([, url]) => url),
  };
}

async function discoverFunnelUrls(siteUrl: string, maxServicePages: number): Promise<string[]> {
  const home = await fetchPage(siteUrl);
  if (!home) return [];

  const found = new Map<string, string>(); // normalized -> url as linked
  const servicePages = new Set<string>();

  const collect = (pageUrl: string, html: string, lookForServices: boolean) => {
    for (const u of sameSiteLinks(pageUrl, html)) {
      const clean = `${u.origin}${u.pathname}`;
      if (isFunnelPath(u.pathname)) {
        found.set(normalizeFunnelUrl(clean), clean);
      } else if (lookForServices) {
        const segments = u.pathname.toLowerCase().split("/").filter(Boolean);
        if (segments.length === 1 && SERVICE_SLUG.test(segments[0]) && !NOT_A_FUNNEL.test(segments[0])) {
          servicePages.add(clean);
        }
      }
    }
  };

  collect(home.url, home.html, true);

  const pages = Array.from(servicePages).slice(0, maxServicePages);
  const results = await Promise.all(pages.map(fetchPage));
  results.forEach(page => page && collect(page.url, page.html, false));

  return Array.from(found.values());
}

// Discover funnels for the given domains and add the ones not already listed.
// Chooser pages are kept (marked with CHOOSER_SUFFIX) but their services are what
// gets tested. Returns what was added and which existing funnels were marked.
export async function discoverAndAddFunnels(
  supabase: SupabaseClient,
  domains: { id: string; domain_name: string; display_name: string | null; uptime_url: string }[],
  concurrency = 8
) {
  const { data: existing, error } = await supabase.from("funnels").select("id, name, url");
  if (error) throw error;
  const byUrl = new Map<string, { id: string; name: string }>();
  for (const f of existing || []) {
    try {
      byUrl.set(normalizeFunnelUrl(f.url), { id: f.id, name: f.name });
    } catch {
      // skip a malformed stored URL
    }
  }

  const added: { client: string; name: string; url: string }[] = [];
  const markedChoosers: string[] = [];
  const unmarkedChoosers: string[] = [];
  let checked = 0;
  let next = 0;

  const worker = async () => {
    while (next < domains.length) {
      const domain = domains[next++];
      const client = domain.display_name || domain.domain_name;
      let site: SiteFunnels = { funnels: [], choosers: [] };
      try {
        site = await discoverSiteFunnels(domain.uptime_url);
      } catch {
        // one unreachable site shouldn't stop the rest
      }
      checked++;

      // A page marked as a chooser earlier that is really a form: unmark it
      for (const url of site.funnels) {
        const listed = byUrl.get(normalizeFunnelUrl(url));
        if (listed?.id && isChooserFunnel(listed)) {
          const name = listed.name.slice(0, -CHOOSER_SUFFIX.length);
          const { error: updateError } = await supabase.from("funnels").update({ name }).eq("id", listed.id);
          if (updateError) throw updateError;
          listed.name = name;
          unmarkedChoosers.push(name);
        }
      }

      // Already-listed pages that turned out to be choosers: mark them
      for (const url of site.choosers) {
        const listed = byUrl.get(normalizeFunnelUrl(url));
        if (listed && !isChooserFunnel(listed)) {
          const name = `${listed.name}${CHOOSER_SUFFIX}`;
          const { error: updateError } = await supabase.from("funnels").update({ name }).eq("id", listed.id);
          if (updateError) throw updateError;
          listed.name = name;
          markedChoosers.push(name);
        }
      }

      const candidates = [
        ...site.funnels.map(url => ({ url, chooser: false })),
        ...site.choosers.map(url => ({ url, chooser: true })),
      ];
      const rows = candidates
        .filter(c => !byUrl.has(normalizeFunnelUrl(c.url)))
        .map(c => {
          const row = {
            name: `${client} - ${serviceName(new URL(c.url).pathname)}`,
            url: c.url,
            domain_id: domain.id,
            chooser: c.chooser,
          };
          byUrl.set(normalizeFunnelUrl(c.url), { id: "", name: row.name });
          return row;
        });
      // Same client, two funnels with the same service name: tell them apart by path
      const names = new Map<string, number>();
      rows.forEach(r => names.set(r.name, (names.get(r.name) || 0) + 1));
      rows.forEach(r => {
        if ((names.get(r.name) || 0) > 1) r.name = `${r.name} (${new URL(r.url).pathname.replace(/\/+$/, "")})`;
        if (r.chooser) r.name += CHOOSER_SUFFIX;
      });

      if (rows.length) {
        const { error: insertError } = await supabase
          .from("funnels")
          .insert(rows.map(({ chooser, ...row }) => row));
        if (insertError) throw insertError;
        rows.forEach(r => added.push({ client, name: r.name, url: r.url }));
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, domains.length) }, worker));
  return { checked, added, markedChoosers, unmarkedChoosers };
}
