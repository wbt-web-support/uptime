// How funnel-tester results are read and labelled. Ported from the funnel-tester
// project's own dashboard (frontend/app/page.tsx, issues/page.tsx, reports/format.ts,
// reports/[file]/page.tsx) and its backend's /reports-detail, so this app shows a
// run the same way that tool does. Safe to import on the client and the server.

export interface PlannedActionLike {
  type: string;
  selector: string;
  value?: string;
  frame?: number;
}

export interface FinalActionLike {
  label: string;
  screenshot: string | null;
  resultingUrl: string;
  error: string | null;
  warning: string | null;
  nestedActions?: FinalActionLike[];
}

// One saved walk (WalkResult in the backend's aiWalker.ts)
export interface WalkReport {
  startUrl: string;
  viewport: "desktop" | "mobile";
  completed: boolean;
  failure: string | null;
  steps: {
    stepNumber: number;
    url: string;
    reasoning: string;
    actions: PlannedActionLike[];
    actionWarnings: string[];
    screenshot: string;
    tracking?: { gtmPresent: boolean; gtagPresent: boolean };
    uiIssues: string[];
  }[];
  consoleErrors: string[];
  pageErrors: string[];
  apiCalls: string[];
  gtmPresentThroughout: boolean;
  gtagPresentThroughout: boolean;
  finalActions: FinalActionLike[];
}

// ---------------------------------------------------------------------------
// Failure text (reports/format.ts)
// ---------------------------------------------------------------------------

export interface ParsedFailure {
  /** Short, human-readable summary - starts with "Step N: " when a step number is known. */
  headline: string;
  /** The original failure string, shown behind "Technical details". */
  raw: string;
  /** The actions the failed plan was attempting, when the message embeds them. */
  actions: PlannedActionLike[] | null;
}

// The walker embeds JSON.stringify(actions) in the failure string; selectors such as
// :has-text("Combi Boiler") contain parentheses, so find the array's real closing
// bracket by tracking depth and string state rather than the next ")".
function extractLeadingJsonArray(s: string, startIdx: number): { json: string; endIdx: number } | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = startIdx; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) return { json: s.slice(startIdx, i + 1), endIdx: i };
    }
  }
  return null;
}

export function parseFailure(raw: string | null | undefined): ParsedFailure | null {
  if (!raw) return null;

  const actionExecMatch = raw.match(/^Action execution failed at step (\d+) \(/);
  if (actionExecMatch) {
    const found = extractLeadingJsonArray(raw, actionExecMatch[0].length - 1);
    if (found) {
      const errMsg = raw.slice(found.endIdx + 1).replace(/^\):\s*/, "").replace(/^Error:\s*/, "");

      let actions: PlannedActionLike[] | null = null;
      try {
        const parsed = JSON.parse(found.json);
        if (Array.isArray(parsed)) actions = parsed;
      } catch {
        // keep the raw string as the fallback
      }

      const headline = /^Every action failed:/.test(errMsg)
        ? `All ${actions?.length ?? "several"} action(s) planned for this step could not be found on the page (fields/buttons were gone by the time we tried to use them).`
        : errMsg;
      return { headline: `Step ${actionExecMatch[1]}: ${headline}`, raw, actions };
    }
  }

  return { headline: raw, raw, actions: null };
}

const ACTION_VERB: Record<string, string> = { fill: "Fill", check: "Check", click: "Click", select: "Select" };

export function formatAction(a: PlannedActionLike): string {
  const verb = ACTION_VERB[a.type] ?? a.type;
  const frame = a.frame !== undefined && a.frame !== 0 ? ` (frame ${a.frame})` : "";
  if (a.type === "fill" || a.type === "select") return `${verb} ${a.selector} → "${a.value ?? ""}"${frame}`;
  return `${verb} ${a.selector}${frame}`;
}

// ---------------------------------------------------------------------------
// Categories and known limitations (issues/page.tsx, backend /reports-detail)
// ---------------------------------------------------------------------------

export type FailureCategory =
  | "Passed"
  | "Site request failing"
  | "Site broken"
  | "OTP blocked"
  | "Postcode/address blocked"
  | "Form/submit issue"
  | "AI planning error"
  | "Max steps exceeded"
  | "Crashed"
  | "Blocked (other)"
  | "Other failure";

