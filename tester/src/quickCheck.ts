// Daily "no-submit" check of one quote funnel: opens its page the way a visitor
// would and checks what can be checked WITHOUT filling in or sending anything -
// the page loads, the quote form shows, Google Tag Manager is there, the site's
// own postcode lookup answers, the checkout's Stripe key is live (not a test key)
// and phone links work. Takes ~30 seconds; never creates a lead or a payment.

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

export type QuickCheckStatus = "ok" | "problem" | "skipped";

export interface QuickCheckItem {
  key: "page" | "form" | "gtm" | "postcode" | "stripe" | "phone_links";
  label: string;
  status: QuickCheckStatus;
  detail: string;
}

export interface QuickCheckResult {
  url: string;
  checked_at: string;
  ok: boolean;
  checks: QuickCheckItem[];
}

const HEADLESS = process.env.WBT_HEADLESS !== "false";
const POSTCODE = "SW1A 1AA";

// Payment pages and payment requests are refused outright - this check never pays
const PAYMENT_HOST =
  /(^|\.)(buy\.stripe\.com|checkout\.stripe\.com|billing\.stripe\.com|api\.stripe\.com|paypal\.com|paypal\.me|gocardless\.com|square\.link|squareup\.com|checkout\.square\.site|sumup\.com|klarna\.com|clearpay\.co\.uk|afterpay\.com)$/i;
const PAYMENT_PATH = /\/(create-?stripe|stripe-?checkout|create-?payment|payment-?intents?|process-?payment|charge|pay-?now)\b/i;

const NOT_FOUND_TEXT = /page not found|nothing (was )?found|404 error|error 404|this page (doesn'?t|does not) exist/i;

// The quote form is on screen: answer cards, buttons, fields - counted the way a
// visitor sees them (visible, not the header/footer)
const VISIBLE_CONTROLS_SCRIPT = `(() => {
  var els = document.querySelectorAll('input:not([type="hidden"]), select, textarea, button, [onclick], [role="button"], label');
  var n = 0;
  els.forEach(function (el) {
    if (el.closest('header, footer, nav')) return;
    var r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) n++;
  });
  return n;
})()`;

const GTM_SCRIPT = `(() => {
  var w = window;
  var scripts = Array.from(document.scripts).map(function (s) { return s.src || ''; });
  return (Array.isArray(w.dataLayer) && w.dataLayer.length > 0) || typeof w.google_tag_manager === 'object' ||
    scripts.some(function (s) { return s.indexOf('googletagmanager.com/gtm.js') !== -1; });
})()`;

// Phone links written wrongly ("tell:", "tel:" with letters in it) - tapping them does nothing
const BAD_PHONE_LINKS_SCRIPT = `(() => {
  return Array.from(document.querySelectorAll('a[href]')).map(function (a) { return a.getAttribute('href') || ''; })
    .filter(function (h) { return /^\\s*tell?:/i.test(h) && !/^\\s*tel:\\s*\\+?[\\d\\s()\\-]{6,}$/i.test(h); })
    .slice(0, 5);
})()`;

// The WBT postcode lookup (window.POSTCODE_PROXY = { url, nonce }): ask it for one
// postcode, as the page's own Find button would. Read-only - no lead, no form.
const POSTCODE_LOOKUP_SCRIPT = `(async (postcode) => {
  var cfg = window.POSTCODE_PROXY;
  if (!cfg || !cfg.url) return null;
  try {
    var res = await fetch(cfg.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ action: 'postcode_search', nonce: cfg.nonce || '', postcode: postcode })
    });
    var text = await res.text();
    return { status: res.status, body: text.slice(0, 50000) };
  } catch (e) {
    return { status: 0, body: String(e) };
  }
})`;

function stripComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'])\/\/[^\n]*/g, "$1")
    .replace(/<!--[\s\S]*?-->/g, "");
}