export function categorize(completed: boolean, failure: string | null): FailureCategory {
  if (completed || !failure) return "Passed";
  if (/\| Site code error:|^Funnel page not found|^Site (security certificate problem|not reachable|too slow)/i.test(failure)) return "Site broken";
  if (/OTP (required|blocked)/i.test(failure)) return "OTP blocked";
  if (/postcode|address/i.test(failure)) return "Postcode/address blocked";
  if (/AI planning failed/i.test(failure)) return "AI planning error";
  if (/Exceeded max steps/i.test(failure)) return "Max steps exceeded";
  if (/Walk crashed|Test crashed/i.test(failure)) return "Crashed";
  if (/submit|form/i.test(failure)) return "Form/submit issue";
  if (/^Blocked at step/i.test(failure)) return "Blocked (other)";
  return "Other failure";
}

export const CATEGORY_CLASS: Record<FailureCategory, string> = {
  Passed: "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-400",
  "Site request failing": "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-400",
  "Site broken": "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-400",
  "OTP blocked": "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-400",
  "Postcode/address blocked": "bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-400",
  "Form/submit issue": "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400",
  "AI planning error": "bg-yellow-100 text-yellow-700 dark:bg-yellow-950 dark:text-yellow-400",
  "Max steps exceeded": "bg-muted text-muted-foreground",
  Crashed: "bg-red-200 text-red-800 dark:bg-red-950 dark:text-red-300",
  "Blocked (other)": "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400",
  "Other failure": "bg-muted text-muted-foreground",
};

// A real, confirmed constraint outside our control (vs. the tool or the site failing)
export function detectKnownLimitation(
  failure: string | null,
  steps: { actionWarnings?: string[] }[] = []
): string | null {
  if (failure && /OTP blocked at step \d+ by Twilio's content filter/i.test(failure)) {
    return "Twilio is redacting the OTP code before it reaches us (Error 30038) - needs Twilio Support to lift this restriction, not a code fix.";
  }
  if (failure && /OTP required at step \d+ but no code arrived/i.test(failure)) {
    return 'No OTP SMS reached our Twilio number in time - the site may not have sent it (e.g. its own "too many OTP requests" rate limit) or may have rejected the number.';
  }
  if (failure && /Navigated off the original site/i.test(failure)) {
    return "The site itself navigated to a different domain mid-funnel.";
  }
  const reformatWarning = steps.flatMap(s => s.actionWarnings ?? []).find(w => /was reformatted/i.test(w));
  if (reformatWarning) {
    return `The site's own JS reformatted a field after filling it (auto-corrected, but the site may still reject the result): ${reformatWarning}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The site's own requests failing (our addition)
// ---------------------------------------------------------------------------

// Server-side error messages that mean the site's own code broke, whatever the status
const SERVER_ERROR_TEXT = /error in your SQL syntax|SQLSTATE\[|mysqli?_|Fatal error:|Uncaught (?:Exception|Error|TypeError)|Parse error:|Warning: [a-z_]+\(\)|There has been a critical error on this website/i;

export interface SiteRequestProblem {
  status: number;
  method: string;
  path: string;
  count: number;
  /** The server's own message, e.g. "Your session has expired. Please reload the page and try again." */
  message: string | null;
}

// The walker records every XHR/fetch as "STATUS METHOD URL -> body". When the walk
// fails, an error from the site's own server (e.g. its postcode lookup answering
// 403 "session expired") is usually the real reason - the AI only sees an empty
// dropdown and calls it "blocked". Third-party trackers are ignored: their errors
// (a duplicate-lead 409 from a CRM pixel, say) don't stop the form.
export function detectSiteRequestProblem(report: Pick<WalkReport, "startUrl" | "apiCalls">): SiteRequestProblem | null {
  let siteHost: string;
  try {
    siteHost = new URL(report.startUrl).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }

  const byEndpoint = new Map<string, SiteRequestProblem>();
  for (const call of report.apiCalls ?? []) {
    const m = call.match(/^(\d{3}) (\w+) (\S+) -> ([\s\S]*)$/);
    if (!m) continue;
    const status = Number(m[1]);
    // Some servers answer "200 OK" with the error in the body - seen in practice: a
    // quote form's own save endpoint returning "You have an error in your SQL syntax"
    // when the address contained an apostrophe ("King's Road")
    const errorBody = SERVER_ERROR_TEXT.exec(m[4]);
    if (status < 400 && !errorBody) continue;
    let url: URL;
    try {
      url = new URL(m[3]);
    } catch {
      continue;
    }
    if (url.hostname.replace(/^www\./, "") !== siteHost) continue;

    let message: string | null = null;
    if (errorBody) {
      message = m[4].slice(errorBody.index, errorBody.index + 160).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    } else {
      try {
        const body = JSON.parse(m[4]);
        message = body?.data?.message ?? body?.message ?? body?.error ?? null;
      } catch {
        const text = m[4].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        message = text && text !== "(could not read body)" ? text.slice(0, 160) : null;
      }
    }

    const key = `${status} ${m[2]} ${url.pathname}`;
    const existing = byEndpoint.get(key);
    if (existing) existing.count++;
    else byEndpoint.set(key, { status, method: m[2], path: url.pathname, count: 1, message });
  }

  let worst: SiteRequestProblem | null = null;
  byEndpoint.forEach(p => {
    if (!worst || p.count > worst.count) worst = p;
  });
  return worst;
}

export function describeSiteRequestProblem(p: SiteRequestProblem): string {
  const times = p.count === 1 ? "once" : `${p.count} times`;
  const said = p.message ? `, saying "${p.message.replace(/[.!?\s]+$/, "")}"` : "";
  if (p.status < 400) {
    const sql = p.message && /SQL syntax|SQLSTATE|mysql/i.test(p.message)
      ? " A database error triggered by normal form input usually means the form builds its SQL from raw text (unsafe, and open to SQL injection) - the site's developer should switch it to parameterised queries."
      : "";
    return `The website's own server hit an error handling its request to ${p.path} ${times}${said}.${sql} This is a problem on the site itself, so real visitors are likely hitting it too.`;
  }
  return `The website's own server rejected its request to ${p.path} ${times} with error ${p.status}${said}. This is a problem on the site itself, so real visitors are likely hitting it too.`;
}

// ---------------------------------------------------------------------------
// Plain-English explanations for every failure (our addition)
// ---------------------------------------------------------------------------

export type ProblemOwner = "website" | "tester" | "setup" | "unclear" | "stopped";

export interface Explanation {
  /** Who needs to act: the client's website, the tester itself, our setup, or nobody (stopped on purpose) */
  owner: ProblemOwner;
  /** One short line, e.g. "No addresses came up for the postcode" */
  title: string;
  /** What happened, in plain words */
  what: string;
  /** What to do about it */
  fix: string;
}

export const OWNER_LABEL: Record<ProblemOwner, string> = {
  website: "Problem on the website",
  tester: "Tester problem - not the website",
  setup: "Setup problem",
  unclear: "Needs checking - could be the site or the tester",
  stopped: "Stopped",
};

// Turns whatever a failed test left behind - the walker's failure text, a crash
// message, and any error from the site's own server - into one clear explanation.
export function explainFailure(failure: string | null | undefined, siteProblem?: string | null): Explanation | null {
  const f = failure ?? "";
  const site = siteProblem ?? "";
  if (!f && !site) return null;

  // 0. The site itself is broken in a way the walker could pin down exactly
  const codeError = f.match(/\| Site code error: (.+)$/)?.[1];
  if (codeError) {
    const step = f.match(/step (\d+)/)?.[1];
    return {
      owner: "website",
      title: "The form's own code crashes, so it can't be submitted",
      what: `${step ? `At step ${step}, the` : "The"} website's own JavaScript threw an error: "${codeError}". After that the page doesn't move on, so real visitors get stuck here too.`,
      fix: "Send this error to the site's developer - it names the file and line that's broken. Nothing to change in the tester.",
    };
  }
  if (/^Funnel page not found/i.test(f)) {
    const url = f.match(/https?:\/\/\S+/)?.[0];
    return {
      owner: "website",
      title: "The quote page doesn't exist (page not found)",
      what: `${url ?? "The funnel page"} shows a "page not found" error instead of the quote form.${/site's own buttons link to it/.test(f) ? " The site's own Get a quote buttons point there, so visitors who click them land on a broken page." : ""}`,
      fix: "Restore the quote page, or point the site's quote buttons at the right page. If this funnel moved for good, delete it here and click Find funnels.",
    };
  }
  if (/^Site security certificate problem|net::ERR_CERT_/i.test(f)) {
    return {
      owner: "website",
      title: /expired|ERR_CERT_DATE_INVALID/.test(f) ? "The site's SSL certificate has expired" : "The site's SSL certificate is invalid",
      what: "Browsers show visitors a \"Your connection is not private\" warning instead of the website, so most people never reach the quote form.",
      fix: "Renew the SSL certificate in the site's hosting (e.g. re-issue the free Let's Encrypt certificate), then run the test again.",
    };
  }
  if (/^Site not reachable/i.test(f)) {
    return { owner: "website", title: "The website can't be reached", what: f.replace(/^Site not reachable:\s*/, ""), fix: "Check the domain and hosting are working (Check page), then run the test again." };
  }
  if (/^Site too slow/i.test(f)) {
    return { owner: "website", title: "The website is too slow to load", what: "The homepage didn't finish loading within 60 seconds, even on a second try.", fix: "Check the site's hosting and caching - visitors leave long before a minute. Run the test again once it loads quickly." };
  }

  // 1. The site's own server failed - the most common real cause, so check first
  if (/session has expired/i.test(site)) {
    return {
      owner: "website",
      title: "The site's address lookup is rejecting every search",
      what: "When a postcode is searched, the website's own server answers \"Your session has expired\" (error 403), so no addresses appear and nobody - tester or customer - can get past the postcode step. This usually means the page is served from a cache holding an expired security code.",
      fix: "In the site's WordPress: LiteSpeed Cache → Toolbox → Purge All. To stop it coming back, exclude the postcode lookup script from JS combine/cache, or keep the page cache under 12 hours.",
    };
  }
  if (/SQL syntax|SQLSTATE|mysql/i.test(site)) {
    return {
      owner: "website",
      title: "The quote form crashes when saving this address",
      what: "The website's own save step failed with a database error because the address contains an apostrophe (e.g. \"King's Road\"). Real customers at addresses like that can't get a quote either, and building database queries from raw text is a security hole (SQL injection).",
      fix: "The site's developer should change the form's save code to use parameterised queries ($wpdb->insert / $wpdb->prepare). The tester now picks plain addresses, so re-running will usually pass, but the bug is still there for customers.",
    };
  }
  if (site) {
    return {
      owner: "website",
      title: "The website's server returned an error",
      what: site,
      fix: "Pass this to the site's developer - the request named above is failing on the site itself. The full list of requests is under \"API calls\" in the report.",
    };
  }

  // 2. Stopped or interrupted on purpose / by the environment
  if (/^Stopped by user/i.test(f)) {
    return { owner: "stopped", title: "You stopped this test", what: "The test was stopped with the Stop button before it finished.", fix: "Click Run test to test it again." };
  }
  if (/interrupted \(the funnel tester restarted\)/i.test(f)) {
    return { owner: "tester", title: "The funnel tester restarted during the test", what: "The tester program was restarted while this test was running, so its progress was lost.", fix: "Click Run test to run it again." };
  }
  if (/browser has been closed|Target page, context or browser/i.test(f)) {
    return {
      owner: "tester",
      title: "The test's browser window was closed",
      what: "The Chrome window the tester was using was closed (or crashed) in the middle of the test.",
      fix: "Run it again and leave the Chrome windows that pop up alone until the test finishes. To stop them appearing at all, set WBT_HEADLESS=true in the funnel tester's .env.local.",
    };
  }
  if (/net::ERR_|ERR_ABORTED|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION/i.test(f)) {
    return { owner: "website", title: "The page couldn't be opened", what: "The browser couldn't load the page (network error, or the site didn't respond).", fix: "Check the site is up (Check page), then run the test again." };
  }
  if (/^Skipped: page is down/i.test(f)) {
    return { owner: "website", title: "The page is down", what: f.replace(/^Skipped: page is down \(?/, "The page didn't load: ").replace(/\)$/, ""), fix: "Fix or restore the page; the funnel test runs again automatically once it loads." };
  }
  if (/Walk crashed|Test crashed|Check crashed|Check did not finish/i.test(f)) {
    return {
      owner: "tester",
      title: /Check/i.test(f) ? "The UI check didn't finish" : "The tester crashed during the test",
      what: f.replace(/^(Walk|Check) crashed:\s*(Error:\s*)?/, "").split("\n")[0],
      fix: "Run it again. If it keeps happening on this site, send the report to whoever maintains the funnel tester.",
    };
  }

  // 3. Where the walk itself got stuck
  if (/Navigated off the original site/i.test(f)) {
    const to = f.match(/to (https?:\/\/[^\s)]+)/)?.[1];
    return { owner: "website", title: "The funnel sends visitors to a different website", what: `Part-way through, the funnel moved to another domain${to ? ` (${to})` : ""}. The tester stops there for safety.`, fix: "If that's intended (e.g. an external booking system), this funnel can't be tested end to end. Otherwise fix the link on the site." };
  }
  if (/OTP blocked .*Twilio/i.test(f)) {
    return { owner: "setup", title: "Twilio blocked the SMS verification code", what: "The site sent a verification code, but Twilio filtered it out (Error 30038) before it reached the tester.", fix: "Ask Twilio Support to lift the content filter on the test numbers. Nothing to change on the website." };
  }
  if (/OTP required .*no code arrived|OTP code .* received but|Failed to submit OTP/i.test(f)) {
    const detail = f.match(/no code arrived: (.+)$/)?.[1];
    if (/Twilio is not configured/i.test(f)) {
      return { owner: "setup", title: "The tester can't receive SMS codes", what: "This funnel asks for an SMS verification code, but Twilio isn't set up in the funnel tester.", fix: "Add the Twilio account details and phone numbers to the funnel tester's .env.local." };
    }
    return {
      owner: /send-code request reported success/i.test(f) ? "unclear" : "website",
      title: "The SMS verification code never arrived",
      what: detail ? `${detail.charAt(0).toUpperCase()}${detail.slice(1)}` : "The funnel asked for a phone verification code, but no SMS reached the test number in time - the site may not have sent it, or rate-limited it.",
      fix: /send-code request reported success/i.test(f)
        ? "The site says it sent the code, so check the site's SMS provider logs for that number, and the Twilio logs for anything received or filtered."
        : "Check the site's SMS/OTP provider is working and isn't blocking repeated requests from the test numbers.",
    };
  }
  if (/AI planning failed.*(SyntaxError|JSON)/i.test(f)) {
    return { owner: "tester", title: "The AI's reply was cut off", what: "The AI answered with an overlong reply that got cut off, so the tester couldn't read it. Nothing to do with the website.", fix: "Run it again - the tester now asks again for a shorter reply when this happens." };
  }
  if (/AI planning failed/i.test(f)) {
    return { owner: "setup", title: "The AI couldn't decide what to do", what: "The call to the AI model failed (often an OpenAI key, quota or outage problem).", fix: "Check OPENAI_API_KEY and its usage limits in the funnel tester's settings, then run again." };
  }
  if (/Exceeded max steps/i.test(f)) {
    const max = f.match(/Exceeded max steps \((\d+)\)/)?.[1] ?? "its";
    return { owner: "tester", title: "The test ran out of steps", what: `The tester used all ${max} steps without reaching a thank-you or results page - usually because it went round in circles on one step.`, fix: "Open the full report and look at the last few steps to see where it repeated itself. If a step genuinely can't progress, that's a problem on the site." };
  }
  if (/Every action failed|could not be found on the page/i.test(f)) {
    const step = f.match(/step (\d+)/)?.[1];
    return { owner: "tester", title: "The tester couldn't find the buttons or fields it needed", what: `${step ? `At step ${step}, the` : "The"} fields or buttons the tester tried to use weren't on the page (the page changed, or they're hidden).`, fix: "Run it again. If it fails at the same step every time, check that step in the full report - the form may be broken there." };
  }
  if (/postcode|address dropdown|address/i.test(f) && /^Blocked/i.test(f)) {
    return { owner: "website", title: "No addresses came up for the postcode", what: "The tester searched two valid postcodes (SW1A 1AA and EC1A 1BB), but the address list never appeared, so it couldn't continue.", fix: "Try a postcode search on the site yourself. If no addresses appear, the site's address lookup is broken (check its API key or cache)." };
  }
  if (/checkbox|terms|submi(t|ssion)/i.test(f) && /^Blocked/i.test(f)) {
    const step = f.match(/step (\d+)/)?.[1];
    return { owner: "website", title: "The form wouldn't submit", what: `${step ? `At step ${step} the` : "The"} details were filled in and Submit was clicked, but the page didn't move on.`, fix: "Open the full report and look at that step's screenshot for an error message. Also check \"API calls\" for a failing request - that's usually the real cause." };
  }
  if (/^Blocked at step/i.test(f)) {
    const step = f.match(/step (\d+)/)?.[1];
    return {
      owner: "unclear",
      title: `The test got stuck${step ? ` at step ${step}` : ""}`,
      what: `The tester couldn't get past this step and gave up. It said: "${f.replace(/^Blocked at step \d+:\s*/, "")}"`,
      fix: "Open the full report, look at that step's screenshot, and try the same step on the site yourself. If it works for you, it was the tester - run it again; if not, the site needs fixing.",
    };
  }

  return { owner: "tester", title: "The test didn't finish", what: f, fix: "Open the full report for the step-by-step details." };
}