// The checkout page that goes with a quote page on WBT funnels:
// /boiler-quote/ -> /boiler-checkout/, /ac-quote/ -> /ac-checkout/
function checkoutCandidates(funnelUrl: string): string[] {
  const u = new URL(funnelUrl);
  const out: string[] = [];
  const m = u.pathname.match(/^\/([a-z0-9-]+?)-quote\/?$/i);
  if (m) out.push(new URL(`/${m[1]}-checkout/`, u).toString());
  out.push(new URL("/checkout/", u).toString());
  return out;
}

async function stripeKeyMode(context: BrowserContext, funnelUrl: string): Promise<{ mode: "LIVE" | "TEST"; where: string } | null> {
  const host = new URL(funnelUrl).hostname.replace(/^www\./, "");
  for (const candidate of checkoutCandidates(funnelUrl)) {
    const page = await context.request.get(candidate, { timeout: 20000, failOnStatusCode: false }).catch(() => null);
    if (!page || page.status() >= 400) continue;
    const html = await page.text().catch(() => "");
    if (!html || NOT_FOUND_TEXT.test(html.slice(0, 20000))) continue;
    const inline = stripComments(html).match(/pk_(live|test)_[A-Za-z0-9]+/);
    if (inline) return { mode: inline[1].toUpperCase() as "LIVE" | "TEST", where: candidate };
    // The site's own scripts on that page (e.g. ACF: /wp-content/themes/.../client.js)
    const srcs = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)]
      .map((m) => {
        try {
          return new URL(m[1].replace(/&amp;/g, "&"), candidate).toString();
        } catch {
          return "";
        }
      })
      .filter((s) => s && new URL(s).hostname.replace(/^www\./, "") === host)
      .slice(0, 40);
    for (const src of srcs) {
      const res = await context.request.get(src, { timeout: 15000, failOnStatusCode: false }).catch(() => null);
      if (!res || res.status() >= 400) continue;
      const code = await res.text().catch(() => "");
      if (!/pk_(live|test)_/.test(code)) continue;
      const found = stripComments(code).match(/pk_(live|test)_[A-Za-z0-9]+/);
      if (found) return { mode: found[1].toUpperCase() as "LIVE" | "TEST", where: src };
    }
    return null; // a checkout page, but no Stripe key on it
  }
  return null;
}