// ---------------------------------------------------------------------------
// The four stages of a funnel test, each ticked or crossed
// ---------------------------------------------------------------------------

/** ok / failed, "none" = not part of this funnel (no SMS step, no results buttons),
 * "pending" = not reached, "unknown" = a test from before this was recorded */
export type StageState = "ok" | "failed" | "none" | "pending" | "unknown";
export type StageKey = "form" | "otp" | "results" | "buttons";
export type FunnelStages = Record<StageKey, StageState>;

// What's shown: three stages. Save quote and Checkout live on the thank-you /
// results page, so they're part of its stage ("buttons" is kept for details).
export const STAGES: { key: StageKey; label: string; short: string }[] = [
  { key: "form", label: "Quote form", short: "Quote form" },
  { key: "otp", label: "Verify (SMS code)", short: "Verify" },
  { key: "results", label: "Thank-you page, incl. Save quote & Checkout", short: "Thank-you page" },
];

const OTP_FAILURE = /OTP|SMS code|verification code/i;

// From one device's result: did it get through the form, the SMS code, to the
// thank-you/results page, and did the results-page buttons work?
export function deriveStages(result: {
  status: string;
  failure: string | null;
  /** Whether the walk reached an SMS-code screen; null for tests from before it was recorded */
  otp_seen?: boolean | null;
  results_buttons?: { ok: number; total: number } | null;
}): FunnelStages {
  const completed = result.status === "passed";
  const failure = result.failure ?? "";
  const stopped = /^Stopped by user|interrupted/i.test(failure);
  const otpSeen = result.otp_seen ?? null;
  const otpFailed = !completed && !stopped && OTP_FAILURE.test(failure);

  const form: StageState = completed || otpFailed || (otpSeen && !stopped) ? "ok" : stopped ? "pending" : "failed";
  const otp: StageState = otpFailed
    ? "failed"
    : otpSeen === true
      ? "ok"
      : otpSeen === null
        ? form === "ok" ? "unknown" : "pending"
        : completed
          ? "none"
          : "pending";
  const buttons: StageState = !completed
    ? "pending"
    : !result.results_buttons
      ? "unknown"
      : result.results_buttons.total === 0
        ? "none"
        : result.results_buttons.ok === result.results_buttons.total
          ? "ok"
          : "failed";
  // The thank-you page counts as working only if its Save quote / Checkout buttons did too
  const results: StageState = completed
    ? buttons === "failed" ? "failed" : "ok"
    : form === "ok" && otp !== "failed" && !stopped
      ? "failed"
      : "pending";
  return { form, otp, results, buttons };
}

// Desktop and mobile together: a stage failed if it failed on either device,
// passed only if it passed on both
export function combineStages(list: FunnelStages[]): FunnelStages | null {
  if (list.length === 0) return null;
  if (list.length === 1) return list[0];
  const pick = (key: StageKey): StageState => {
    const states = list.map(s => s[key]);
    if (states.includes("failed")) return "failed";
    if (states.every(s => s === "ok")) return "ok";
    if (states.includes("pending")) return "pending";
    if (states.every(s => s === "none")) return "none";
    if (states.includes("ok") && states.every(s => s === "ok" || s === "none")) return "ok";
    return "unknown";
  };
  return { form: pick("form"), otp: pick("otp"), results: pick("results"), buttons: pick("buttons") };
}

// What the Issues page needs from one walk - the fields the backend's
// /reports-detail returns - small enough to store alongside the full report
export interface WalkSummary {
  completed: boolean;
  failure: string | null;
  category: FailureCategory;
  knownLimitation: string | null;
  // Plain-English description of the site's own request failing, when the walk failed
  siteProblem?: string | null;
  uiIssueCount: number;
  trackingOk: boolean;
  steps: number;
}

export function summarizeWalk(report: WalkReport): WalkSummary {
  const steps = Array.isArray(report.steps) ? report.steps : [];
  const completed = !!report.completed;
  const failure = report.failure ?? null;
  const problem = completed ? null : detectSiteRequestProblem(report);
  return {
    completed,
    failure,
    category: problem ? "Site request failing" : categorize(completed, failure),
    knownLimitation: completed ? null : detectKnownLimitation(failure, steps),
    siteProblem: problem ? describeSiteRequestProblem(problem) : null,
    uiIssueCount: steps.reduce((sum, s) => sum + (s.uiIssues?.length ?? 0), 0),
    trackingOk: !!(report.gtmPresentThroughout && report.gtagPresentThroughout),
    steps: steps.length,
  };
}