export async function quickCheckFunnel(funnelUrl: string, opts: { browser?: Browser } = {}): Promise<QuickCheckResult> {
  const checks: QuickCheckItem[] = [];
  const browser = opts.browser ?? (await chromium.launch({ headless: HEADLESS, channel: "chrome", args: ["--disable-blink-features=AutomationControlled"] }));
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  await context.route(
    (url) => PAYMENT_HOST.test(url.hostname) || PAYMENT_PATH.test(url.pathname),
    (route) => route.abort()
  );
  const page: Page = await context.newPage();
  try {
    // 1. The page loads
    const response = await page.goto(funnelUrl, { waitUntil: "domcontentloaded", timeout: 45000 }).catch((e) => e as Error);
    if (response instanceof Error) {
      checks.push({ key: "page", label: "Page loads", status: "problem", detail: `The page didn't open: ${response.message.split("\n")[0].slice(0, 160)}` });
      return { url: funnelUrl, checked_at: new Date().toISOString(), ok: false, checks };
    }
    await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {});
    await page.waitForTimeout(2500);
    const status = response?.status() ?? 0;
    const head = (await page.evaluate(`(document.title + ' ' + ((document.querySelector('h1') || {}).innerText || ''))`).catch(() => "")) as string;
    if (status >= 400 || NOT_FOUND_TEXT.test(head)) {
      checks.push({ key: "page", label: "Page loads", status: "problem", detail: status >= 400 ? `The page answers ${status}` : `The page shows "page not found"` });
      return { url: funnelUrl, checked_at: new Date().toISOString(), ok: false, checks };
    }
    checks.push({ key: "page", label: "Page loads", status: "ok", detail: `Loaded (${status})` });

    // 2. The quote form shows
    const controls = (await page.evaluate(VISIBLE_CONTROLS_SCRIPT).catch(() => 0)) as number;
    checks.push(
      controls > 0
        ? { key: "form", label: "Quote form shows", status: "ok", detail: `${controls} answers / fields on screen` }
        : { key: "form", label: "Quote form shows", status: "problem", detail: "No answers or fields appeared on the page - the quote form may not be loading" }
    );

    // 3. Google Tag Manager
    const gtm = (await page.evaluate(GTM_SCRIPT).catch(() => false)) as boolean;
    checks.push(
      gtm
        ? { key: "gtm", label: "GTM", status: "ok", detail: "Google Tag Manager is on the page" }
        : { key: "gtm", label: "GTM", status: "problem", detail: "Google Tag Manager isn't on the quote page - leads won't be tracked" }
    );

    // 4. The site's own postcode lookup
    const lookup = (await page.evaluate(`(${POSTCODE_LOOKUP_SCRIPT})(${JSON.stringify(POSTCODE)})`).catch(() => null)) as
      | { status: number; body: string }
      | null;
    if (!lookup) {
      checks.push({ key: "postcode", label: "Postcode lookup", status: "skipped", detail: "This form's postcode lookup can't be checked without filling it in" });
    } else {
      let parsed: any = null;
      try {
        parsed = JSON.parse(lookup.body);
      } catch {}
      const count = Array.isArray(parsed?.data?.Summaries) ? parsed.data.Summaries.length : null;
      if (lookup.status === 200 && (parsed?.success || /^\s*\{\s*"success"\s*:\s*true/.test(lookup.body))) {
        checks.push({ key: "postcode", label: "Postcode lookup", status: "ok", detail: `${count ?? "Some"} addresses for ${POSTCODE}` });
      } else if ((lookup.status === 403 || lookup.status === 400) && /^-?[01]?$/.test(lookup.body.trim())) {
        checks.push({
          key: "postcode",
          label: "Postcode lookup",
          status: "problem",
          detail: `The site refuses every postcode search (error ${lookup.status}, "${lookup.body.trim()}"): the quote page is cached with an expired security token. Purge the page cache and exclude the quote page from caching.`,
        });
      } else {
        const said = parsed?.data?.message ?? lookup.body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
        checks.push({ key: "postcode", label: "Postcode lookup", status: "problem", detail: `The postcode search failed (error ${lookup.status}${said ? `, "${said}"` : ""}) - no addresses come up` });
      }
    }

    // 5. The checkout's Stripe key
    const stripe = await stripeKeyMode(context, funnelUrl).catch(() => null);
    checks.push(
      !stripe
        ? { key: "stripe", label: "Stripe", status: "skipped", detail: "No checkout page with a Stripe key found" }
        : stripe.mode === "LIVE"
          ? { key: "stripe", label: "Stripe", status: "ok", detail: "Checkout uses a live Stripe key" }
          : { key: "stripe", label: "Stripe", status: "problem", detail: `Checkout uses a Stripe TEST key (${stripe.where.replace(/^https?:\/\/[^/]+/, "")}) - real customers can't pay` }
    );

    // 6. Phone links on the quote page and the homepage
    const bad = new Set<string>((await page.evaluate(BAD_PHONE_LINKS_SCRIPT).catch(() => [])) as string[]);
    const home = new URL("/", funnelUrl).toString();
    if (home !== funnelUrl) {
      await page.goto(home, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
      ((await page.evaluate(BAD_PHONE_LINKS_SCRIPT).catch(() => [])) as string[]).forEach((h) => bad.add(h));
    }
    checks.push(
      bad.size === 0
        ? { key: "phone_links", label: "Phone links", status: "ok", detail: "Phone links are written correctly" }
        : { key: "phone_links", label: "Phone links", status: "problem", detail: `Phone link written wrongly: ${[...bad].join(", ")} - tapping it does nothing (should start with "tel:")` }
    );

    return { url: funnelUrl, checked_at: new Date().toISOString(), ok: !checks.some((c) => c.status === "problem"), checks };
  } finally {
    await context.close().catch(() => {});
    if (!opts.browser) await browser.close().catch(() => {});
  }
}