// ---------------------------------------------------------------------------
// Summary cards (reports/[file]/page.tsx)
// ---------------------------------------------------------------------------

export type Tone = "good" | "warn" | "bad" | "neutral";

export interface SummaryItem {
  title: string;
  value: string;
  note: string;
  tone: Tone;
}

export function flattenFinalActions(actions: FinalActionLike[] = []): FinalActionLike[] {
  return actions.flatMap(a => [a, ...flattenFinalActions(a.nestedActions)]);
}

export function buildSummary(report: WalkReport): SummaryItem[] {
  const steps = report.steps ?? [];
  const recorded = steps.length > 0;
  const failure = report.failure ?? "";

  const otpSteps = steps.filter(s => /_otp\.png$/.test(s.screenshot));
  const otp: SummaryItem = /OTP blocked/i.test(failure)
    ? { title: "OTP", value: "Blocked", note: "Twilio filtered the code", tone: "bad" }
    : /OTP required|OTP code .* received but|Failed to submit OTP/i.test(failure)
      ? { title: "OTP", value: "Failed", note: "Code not entered", tone: "bad" }
      : otpSteps.length > 0
        ? { title: "OTP", value: "Auto-filled", note: "SMS code entered", tone: "good" }
        : { title: "OTP", value: "Not needed", note: "No SMS step", tone: "neutral" };

  const trackingOk = report.gtmPresentThroughout && report.gtagPresentThroughout;
  const tracking: SummaryItem = !recorded
    ? { title: "Tracking", value: "Not checked", note: "No steps ran", tone: "neutral" }
    : trackingOk
      ? { title: "Tracking", value: "GTM + gtag", note: "On every step", tone: "good" }
      : {
          title: "Tracking",
          value: "Missing",
          note: [!report.gtmPresentThroughout && "GTM", !report.gtagPresentThroughout && "gtag"].filter(Boolean).join(" + ") + " missing",
          tone: "bad",
        };

  const allButtons = flattenFinalActions(report.finalActions);
  const buttonsOk = allButtons.filter(b => !b.error && !b.warning).length;
  const buttons: SummaryItem = allButtons.length === 0
    ? { title: "Results buttons", value: "Not reached", note: "No results page", tone: "neutral" }
    : {
        title: "Results buttons",
        value: `${buttonsOk} / ${allButtons.length} OK`,
        note: buttonsOk === allButtons.length ? "All worked" : `${allButtons.length - buttonsOk} need a look`,
        tone: buttonsOk === allButtons.length ? "good" : "warn",
      };

  const paymentConfirmed = (report.apiCalls ?? []).some(c => /^200 POST \S*api\.stripe\.com\/v1\/payment_intents\/\S+\/confirm/.test(c));
  // Sites rarely label it "checkout" - e.g. "Secure your online price"
  const hasCheckout = allButtons.some(b => /checkout|check out|secure your (online )?price|buy now|book (&|and) pay|pay (now|deposit|online)|reserve|place (your )?order|lock in/i.test(b.label));
  const payment: SummaryItem = paymentConfirmed
    ? { title: "Checkout payment", value: "Paid (test)", note: "Stripe confirmed", tone: "good" }
    : hasCheckout
      ? { title: "Checkout payment", value: "Not paid", note: "Checkout opened, no payment", tone: "warn" }
      : { title: "Checkout payment", value: "No checkout", note: "Nothing to pay", tone: "neutral" };

  const uiSteps = steps.filter(s => (s.uiIssues?.length ?? 0) > 0).length;
  const looks: SummaryItem = !recorded
    ? { title: "Looks", value: "Not checked", note: "No screenshots", tone: "neutral" }
    : uiSteps === 0
      ? { title: "Looks", value: "No issues", note: "Every step looked fine", tone: "good" }
      : { title: "Looks", value: `${uiSteps} step(s)`, note: "Visual issues flagged", tone: "warn" };

  const form: SummaryItem = report.completed
    ? { title: "Form", value: "Submitted", note: `${steps.length} steps`, tone: "good" }
    : { title: "Form", value: "Not finished", note: recorded ? `Stopped at step ${steps.length}` : "Did not start", tone: "bad" };

  return [form, otp, tracking, buttons, payment, looks];
}

export const TONE_CLASS: Record<Tone, { card: string; value: string; dot: string }> = {
  good: { card: "border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950/40", value: "text-green-700 dark:text-green-400", dot: "✓" },
  warn: { card: "border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/40", value: "text-amber-700 dark:text-amber-400", dot: "!" },
  bad: { card: "border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/40", value: "text-red-700 dark:text-red-400", dot: "✕" },
  neutral: { card: "border-border bg-muted/40", value: "text-muted-foreground", dot: "–" },
};

// ---------------------------------------------------------------------------
// Live run progress (page.tsx)
// ---------------------------------------------------------------------------

export interface RunProgress {
  phase: string;
  detail: string;
  percent: number;
}

// Rough position in the walk, read from the walker's own progress messages. The
// form portion is an estimate (most funnels take ~20 steps); the results-page
// portion uses the real "testing final action i/N" count.
export function deriveProgress(messages: string[]): RunProgress {
  let phase = "Opening the site";
  let detail = "";
  let percent = 3;
  let step = 0;
  let topLevelButtons = 0;
  for (const m of messages) {
    let match: RegExpMatchArray | null;
    if ((match = m.match(/^step (\d+)\/\d+ - reading page/))) {
      step = Number(match[1]);
      phase = "Filling the form";
      detail = `Step ${step}`;
      percent = Math.max(percent, Math.min(70, 5 + step * 3.2));
    } else if (/OTP verification screen detected|polling Twilio for OTP/.test(m)) {
      phase = "Waiting for SMS code";
      detail = step ? `Step ${step}` : "";
    } else if ((match = m.match(/^OTP code received: (\d+)/))) {
      phase = "SMS code received";
      detail = `Code ${match[1]}`;
    } else if (/ - COMPLETE$/.test(m)) {
      phase = "Form submitted";
      detail = `${step} steps`;
      percent = Math.max(percent, 72);
    } else if ((match = m.match(/^found (\d+) final action button/)) && topLevelButtons === 0) {
      topLevelButtons = Number(match[1]);
    } else if ((match = m.match(/^testing final action (\d+)\/(\d+): "(.*)"/))) {
      phase = "Testing results-page buttons";
      detail = `${match[3]} (${match[1]} of ${match[2]})`;
      if (Number(match[2]) === topLevelButtons) {
        percent = Math.max(percent, 72 + (25 * (Number(match[1]) - 1)) / topLevelButtons);
      }
    } else if (/^filled Stripe/.test(m)) {
      phase = "Paying with Stripe test card";
    } else if (/ - BLOCKED:|^ABORT|^CRASHED/.test(m)) {
      phase = "Stopping - problem found";
    } else if (/^finished:/.test(m)) {
      phase = "Finishing up";
      percent = 99;
    }
  }
  return { phase, detail, percent };
}

export type LogKind = "complete" | "error" | "warning" | "otp" | "info";

export function classifyMessage(m: string): LogKind {
  if (/FAILED|ABORT|CRASHED/.test(m)) return "error";
  if (/\bCOMPLETE\b/.test(m)) return "complete";
  if (/OTP|Twilio/i.test(m)) return "otp";
  if (/WARNING|blocked|had to bypass|had to be forced|skipped/.test(m)) return "warning";
  return "info";
}

export const LOG_STYLE: Record<LogKind, { icon: string; className: string }> = {
  complete: { icon: "✓", className: "text-green-400" },
  error: { icon: "✕", className: "text-red-400" },
  warning: { icon: "⚠", className: "text-amber-400" },
  otp: { icon: "📱", className: "text-violet-300" },
  info: { icon: "›", className: "text-gray-400" },
};

export function isWaitingForOtp(messages: string[]): boolean {
  return /polling Twilio for OTP|OTP verification screen detected/i.test(messages[messages.length - 1] ?? "");
}
