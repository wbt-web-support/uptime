/**
 * Core AI-driven funnel walker, shared by the single-URL script
 * (poc/ai-walk.ts) and the batch/CSV runner (poc/ai-walk-batch.ts).
 *
 * Unlike the fixture funnel's data-wbt-end-state attribute (which only
 * exists on our own test pages), real client sites give no explicit
 * "you're done" signal - so completion is judged by the model itself from
 * each page's rendered content (e.g. a "thank you" / confirmation page).
 */
import { chromium, type Browser, type Frame, type Page, type ConsoleMessage } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

try {
  process.loadEnvFile(path.join(__dirname, "..", ".env.local"));
} catch {
  // no .env.local - fine if OPENAI_API_KEY is set some other way
}

// Works with OpenRouter too - it's OpenAI-compatible. Set OPENAI_BASE_URL to
// https://openrouter.ai/api/v1, OPENAI_API_KEY to an OpenRouter key
// (starts with sk-or-v1-), and OPENAI_MODEL to a provider-prefixed model
// id (e.g. "openai/gpt-4o-mini" or any other model OpenRouter offers).
// A results-page button that leads to paying/reserving - sites rarely say
// "checkout": "Secure your online price", "Buy now", "Book & pay", "Reserve"...
const CHECKOUT_LABEL = /checkout|check out|secure your (online )?price|buy now|book (&|and) pay|pay (now|deposit|online)|reserve|place (your )?order|lock in/i;

// Results-page buttons that count as working once clicked: the survey or help form
// they open is never filled in (no extra leads from it)
const CLICK_ONLY_BUTTON = /survey|help me choose|^help\b|call ?back|call me|request a call/i;

// A form's own "it worked" message after sending (save quote, callback, contact...)
const FORM_SENT_TEXT = /(quote|request|details|message|enquiry|form)?\s*(has been |was )?(sent|submitted|received|saved) successfully!?|successfully (sent|submitted|saved)|thank you[^.\n]{0,40}(for|we'?ll|we will)|we('ve| have) (received|got) your|your (quote|request|enquiry|message) (has been|was) (sent|received|saved)/i;

// The choices on a survey options page: "E-SURVEY", "IN PERSON", "Video survey"...
const SURVEY_OPTION_TEXT = /e-?survey|in[- ]person|video|online survey|virtual|home visit|book (a|your)? ?(visit|survey|call)|survey/i;

// A results-page "button" that's really a phone number or call link - never clicked
const PHONE_BUTTON = /^(\+?\d[\d\s()-]{8,}\d|(call|phone|ring)( us)?( now| today)?:?\s*[\d\s()+-]*|speak to (our|the|a) (team|expert)s?)$/i;

// Results-page links that aren't part of the funnel - reviews, contact pages,
// emails, social media - never clicked or counted (like phone numbers)
const NOT_FUNNEL_BUTTON = /^(read (our |all |more )?reviews?|(see|view|all|our|google) reviews?|what our customers say|testimonials?|read more|learn more|contact( us)?|get in touch|email( us)?|[\w.+-]+@[\w-]+\.[\w.]+|facebook|instagram|twitter|linkedin|whatsapp|youtube|tiktok)$/i;

// A pop-up's "no thanks" button ("Skip For Now" next to "Send My Quote"). It only
// closes the pop-up - once the pop-up's other button has been tested the pop-up is
// gone, so trying to click it would fail for no reason. Counted as working.
const DISMISS_BUTTON = /^(skip( for now| this( step)?)?|no,? thanks?( you)?|not now|maybe later|close|cancel|dismiss|×|x)$/i;

// Attached wherever a funnel asks for a photo (e.g. damp survey "Upload Photos for
// Assessment"): a plain 800x600 JPEG reading "WBT funnel test photo"
const TEST_PHOTO_PATH = path.join(__dirname, "..", "assets", "test-photo.jpg");

// Hides the "this browser is automated" flag (navigator.webdriver) that bot
// protection checks. A plain string on purpose: as a TS arrow function, tsx
// compiled its getter with a "__name(...)" helper that doesn't exist in the page,
// so it threw "__name is not defined" on every page and hid nothing.
const HIDE_WEBDRIVER_SCRIPT = `Object.defineProperty(navigator, "webdriver", { get: function () { return undefined; } });`;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
const OPENAI_MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-mini";

/**
 * POST to the chat completions endpoint, retrying a dropped connection or a
 * rate-limit/server error - found via real testing that a single transient
 * "TypeError: fetch failed" on step 22 aborted an otherwise healthy walk.
 */
async function openAiFetch(init: RequestInit): Promise<Response> {
  const attempts = 3;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`${OPENAI_BASE_URL}/chat/completions`, init);
      if ((res.status === 429 || res.status >= 500) && attempt < attempts) {
        await new Promise((r) => setTimeout(r, 1000 * attempt));
        continue;
      }
      return res;
    } catch (err) {
      if (attempt >= attempts) throw err;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

export type ViewportName = "desktop" | "mobile";

const VIEWPORT_CONFIGS: Record<
  ViewportName,
  { viewport: { width: number; height: number }; isMobile: boolean; hasTouch: boolean; deviceScaleFactor: number; userAgent?: string }
> = {
  desktop: { viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 },
  mobile: {
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  },
};
const ACTION_TIMEOUT_MS = 5000;
// Long boiler funnels (20+ questions, then details, address and an SMS code) used
// all 25 steps right at the code screen, so allow more
const DEFAULT_MAX_STEPS = 40;
const MAX_WAIT_RETRIES = 5;

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBERS = (process.env.TWILIO_PHONE_NUMBERS ?? "")
  .split(",")
  .map((n) => n.trim())
  .filter(Boolean);

// Round-robins across TWILIO_PHONE_NUMBERS so OTP traffic spreads across
// numbers instead of hammering one (helps avoid Twilio's anti-fraud
// Error-30038 flagging). A plain module-level counter is safe here without
// locking - Node is single-threaded, so a synchronous read-then-increment
// can never interleave with another call, even under concurrent runs.
let nextTwilioNumberIndex = 0;
function selectTwilioNumber(): string | undefined {
  if (TWILIO_PHONE_NUMBERS.length === 0) return undefined;
  const number = TWILIO_PHONE_NUMBERS[nextTwilioNumberIndex % TWILIO_PHONE_NUMBERS.length];
  nextTwilioNumberIndex++;
  return number;
}
// Email every test fills in, so the real leads it creates are easy to spot and
// remove in a client's CRM. Name is "wbt support"; the phone is the run's Twilio
// number (TWILIO_PHONE_NUMBERS), so OTP codes arrive where the walker can read them.
const TEST_EMAIL = "qa@webuildtrades.com";
// Headless by default (required for a server/CI host with no display), but
// lets you watch the browser fill the form live during local development by
// setting WBT_HEADLESS=false in .env.local.
const HEADLESS = process.env.WBT_HEADLESS !== "false";

export interface PlannedAction {
  type: "check" | "fill" | "click" | "select" | "upload";
  selector: string;
  value?: string;
  frame?: number;
}

interface AiPlan {
  isComplete: boolean;
  isBlocked?: boolean;
  needsOtp?: boolean;
  isWaiting?: boolean;
  otpFieldSelectors?: string[];
  otpFrame?: number;
  otpSubmitSelector?: string;
  reasoning: string;
  actions: PlannedAction[];
}

export interface TrackingCheck {
  gtmPresent: boolean;
  gtagPresent: boolean;
}

export interface StepLog {
  stepNumber: number;
  url: string;
  reasoning: string;
  actions: PlannedAction[];
  actionWarnings: string[];
  screenshot: string;
  tracking: TrackingCheck;
  uiIssues: string[];
}

export interface WalkResult {
  startUrl: string;
  viewport: ViewportName;
  completed: boolean;
  failure: string | null;
  steps: StepLog[];
  consoleErrors: string[];
  pageErrors: string[];
  apiCalls: string[];
  // Whether GTM/gtag were detected on EVERY step from the landing page
  // through to the final one - false if missing anywhere along the way.
  gtmPresentThroughout: boolean;
  gtagPresentThroughout: boolean;
  // Populated only when the walk COMPLETEs - each distinct "final action"
  // button found on the results page (Save Quote, Secure Online Price,
  // Book a Survey, etc.), tested independently.
  finalActions: FinalActionResult[];
  // Test numbers this walk had the site text a code to (the run's own number, plus
  // the other one if it retried there) - for the daily SMS limit
  otpNumbers?: string[];
  // Per number the site was asked to text: did a code arrive? Lets the server stop
  // using a number for a website whose SMS service has stopped sending to it.
  otpOutcomes?: Record<string, "received" | "missing">;
}

// Which answer to pick on a multiple-choice question, chosen at random for every
// step - so each test goes down a different path through the form instead of
// always picking the first answer. Answers that would end the quote are skipped.
function randomAnswerNote(): string {
  const position = 1 + Math.floor(Math.random() * 4);
  const nth = ["1st", "2nd", "3rd", "4th"][position - 1];
  return `ANSWER CHOICE for this step: on each multiple-choice question (option cards, radio buttons, single-select dropdowns), pick the ${nth} option counting from the first one shown - if there are fewer options, pick the last one. Skip any option that would end the quote or isn't a real answer (e.g. "I'm not the homeowner", "I rent", "Just looking", "Not sure", "None of these", "Other", a "No" that stops the quote) and take the next option instead. For "choose all that apply", select just that one option, then click the forward button. This doesn't apply to text boxes, postcodes, addresses, dates or the contact details.`;
}

async function askModelForNextActions(
  framesHtml: string,
  failedAttempts: PlannedAction[][],
  phoneNumber: string | undefined,
  correction?: string,
  entryHint?: string
): Promise<AiPlan> {
  // Checked here (at call time) rather than at module load - Next.js
  // imports this module while collecting build-time page data, before any
  // deployment env vars are necessarily available, so throwing at the top
  // level would fail the production build itself rather than just a run
  // that's missing its key.
  if (!OPENAI_API_KEY) {
    throw new Error(
      "Missing OPENAI_API_KEY. Add it to .env.local (see .env.local.example) or export it in your shell."
    );
  }

  const systemPrompt = `You are testing a multi-step "quote" or "contact" funnel form on a website. You will be given the visible HTML of the CURRENT step, split into one or more FRAME sections (many real quote forms are embedded in an iframe from a different domain - the actual fields are often in a non-zero frame, not the main page).

First decide between five outcomes:
1. COMPLETE - the page is showing a DIRECT system response confirming a form THIS WALK just submitted (e.g. "thank you for your quote request", "quote received", "we'll be in touch", a visible price/quote result tied to the answers you just gave). Be conservative here - only mark complete if you see explicit confirmation text or a result that is clearly a direct reply to your own submission. Critically, IGNORE incidental occurrences of words like "thank you" that appear in unrelated site content - customer testimonials/reviews ("Thank you for your service!"), marketing copy, footers - none of that counts, no matter how prominent, since it has nothing to do with anything you did. If you have not yet submitted any form during this walk (e.g. this is step 1, a plain marketing landing page with hero buttons and a reviews section), this outcome essentially never applies - see the landing-page rule below instead. A results page listing prices or products for the answers you gave IS complete even if an optional pop-up (e.g. "Send my quote", "Save quote", "Book a survey", "Get my quote by email") is also open on top of it - on a small mobile screen that pop-up can cover most of the page. Do NOT fill, submit or click behind such a pop-up: those optional extras are tested separately after the walk. If genuinely complete, set "isComplete": true and "actions": [].
2. NEEDS_OTP - ONLY if actual OTP code-entry input box(es) are ALREADY visible on the page right now (e.g. a row of digit boxes, or a field literally labeled "verification code" / "enter code"). You cannot know this code - do not guess or fill anything. Set "needsOtp": true, "otpFrame" to the frame number, "otpFieldSelectors" to an array of selectors for each individual digit input box in order (or a single selector if it's one combined field), "otpSubmitSelector" to the button that submits/verifies the code, and leave "actions": []. The code itself will be filled in separately once received. If the step instead just asks to confirm/enter a phone number with a "Send code" style button and NO code-entry input exists yet, that is NOT this outcome - treat it as CONTINUE (below): if the phone number box is EMPTY, first "fill" it with the test phone number given below, then click that button to trigger the send (clicking Send with an empty box just shows "please enter a valid phone number" and no code is ever sent); the OTP-entry screen will be a later step once the input actually appears.
3. WAITING - the page is genuinely still loading or processing with NO real interactive elements yet (e.g. a spinner, "Please wait", "Calculating your quote..." message, and nothing else to click or fill). This is different from BLOCKED: WAITING means there's simply nothing to act on YET because it hasn't finished loading, not that you've already tried everything. Set "isWaiting": true and leave "actions": [] - do NOT invent a click on some unrelated element (e.g. a header/nav link, a decorative icon) just because there's nothing else on the page; if truly nothing interactive exists, use this outcome instead and the page will be re-checked shortly.
4. BLOCKED - you've already tried every reasonable option for this exact step (see the failed-attempts history below, if given) and none of them progress the form - e.g. neither fallback postcode ever populated an address dropdown. This is a genuine dead end, not just "haven't tried yet". If so, set "isBlocked": true, explain exactly what's blocking it in "reasoning", and leave "actions": [].
5. CONTINUE - anything else: decide the single set of actions needed to fill in a valid answer and advance to the next step (or submit, if this looks like the final step).

Rules:
- Every action must include "frame": the number of the FRAME section the selector belongs to (from the "=== FRAME N ..." headers you're given).
- Use selectors exactly as they appear in that frame's HTML (prefer "#id" selectors, or a short unique CSS selector if no id exists).
- AVOID ":nth-child(N)" to pick one of several visually-similar option cards - it silently fails whenever each option is individually wrapped in its own parent container (extremely common in real grid/column layouts, where every option ends up being "child 1" of its own wrapper, so ":nth-child(2)" never matches anything). Instead, target the exact one you mean by its visible text using Playwright's ":has-text(\"...\")" (e.g. ".box.card.mob_box:has-text(\"Yes, I do\")" - use the option's exact visible text as it appears in the HTML). For an option whose text is just a number or a very short word (e.g. "1", "2", "Yes"), wrap it in SINGLE quotes - ".box.all-option:has-text('1')" - and give that click exactly once; never output a selector that ends unfinished like ":has-text(".
- Use "check" for radio/checkbox inputs, "fill" for text inputs, "click" for buttons/links, "select" for a native <select> dropdown (e.g. "Select an address") - for "select", set "value" to the visible text of one of its <option> elements exactly as it appears in the HTML.
- BEFORE deciding to re-fill or re-search ANY field (a postcode, an address, anything), first check whether a "Next"/"Continue"/forward-moving button is ALREADY present anywhere on the page that wasn't part of the original empty form. That button existing IS the proof your previous action already succeeded - click it now instead of repeating the search, even if the original input field is still sitting there editable, even if no dropdown ever appeared, and even if there's explicit instructional text on the page telling you to click it (e.g. "Adjust the map to center your house perfectly, then click Next to start drawing" next to a "Next" button - that sentence is telling you exactly what to do right now, read it and follow it literally). Sites confirm a successful search in different ways - a populated dropdown is only ONE of them; a newly-appeared forward button is just as valid a signal and takes equal priority. Only treat a search as having failed (and retry it) when NEITHER a populated dropdown NOR any new forward button has appeared.
- If a dropdown like "Select an address" is present with real populated <option> entries (not just an empty placeholder), you MUST select one to proceed - any reasonable option is fine, there's no need to pick a specific one. Many sites visually clear/reset the postcode text field back to empty once the address search succeeds, while the results dropdown right next to it is now fully populated - if you see an empty-looking search field NEXT TO a populated dropdown, that is a successful search result waiting to be selected, not a sign to search again. Re-check every dropdown's actual <option> list before deciding to "fill" a field again.
- On a manual address step (separate boxes such as house number/name, address line 1/street, address line 2, town/city, county, postcode), fill EVERY box that is empty and required (marked * or "required") in one go, using this test address: house number "10", street/address line 1 "Downing Street", town/city "London", county "Greater London" - and leave a postcode that's already filled as it is. Filling only the house number leaves the street line empty and the step won't continue. Before clicking Continue again after a step didn't move on, read the whole page's HTML for a validation message (it may be above the visible area) and fill exactly the box it names.
- When picking an address from a list (a dropdown, or clickable address rows/cards), choose one whose text contains NO apostrophe or other special punctuation - e.g. prefer "10 Downing Street, London" over "King's Road, ..." or "St. John's Wood". Several sites' quote forms crash when the saved address contains an apostrophe; that bug is reported separately, and the funnel test itself should get through. Only if every address has one, pick any.
- Only include a final "click" on a button that moves FORWARD (e.g. "Next", "Continue", "Get My Quote", "Submit") - never click "Back"/"Previous". Many single-choice steps have no forward button at all because selecting the option auto-advances; if the only other button visible is "Back", do NOT click it - just select the option and stop there.
- Answer each question ONCE: pick the option named by the "ANSWER CHOICE" note in the message (it varies, so different answers get tested on different runs) and move on. Many funnels ask several similar questions in a row on the same page (e.g. "Ground floor rooms?" then "External doors?", or one Yes/No question after another) - if the question text on screen is different from the one you just answered, your previous answer WORKED and this is a new question, even if it has the same options. Never go back to try a different option on a question that already moved on, and never treat a new question as a failed attempt.
- For a UK postcode field, use "SW1A 1AA" as the primary value. Always use a COMPLETE, correctly formatted postcode with both parts (outward + inward) - never a partial/outward-only postcode like "AB12".
- If, after searching with "SW1A 1AA", there is neither a populated address dropdown NOR any new forward button anywhere on the page (see the rule above), retry ONCE with "EC1A 1BB" instead - that is the only fallback, do not invent or try any other postcode. If EC1A 1BB also produces neither a populated dropdown nor a forward button (i.e. this is your third+ attempt on this exact step), this is BLOCKED - do not keep retrying either postcode a third time.
- This can result in a REAL lead being created in a real business's CRM/notifications, so ALWAYS use this exact identifiable test identity for any personal-info fields, never a generic placeholder like "John Doe": first name "wbt", last name "support", full name "wbt support", email "${TEST_EMAIL}", phone "${phoneNumber ?? "+447366249700"}". Use these exact values for every field of that kind, every time - NEVER invent different or randomized values for these fields, even on a retry after a submit didn't appear to progress. A stuck submit with the correct test identity is a genuine site issue to report as BLOCKED, not a sign the identity itself needs to change. You may retry with the EXACT SAME identity values at most once (in case it was a transient issue), but if it still doesn't progress, mark it BLOCKED rather than trying different personal-info values.
- For a calendar/date-picker widget: many highlight TODAY's date by default (e.g. a colored circle or bold text) even when nothing has been actively selected yet - that default styling is NOT the same as a selection. Critically, many booking calendars don't actually allow booking FOR today at all (a minimum lead-time rule) even though today's cell still looks styled/clickable like any other day - clicking it can silently do nothing. ALWAYS click a day a few days out (e.g. the 2nd or 3rd enabled, non-greyed-out day AFTER today in the grid) rather than today's own date, and always issue that click explicitly before clicking any Confirm/Next button even if a date already looks highlighted. If the form still won't progress after picking a clearly-future date, try a different future date once before concluding it's genuinely BLOCKED. For a time-preference choice presented as separate boxes (e.g. "Morning" / "Afternoon"), treat it as a single-choice pick: choose exactly ONE, never check more than one.
- Never pick actions that navigate away from this form (e.g. header nav links, external links, social icons).
- The very first step is often a marketing landing page, not a form yet, and is NEVER "COMPLETE" just because a word like "thank you" appears somewhere on it (e.g. inside a customer review) - if so, find and click the button/link that starts the quote or contact process (e.g. "Get a Quote", "Get Started", "Request a Callback") to begin the funnel.${
    entryHint
      ? `
- WHICH FUNNEL: this site has several quote funnels (e.g. boiler, heat pump, air conditioning, solar, battery) and this test is for ONE of them: the one at "${entryHint}". While you are still on a landing/marketing/service page (no form started yet), start THAT funnel: click the link or button whose href points to "${entryHint}" - matching by href takes priority, and this overrides the "never click header nav links" rule, since the link may only be in the menu. If no link points there directly, click the service link that clearly leads to that same service (e.g. "Air Source Heat Pump" for /ashp-quote/), then that page's quote button. Never start a different service's funnel. Once inside the form, ignore this rule and complete it as normal.`
      : ""
  }
- PHOTO / FILE UPLOADS: for a step asking for photos or files (e.g. "Upload Photos for Assessment" with several "Upload" boxes), use "upload" with the selector of each upload box (or its <input type="file">) - a test photo is attached automatically, you never pick a file. Upload one photo into each upload box on the step, then click the forward button (e.g. "Next Step") in the same set of actions. Never call such a step BLOCKED because a file is needed.
- Reply with ONLY a JSON object: {"isComplete": boolean, "isBlocked": boolean, "needsOtp": boolean, "isWaiting": boolean, "otpFieldSelectors"?: string[], "otpFrame"?: number, "otpSubmitSelector"?: string, "reasoning": string, "actions": [{"type": "check"|"fill"|"click"|"select"|"upload", "selector": string, "value"?: string, "frame": number}]}`;

  // The test identity must never appear in the "did not work, pick something else"
  // list below. It used to, which contradicted the identity rule in the system
  // prompt and made the model invent a new name/email/phone on a retry - seen in a
  // real run that then submitted "test user" / testuser@example.com / +447123456789
  // to a client's CRM. Phones are compared by digits so "07..." vs "+447..." match.
  const identityPhone = phoneNumber ?? "+447366249700";
  const digits = (v: string) => v.replace(/\D/g, "").replace(/^44/, "0");
  const isIdentityValue = (v: string) => {
    const lower = v.trim().toLowerCase();
    if (["wbt", "support", "wbt support", TEST_EMAIL].includes(lower)) return true;
    const d = digits(v);
    return d.length >= 10 && d === digits(identityPhone);
  };

  const triedValues = Array.from(
    new Set(
      failedAttempts
        .flat()
        .map((a) => a.value)
        .filter((v): v is string => !!v && !isIdentityValue(v))
    )
  );

  const historyNote =
    failedAttempts.length > 0
      ? `\n\nNOTE: you are still on the exact same page after ${failedAttempts.length} previous attempt(s) - none of them progressed the form.${
          triedValues.length > 0
            ? ` Values already tried and CONFIRMED NOT TO WORK: ${triedValues
                .map((v) => `"${v}"`)
                .join(", ")}. Do not reuse any of these - pick a genuinely different value (e.g. the next untried postcode from the list).`
            : ""
        } The personal-info test identity (wbt / support / ${TEST_EMAIL} / ${identityPhone}) is NOT a value that failed - keep using it exactly as given, never change it. Before retrying or concluding BLOCKED, look for a validation message on the page (e.g. "Please confirm the checkbox above", "This field is required") and fix exactly what it names - most often a required consent/terms checkbox that is still unticked.\nFull action history for reference:\n${failedAttempts
          .map((a, i) => `Attempt ${i + 1}: ${JSON.stringify(a)}`)
          .join("\n")}`
      : "";

  const requestPlan = async (retryNote?: string): Promise<string> => {
    const res = await openAiFetch({
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        response_format: { type: "json_object" },
        temperature: 0,
        // A plan is a few hundred tokens. Without a cap, a runaway reply was seen
        // running to ~27k characters and getting cut off mid-string
        max_tokens: 1500,
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: `Current step frames:\n\n${framesHtml}${historyNote}${
              correction ? `\n\nCORRECTION NEEDED: ${correction}` : ""
            }${retryNote ? `\n\n${retryNote}` : ""}\n\n${randomAnswerNote()}`,
          },
        ],
      }),
    });

    if (!res.ok) {
      throw new Error(`OpenAI API error ${res.status}: ${await res.text()}`);
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("OpenAI response had no content");
    return content;
  };

  // One unreadable reply shouldn't end the whole walk: ask once more for a short one
  let plan: AiPlan;
  try {
    plan = JSON.parse(await requestPlan()) as AiPlan;
  } catch (parseErr) {
    if (!(parseErr instanceof SyntaxError)) throw parseErr;
    plan = JSON.parse(
      await requestPlan(
        `Your previous reply was not valid JSON (it was cut off). Reply again with ONE short JSON object exactly as specified - keep "reasoning" under 300 characters and include only the actions for this step.`
      )
    ) as AiPlan;
  }
  if (
    !plan.isComplete &&
    !plan.isBlocked &&
    !plan.needsOtp &&
    !plan.isWaiting &&
    (!Array.isArray(plan.actions) || plan.actions.length === 0)
  ) {
    // Seen in practice: the model's own "reasoning" correctly identifies a
    // genuine dead end (e.g. a site-side error page with nothing to click)
    // but forgets to also set "isBlocked": true - crashing the whole walk
    // with an exception here for something the model already diagnosed
    // correctly is worse than just trusting that diagnosis and reporting it
    // as BLOCKED the normal way.
    if (plan.reasoning && plan.reasoning.trim()) {
      plan.isBlocked = true;
    } else {
      throw new Error(`Model returned no actions and did not mark itself complete, blocked, needing OTP, or waiting: ${JSON.stringify(plan)}`);
    }
  }
  return plan;
}

const SKIP_TAGS = new Set(["script", "style", "noscript", "svg", "link", "img", "video", "iframe"]);
const KEEP_EVEN_IF_EMPTY = new Set(["input", "button", "textarea", "select", "option"]);

// Sent to page.evaluate() as a raw string (not a TS function reference) on
// purpose: tsx/esbuild's transpile of this file injects a "__name" helper
// call into any function passed here, but Playwright serializes evaluate()
// callbacks to a bare string and runs them standalone in the browser, where
// that helper doesn't exist - causing "ReferenceError: __name is not
// defined". A plain string is never touched by the transpiler, so it's
// eval'd as-is with no injected helpers.
const GET_VISIBLE_HTML_SCRIPT = `
(function () {
  var skipTags = ${JSON.stringify(Array.from(SKIP_TAGS))};
  var keepEvenIfEmpty = ${JSON.stringify(Array.from(KEEP_EVEN_IF_EMPTY))};

  function isVisible(el) {
    // <option> elements inside a native, currently-closed <select> report a
    // zero-size bounding box - real browser rendering quirk, not actually
    // hidden. Judge them by their parent <select>'s visibility instead,
    // otherwise every dropdown's real choices get silently stripped out.
    if (el.tagName.toLowerCase() === "option") {
      return el.parentElement ? isVisible(el.parentElement) : true;
    }
    var style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return false;
    }
    var rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  // Deliberately always document.body, not the first <main> or <form> found -
  // seen in practice on a real site: an early, still-empty placeholder
  // <form> (its real fields render into it slightly later) matched before
  // body and became the root, hiding all the real content sitting outside
  // it. body reliably contains everything actually on screen.
  var root = document.body;

  var rootClone = document.createElement("div");
  var stack = [{ srcEl: root, parentClone: null }];
  while (stack.length > 0) {
    var item = stack.pop();
    var srcEl = item.srcEl;
    var parentClone = item.parentClone;
    var tag = srcEl.tagName.toLowerCase();
    // The root itself (body/main/form) skips the visibility check - some
    // SPA layouts (seen in practice: a Nuxt app whose real content sits in
    // fixed/absolute-positioned children) leave <body> with a genuine
    // zero-height bounding box even though the page is fully visible on
    // screen, which wiped out the entire extraction here. Descendants still
    // go through the normal check below.
    var isRootEl = parentClone === null;
    if (skipTags.indexOf(tag) !== -1 || (!isRootEl && !isVisible(srcEl))) continue;

    var clone = document.createElement(tag);
    for (var i = 0; i < srcEl.attributes.length; i++) {
      var attr = srcEl.attributes[i];
      if (attr.name === "style") continue;
      if (attr.name === "class" && attr.value.length > 200) continue;
      clone.setAttribute(attr.name, attr.value);
    }

    if (parentClone) {
      parentClone.appendChild(clone);
    } else {
      rootClone = clone;
    }

    var children = Array.prototype.slice.call(srcEl.childNodes);
    for (var j = children.length - 1; j >= 0; j--) {
      var child = children[j];
      if (child.nodeType === Node.TEXT_NODE) {
        var text = child.textContent && child.textContent.trim();
        if (text) clone.appendChild(document.createTextNode(text));
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        stack.push({ srcEl: child, parentClone: clone });
      }
    }
  }

  var all = Array.prototype.slice.call(rootClone.querySelectorAll("*")).reverse();
  for (var k = 0; k < all.length; k++) {
    var el = all[k];
    var elTag = el.tagName.toLowerCase();
    if (keepEvenIfEmpty.indexOf(elTag) !== -1) continue;
    var hasText = (el.textContent || "").trim().length > 0;
    if (!hasText && el.children.length === 0) el.remove();
  }

  return rootClone.outerHTML;
})()
`;

const MAX_TOTAL_HTML_CHARS = 40000;

/**
 * Captures visible HTML from every frame on the page (not just the main
 * document) - many real quote forms are embedded via a cross-origin iframe
 * (e.g. GoHighLevel/LeadConnector widgets), so the interactive fields often
 * live outside the top-level page entirely. Each frame's content is
 * labeled with its index so the model can tell us which frame an action
 * belongs to.
 */
const FRAME_READ_TIMEOUT_MS = 8000;

/**
 * A frame stuck mid-navigation (e.g. an ad/chat iframe stuck in a reload
 * loop) can leave frame.evaluate() pending forever - it has no built-in
 * timeout of its own, unlike Playwright's action methods. Racing it against
 * a timeout stops one bad frame from hanging the entire walk indefinitely.
 * The stray evaluate() call itself can't be cancelled, so its rejection (if
 * any, once it eventually settles) is swallowed here rather than left as an
 * unhandled rejection later.
 */
function evaluateWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  promise.catch(() => {});
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`evaluate() timed out after ${ms}ms`)), ms)),
  ]);
}

// A host without its "www." - the bare and www addresses are the same website
function sameSiteHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, "");
}

// The model sometimes escapes an apostrophe SQL-style inside single quotes:
// .sglOption:has-text('No, I don''t') - Playwright can't parse that. Rewrite the
// text in double quotes: .sglOption:has-text("No, I don't")
function fixDoubledQuotes(selector: string): string {
  return selector.replace(/:(has-text|text-is)\('((?:[^']|'')*)'\)/g, (m, fn, text: string) => {
    if (!text.includes("''")) return m;
    return `:${fn}("${text.replace(/''/g, "'").replace(/"/g, '\\"')}")`;
  });
}

// Why a selector the model wrote can't be used as-is, or null if it looks fine:
// brackets or quotes left open (".box.all-option:has-text(") or an empty text match
function selectorProblem(selector: string | undefined): string | null {
  if (!selector || !selector.trim()) return "an empty selector";
  let depth = 0;
  let quote: string | null = null;
  for (const ch of selector) {
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")" && --depth < 0) return `unbalanced brackets in "${selector}"`;
  }
  if (quote || depth !== 0) return `an unfinished selector "${selector}"`;
  if (/:(has-text|text-is)\(\s*(""|'')?\s*\)/.test(selector)) return `an empty text match in "${selector}"`;
  return null;
}

function dedupeActions(actions: PlannedAction[]): PlannedAction[] {
  const seen = new Set<string>();
  return actions.filter((a) => {
    const key = JSON.stringify(a);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// The model sometimes both "check"s and "click"s the same answer (seen on WME:
// check ".option-card:has-text('Rear extension')" then click it). On a
// "choose all that apply" question each answer is a toggle, so the second action
// un-selects it again, "Next" does nothing and the walk ends stuck. Only the
// first check/click of each element is kept.
function dropDoubleToggles(actions: PlannedAction[]): PlannedAction[] {
  const pressed = new Set<string>();
  return actions.filter((a) => {
    if (a.type !== "click" && a.type !== "check") return true;
    const key = `${a.frame ?? 0}|${a.selector}`;
    if (pressed.has(key)) return false;
    pressed.add(key);
    return true;
  });
}

// A visible, empty phone-number box in any frame - the selector to fill it with and
// which frame it's in. Used to catch a "Send code" click with no number entered.
const FIND_EMPTY_PHONE_FIELD_SCRIPT = `
(function () {
  var fields = document.querySelectorAll('input[type="tel"], input[name*="phone" i], input[id*="phone" i], input[name*="mobile" i], input[id*="mobile" i], input[placeholder*="phone" i], input[placeholder*="mobile" i]');
  for (var i = 0; i < fields.length; i++) {
    var el = fields[i];
    if (el.type === "hidden" || el.disabled || el.readOnly || (el.value || "").trim()) continue;
    var rect = el.getBoundingClientRect();
    var style = getComputedStyle(el);
    if (rect.width === 0 || rect.height === 0 || style.display === "none" || style.visibility === "hidden") continue;
    if (el.id) return "#" + CSS.escape(el.id);
    if (el.name) return 'input[name="' + el.name.replace(/"/g, '\\\\"') + '"]';
  }
  return null;
})()
`;

async function findEmptyPhoneField(page: Page): Promise<{ selector: string; frame: number } | null> {
  const frames = page.frames();
  for (let i = 0; i < frames.length; i++) {
    const selector = (await evaluateWithTimeout(frames[i].evaluate(FIND_EMPTY_PHONE_FIELD_SCRIPT), FRAME_READ_TIMEOUT_MS).catch(
      () => null
    )) as string | null;
    if (selector) return { selector, frame: i };
  }
  return null;
}

// Summary of what's wrong with a plan's actions, or null when they're usable
function describePlanProblems(actions: PlannedAction[]): string | null {
  const problems = new Set<string>();
  for (const a of actions) {
    const p = selectorProblem(a.selector);
    if (p) problems.add(p);
  }
  if (actions.length > 1 && dedupeActions(actions).length < actions.length) {
    problems.add("the same action repeated several times");
  }
  return problems.size ? Array.from(problems).slice(0, 3).join("; ") : null;
}

// The visible text of the page itself (frame 0), ignoring markup, attributes and
// embedded widgets (chat, tracking iframes) that change on their own - for telling
// whether the question on screen is still the same one
function mainFrameText(framesHtml: string): string {
  const mainSection = framesHtml.split(/\n\n(?==== FRAME \d+ )/)[0] ?? framesHtml;
  return mainSection
    .replace(/^=== FRAME \d+ \([^)]*\) ===\n/, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function getAllFramesHtml(page: Page): Promise<string> {
  const frames = page.frames();
  const sections: string[] = [];

  for (let i = 0; i < frames.length; i++) {
    let html: string;
    try {
      html = (await evaluateWithTimeout(
        frames[i].evaluate(GET_VISIBLE_HTML_SCRIPT),
        FRAME_READ_TIMEOUT_MS
      )) as string;
    } catch {
      continue; // frame detached/cross-origin restricted/navigated away mid-read/stuck - skip
    }
    if (!html || html.replace(/<[^>]+>/g, "").trim().length < 2) continue;
    sections.push(`=== FRAME ${i} (${frames[i].url()}) ===\n${html}`);
  }

  const combined = sections.join("\n\n");
  return combined.slice(0, MAX_TOTAL_HTML_CHARS);
}

/**
 * Checks the top-level page (not embedded iframes - GTM/gtag are installed
 * by the site owner on their own page, not inside a third-party funnel
 * widget) for Google Tag Manager and gtag.js/Google Analytics, so a run's
 * report can show whether tracking was present on every step from the
 * landing page through to the final one, not just assumed.
 */
async function checkTracking(page: Page): Promise<TrackingCheck> {
  try {
    return await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      const dataLayer = w.dataLayer;
      const hasDataLayer = Array.isArray(dataLayer) && dataLayer.length > 0;
      const hasGtmObject = typeof w.google_tag_manager === "object" && w.google_tag_manager !== null;
      const scripts = Array.from(document.scripts);
      const gtmScript = scripts.some((s) => s.src.includes("googletagmanager.com/gtm.js"));
      const gtagScript = scripts.some((s) => s.src.includes("googletagmanager.com/gtag/js"));
      const hasGtagFn = typeof w.gtag === "function";

      return {
        gtmPresent: hasDataLayer || hasGtmObject || gtmScript,
        gtagPresent: hasGtagFn || gtagScript,
      };
    });
  } catch {
    return { gtmPresent: false, gtagPresent: false };
  }
}

/**
 * Sends a step's screenshot to the vision-capable model and asks it to flag
 * anything that would visually confuse or block a real visitor - most
 * importantly buttons/links that don't LOOK clickable, which the HTML-only
 * planning call above has no way to judge (a <button> with broken CSS is
 * still a perfectly valid selector to the DOM). Best-effort: any failure
 * (non-vision model, network error, bad JSON) just yields no issues rather
 * than aborting the walk over a QA side-check.
 */
async function checkUiIssues(
  screenshotPath: string,
  viewport: ViewportName,
  log: (msg: string) => void
): Promise<string[]> {
  if (!OPENAI_API_KEY) return [];
  try {
    const buffer = await readFile(screenshotPath);
    const base64 = buffer.toString("base64");
    const res = await openAiFetch({
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        response_format: { type: "json_object" },
        temperature: 0,
        messages: [
          {
            role: "system",
            content: `You are a QA engineer reviewing a screenshot of a website taken at a ${viewport} viewport width for visual problems that would confuse or block a real visitor. Look specifically for:
- Buttons or links that don't look clickable/tappable (no visible button styling, blends into the background, too small, or overlapping another element)
- Text or elements cut off, overlapping, or overflowing their container or the edge of the screen
- Broken or missing images/icons
- Layout that looks visibly broken (misaligned, squished, or stacked incorrectly)
${viewport === "mobile" ? "- Tap targets that look smaller than roughly 44x44px, elements too close together to tap accurately, or content wider than the screen causing horizontal scroll" : ""}

Only report something you can actually SEE in this exact image - never guess about things outside it. If nothing looks wrong, return an empty list.

Reply with ONLY JSON: {"issues": string[]} - each a short, specific, plain-English description (e.g. "The 'Get a Quote' button blends into the background and doesn't look clickable" not "poor CTA affordance").`,
          },
          {
            role: "user",
            content: [
              { type: "text", text: "Review this screenshot." },
              { type: "image_url", image_url: { url: `data:image/png;base64,${base64}` } },
            ],
          },
        ],
      }),
    });

    if (!res.ok) {
      log(`UI issue check failed: ${res.status} ${await res.text()}`);
      return [];
    }
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return [];
    const parsed = JSON.parse(content) as { issues?: string[] };
    return Array.isArray(parsed.issues) ? parsed.issues : [];
  } catch (err) {
    log(`UI issue check crashed: ${err}`);
    return [];
  }
}

// One UK English mistake on a page: the wrong text, the correction, and what kind
export interface GrammarIssue {
  found: string;
  suggestion: string;
  reason: "US spelling" | "Spelling" | "Grammar" | "Punctuation" | string;
}

/**
 * Proofreads a page's visible text for UK English: US spellings (color →
 * colour), typos, grammar and punctuation. Names, addresses, prices and phone
 * numbers are left alone. Never throws - a failed check just finds nothing.
 */
export async function checkUkGrammar(pageText: string, log: (msg: string) => void): Promise<GrammarIssue[]> {
  // Visible text only, squashed, and capped so a long page stays one cheap call
  const text = pageText.replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim().slice(0, 8000);
  if (text.length < 40 || !OPENAI_API_KEY) return [];
  try {
    const res = await openAiFetch({
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        response_format: { type: "json_object" },
        temperature: 0,
        messages: [
          {
            role: "system",
            content: `You are a careful UK English proofreader checking the text of a UK trade business's website. Find only DEFINITE mistakes that are actually in the text you are given:
- a word spelled the American way where British English spells it differently
- a misspelled word (a typo)
- a clear grammar error (wrong verb agreement, a missing or wrong word, its/it's, their/there, your/you're)
- a clearly missing apostrophe (e.g. "dont")
Rules:
- Every "found" value must be copied EXACTLY from the text - never invent, guess or give examples. If the words aren't in the text, don't report them.
- Leave correct text alone: no style, tone, wording, hyphenation, comma or capitalisation preferences, and no rewording of sentences that are already correct.
- Ignore customer reviews and testimonials, names of brands, products, companies, places and people, addresses, postcodes, phone numbers, emails and prices.
- When in doubt, leave it out. Report each mistake once, at most 15.
Reply with ONLY JSON: {"issues": [{"found": "the exact wrong words copied from the text, with a few words around them", "suggestion": "the same words corrected", "reason": "US spelling" | "Spelling" | "Grammar" | "Punctuation"}]}. No mistakes: {"issues": []}.`,
          },
          { role: "user", content: `Website text:\n\n${text}` },
        ],
      }),
    });
    if (!res.ok) {
      log(`grammar check failed: ${res.status}`);
      return [];
    }
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return [];
    const parsed = JSON.parse(content) as { issues?: GrammarIssue[] };
    // Keep only mistakes whose words really are on the page - the model can
    // otherwise "find" typical mistakes that aren't there
    const plain = (s: string) => s.toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim();
    const pagePlain = plain(text);
    const candidates = (Array.isArray(parsed.issues) ? parsed.issues : [])
      .filter((i) => i && typeof i.found === "string" && typeof i.suggestion === "string")
      .filter((i) => plain(i.found) !== plain(i.suggestion) && plain(i.found).length > 1 && pagePlain.includes(plain(i.found)))
      .filter((i) => !isOnlyStyleChange(i.found, i.suggestion))
      .slice(0, 15);
    return await keepDefiniteMistakes(candidates, log);
  } catch (err) {
    log(`grammar check crashed: ${err}`);
    return [];
  }
}

// A "correction" that leaves correct British English merely restyled: expanding a
// contraction (you're → you are), changing spaces, hyphens, commas or
// apostrophes (powerflushing → power flushing), dropping a possessive 's, or only
// adding words. Real typos and wrong words always change at least one word.
const CONTRACTIONS: [RegExp, string][] = [
  [/\b(\w+)'re\b/g, "$1 are"], [/\b(\w+)'ve\b/g, "$1 have"], [/\b(\w+)'ll\b/g, "$1 will"],
  [/\b(\w+)'d\b/g, "$1 would"], [/\bcan't\b/g, "cannot"], [/\bwon't\b/g, "will not"],
  [/\b(\w+)n't\b/g, "$1 not"], [/\bi'm\b/g, "i am"], [/\b(it|that|there|what|here|he|she)'s\b/g, "$1 is"],
];
function isOnlyStyleChange(found: string, suggestion: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[’‘`]/g, "'");
  const expand = (s: string) => CONTRACTIONS.reduce((acc, [re, to]) => acc.replace(re, to), norm(s));
  const letters = (s: string) => s.replace(/[^a-z0-9]/g, "");
  const a = expand(found), b = expand(suggestion);
  // Same letters once contractions, spacing, hyphens, commas and apostrophes go
  if (letters(a) === letters(b)) return true;
  // "12-year warranty", "2-hour slot" are correct - never "fix" them
  if (/\b\d+-(year|month|week|day|hour|minute|point|stage)s?\b/.test(a)) return true;
  // Only a possessive 's dropped or added
  if (letters(a.replace(/'s\b/g, "")) === letters(b.replace(/'s\b/g, ""))) return true;
  // Only words added: every word of the original is still there, in order
  const wa = a.match(/[a-z0-9]+/g) ?? [];
  const wb = b.match(/[a-z0-9]+/g) ?? [];
  if (wb.length > wa.length) {
    let k = 0;
    for (const w of wb) if (w === wa[k]) k++;
    if (k === wa.length) return true;
  }
  return false;
}

// Second, strict look at each suggested mistake: the first pass also flags
// correct text (expanding "you're", "power flushing" vs "powerflushing",
// adding commas). Keeps only the ones that are definitely wrong as written.
async function keepDefiniteMistakes(candidates: GrammarIssue[], log: (msg: string) => void): Promise<GrammarIssue[]> {
  if (candidates.length === 0) return [];
  try {
    const res = await openAiFetch({
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        response_format: { type: "json_object" },
        temperature: 0,
        messages: [
          {
            role: "system",
            content: `You check suggested corrections to UK English website text. For each numbered suggestion decide: is the ORIGINAL text definitely wrong in British English - a real typo, an American spelling where British English differs, or a clear grammar error that a careful UK editor would always fix?
Answer NO when the original is acceptable British English, including: contractions (you're, doesn't), possessives (manufacturer's warranty), compound words written as one, two or hyphenated, hyphenated numbers ("2-year guarantee"), optional commas, capitalisation, or rewording that only changes style.
Reply with ONLY JSON: {"keep": [numbers of the suggestions that are definite mistakes]}.`,
          },
          {
            role: "user",
            content: candidates.map((c, n) => `${n + 1}. "${c.found}" -> "${c.suggestion}" (${c.reason})`).join("\n"),
          },
        ],
      }),
    });
    if (!res.ok) return candidates;
    const data = await res.json();
    const keep = new Set<number>((JSON.parse(data.choices?.[0]?.message?.content ?? "{}").keep ?? []).map(Number));
    return candidates.filter((_, n) => keep.has(n + 1));
  } catch (err) {
    log(`grammar double-check failed (keeping the first results): ${err}`);
    return candidates;
  }
}

/**
 * page.screenshot() can hang far longer than its own default timeout
 * suggests, waiting internally on web fonts to finish loading (a Playwright
 * behavior, not something we control) - found via real testing that a
 * single stuck font wait crashed an entire walk with an uncaught timeout
 * error. Caps the wait and never throws: a missing screenshot for one step
 * is a minor loss, not a reason to abort everything after it.
 */
async function safeScreenshot(page: Page, screenshotPath: string, log: (msg: string) => void): Promise<boolean> {
  try {
    await page.screenshot({ path: screenshotPath, timeout: 8000 });
    return true;
  } catch (err) {
    // page.screenshot() waits for web fonts and can time out on font-heavy pages
    // (seen on results pages: several buttons ended up with "No screenshot").
    // Chrome's own capture doesn't wait for anything - use it as a fallback.
    try {
      const cdp = await page.context().newCDPSession(page);
      const shot = (await Promise.race([
        cdp.send("Page.captureScreenshot", { format: "png" }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("capture timed out")), 8000)),
      ])) as { data: string };
      writeFileSync(screenshotPath, Buffer.from(shot.data, "base64"));
      await cdp.detach().catch(() => {});
      log(`screenshot needed Chrome's direct capture (the normal one timed out)`);
      return true;
    } catch (fallbackErr) {
      log(`screenshot failed (continuing without it): ${err}; direct capture: ${fallbackErr}`);
      return false;
    }
  }
}

/**
 * Screenshots the current page, then runs GTM/gtag detection and the vision
 * UI check off that same screenshot - shared by every point in the walk
 * loop that records a step (normal step, OTP step, complete/blocked step),
 * so all three stay in sync instead of duplicating this three times.
 */
async function screenshotAndAnalyze(
  page: Page,
  screenshotPath: string,
  viewport: ViewportName,
  log: (msg: string) => void,
  stepLabel: string,
  pendingUiChecks: Promise<void>[]
): Promise<{ tracking: TrackingCheck; uiIssues: string[] }> {
  const ok = await safeScreenshot(page, screenshotPath, log);
  const tracking = await checkTracking(page);
  // The vision UI check only feeds the report - nothing in the walk depends
  // on its result - so it runs in the background off the saved screenshot
  // instead of blocking the next step on a full vision API round trip.
  // The returned array is filled in place once it resolves (the step
  // record holds the same reference); walkFunnel awaits every pending
  // check before returning.
  const uiIssues: string[] = [];
  if (ok) {
    pendingUiChecks.push(
      checkUiIssues(screenshotPath, viewport, log).then((issues) => {
        uiIssues.push(...issues);
        if (issues.length > 0) log(`${stepLabel} - UI issues: ${issues.join("; ")}`);
      })
    );
  }
  return { tracking, uiIssues };
}

const OTP_POLL_INTERVAL_MS = 4000;
const OTP_POLL_MAX_ATTEMPTS = 20; // ~80s total - real SMS delivery can take a while
const OTP_FETCH_TIMEOUT_MS = 8000;
const OTP_FETCH_RETRIES = 2; // quick immediate retries for a single transient network blip (DNS/TLS/connection reset), before falling through to the next poll cycle

/**
 * One Twilio Messages API call with a timeout and a couple of immediate
 * retries for transient network failures (e.g. the Node/undici "fetch
 * failed" wrapper around a dropped or reset connection) - these are common
 * on a plain HTTPS call repeated every few seconds and aren't Twilio errors,
 * so retrying immediately is cheap and avoids burning a whole poll cycle on
 * a one-off blip.
 */
async function fetchTwilioMessagesWithRetry(
  url: string,
  auth: string,
  attempt: number,
  log: (msg: string) => void
): Promise<Response | null> {
  for (let retry = 0; retry <= OTP_FETCH_RETRIES; retry++) {
    try {
      return await fetch(url, {
        headers: { Authorization: `Basic ${auth}` },
        signal: AbortSignal.timeout(OTP_FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      const cause = err instanceof Error && err.cause ? ` (cause: ${err.cause})` : "";
      if (retry < OTP_FETCH_RETRIES) {
        log(
          `Twilio poll attempt ${attempt} had a network error, retrying immediately (${retry + 1}/${OTP_FETCH_RETRIES}): ${err}${cause}`
        );
        await new Promise((r) => setTimeout(r, 500 * (retry + 1)));
      } else {
        log(`Twilio poll attempt ${attempt} failed after ${OTP_FETCH_RETRIES + 1} tries: ${err}${cause}`);
      }
    }
  }
  return null;
}

/**
 * Polls Twilio's Messages API for an inbound SMS to our number sent after
 * `sinceIso`, and pulls the first 4-8 digit run out of its body as the
 * OTP code. Polls rather than using a webhook so this works the same
 * whether running locally or deployed, with no public callback URL needed.
 */
async function fetchOtpFromTwilio(
  sinceIso: string,
  phoneNumber: string | undefined,
  log: (msg: string) => void
): Promise<{ code: string | null; blocked: boolean }> {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !phoneNumber) {
    log("OTP needed but Twilio isn't configured (TWILIO_ACCOUNT_SID/AUTH_TOKEN/PHONE_NUMBERS)");
    return { code: null, blocked: false };
  }

  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
  const sinceMs = Date.parse(sinceIso);
  // "DateSent>" (sent-after) is Twilio's actual documented range filter for
  // this endpoint - the previous "DateSentAfter" param doesn't exist in
  // Twilio's API and was being silently ignored, so every poll was really
  // just fetching the most recent messages with no date filtering at all.
  // The date_sent check below is the real correctness guarantee (it's
  // exact-timestamp, whereas Twilio's own filter is date-granularity only)
  // - it's what actually stops a stale OTP from an earlier run being
  // matched by mistake.
  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json?To=${encodeURIComponent(
    phoneNumber
  )}&DateSent%3E=${encodeURIComponent(sinceIso.slice(0, 10))}&PageSize=20`;

  for (let attempt = 1; attempt <= OTP_POLL_MAX_ATTEMPTS; attempt++) {
    log(`polling Twilio for OTP SMS to ${phoneNumber} (attempt ${attempt}/${OTP_POLL_MAX_ATTEMPTS})...`);
    const res = await fetchTwilioMessagesWithRetry(url, auth, attempt, log);
    if (res) {
      if (res.ok) {
        const data = await res.json();
        const messages: Array<{
          body?: string;
          direction?: string;
          date_sent?: string;
          error_code?: number | null;
          from?: string;
        }> = data.messages ?? [];
        const fresh = messages.filter(
          (m) =>
            (!m.direction || m.direction === "inbound") &&
            !(m.date_sent && Date.parse(m.date_sent) < sinceMs) // stale message from before this run started
        );
        for (const m of fresh) {
          const match = m.body?.match(/\b\d{4,8}\b/);
          if (match) {
            log(`OTP code received: ${match[0]}`);
            return { code: match[0], blocked: false };
          }
        }
        // Twilio's OTP content filter logs the SMS within seconds as failed
        // with Error 30038 and the digits already stripped - no later poll
        // can ever recover the code, so stop now instead of burning the
        // rest of the ~80s poll window.
        const blocked = fresh.find((m) => m.error_code === 30038);
        if (blocked) {
          log(
            `OTP SMS from "${blocked.from ?? "unknown sender"}" arrived but Twilio's content filter blocked it (Error 30038) - its digits were removed before reaching us, stopping the poll`
          );
          return { code: null, blocked: true };
        }
      } else {
        log(`Twilio API error ${res.status}: ${await res.text()}`);
      }
    }
    await new Promise((r) => setTimeout(r, OTP_POLL_INTERVAL_MS));
  }
  log("Gave up waiting for OTP SMS - none arrived in time");
  return { code: null, blocked: false };
}

export interface CtaCheckResult {
  label: string;
  clicked: boolean;
  changed: boolean;
  resultingUrl: string;
  error: string | null;
  resultScreenshot: string | null;
  resultUiIssues: string[];
}

/**
 * Asks the model to name the SINGLE most prominent lead-gen call-to-action
 * on a landing page (e.g. "Get a Free Quote", "Request a Quote", "Book
 * Now") - the one a real visitor would click to start the funnel. Only one,
 * not every button on the page (that's identifyFinalActionButtons' job on a
 * completed funnel's results page) - this runs on an ordinary landing page
 * where most buttons are just navigation.
 */
async function identifyPrimaryCta(
  framesHtml: string
): Promise<{ label: string; selector: string; frame: number } | null> {
  if (!OPENAI_API_KEY) return null;
  try {
    const res = await openAiFetch({
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        response_format: { type: "json_object" },
        temperature: 0,
        messages: [
          {
            role: "system",
            content: `This is a landing page. Identify the SINGLE most prominent primary call-to-action button or link that a visitor would click to start getting a quote or contacting the business (e.g. "Get a Free Quote", "Get a Quote", "Request a Quote", "Book Now", "Enquire Now", "Contact Us"). Prefer one in the header or hero section over a duplicate further down the page. Give it a short human-readable label and a CSS selector: ALWAYS anchor it to the element's own tag or class first, THEN add ":has-text(\\"...\\")" matched on its exact visible text - e.g. "a.cta-btn:has-text(\\"Get a Free Quote\\")", never a bare ":has-text(...)" with nothing in front of it, and never ":nth-child". If you genuinely can't find any such CTA, set "found" to false. Reply with ONLY JSON: {"found": boolean, "label": string, "selector": string, "frame": number}`,
          },
          { role: "user", content: `Page frames:\n\n${framesHtml}` },
        ],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;
    const parsed = JSON.parse(content) as {
      found?: boolean;
      label?: string;
      selector?: string;
      frame?: number;
    };
    if (!parsed.found || !parsed.label || !parsed.selector) return null;
    return { label: parsed.label, selector: parsed.selector, frame: parsed.frame ?? 0 };
  } catch {
    return null;
  }
}

/**
 * Clicks the page's primary CTA and checks - deterministically, no extra AI
 * call needed - whether anything actually happened: a navigation, a visible
 * modal/dialog appearing, or new form fields appearing (an inline quote form
 * revealing itself). A button that looks fine but does none of these is
 * likely broken (dead link, JS error, wrong handler) even though the vision
 * UI check above would never catch it since it only judges a static
 * screenshot.
 */
/**
 * frame.click(selector) (the pattern used everywhere else in this file)
 * always acts on the FIRST DOM match regardless of visibility, which breaks
 * on sites that repeat the same CTA class/text in several places (e.g. one
 * copy sitting inside a closed mobile nav drawer) - found via real testing
 * on a site with 10 duplicate "Get a Free Quote" buttons, where the click
 * hung forever waiting for the first (hidden) one instead of using any of
 * the 9 genuinely visible ones. This walks every match and clicks the first
 * one that's actually visible.
 */
async function clickFirstVisibleMatch(frame: Frame, selector: string): Promise<void> {
  const locator = frame.locator(selector);
  const count = await locator.count();
  for (let i = 0; i < count; i++) {
    const candidate = locator.nth(i);
    if (await candidate.isVisible().catch(() => false)) {
      await candidate.scrollIntoViewIfNeeded().catch(() => {});
      // A visible match can still fail Playwright's actionability check if
      // it's mid entrance-animation ("element is not stable") - a short
      // settle wait, then a forced click as a last resort since we've
      // already confirmed it's genuinely visible ourselves.
      await frame.page().waitForTimeout(500).catch(() => {});
      await candidate
        .click({ timeout: ACTION_TIMEOUT_MS })
        .catch(() => candidate.click({ timeout: ACTION_TIMEOUT_MS, force: true }));
      return;
    }
  }
  throw new Error(`No visible element matched selector: ${selector}`);
}

async function checkPrimaryCta(
  page: Page,
  cta: { label: string; selector: string; frame: number },
  viewport: ViewportName,
  screenshotDir: string,
  log: (msg: string) => void
): Promise<CtaCheckResult> {
  const before = await page.evaluate(() => ({
    url: location.href,
    formFieldCount: document.querySelectorAll("input, textarea, select").length,
  }));

  try {
    const frame = resolveFrame(page, cta.frame);
    await clickFirstVisibleMatch(frame, cta.selector);
    await page.waitForTimeout(1500);
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});

    const after = await page.evaluate(() => ({
      url: location.href,
      formFieldCount: document.querySelectorAll("input, textarea, select").length,
      hasVisibleDialog: Array.from(
        document.querySelectorAll('[role="dialog"], .modal, [aria-modal="true"]')
      ).some((el) => {
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      }),
    }));

    const navigated = after.url !== before.url;
    const formFieldsIncreased = after.formFieldCount > before.formFieldCount;
    const changed = navigated || formFieldsIncreased || after.hasVisibleDialog;
    log(
      changed
        ? `"${cta.label}" click did something (${navigated ? `navigated to ${after.url}` : after.hasVisibleDialog ? "opened a modal/dialog" : "revealed new form fields"})`
        : `"${cta.label}" was clicked but nothing visible happened - may be broken`
    );

    let resultScreenshot: string | null = null;
    let resultUiIssues: string[] = [];
    if (changed) {
      log(`checking the page "${cta.label}" led to (${viewport})...`);
      const candidatePath = `${screenshotDir}/${viewport}-cta-result.png`;
      const ok = await safeScreenshot(page, candidatePath, log);
      if (ok) {
        resultScreenshot = candidatePath;
        resultUiIssues = await checkUiIssues(candidatePath, viewport, log);
      }
    }

    return {
      label: cta.label,
      clicked: true,
      changed,
      resultingUrl: after.url,
      error: null,
      resultScreenshot,
      resultUiIssues,
    };
  } catch (err) {
    log(`"${cta.label}" could not be clicked: ${err}`);
    return {
      label: cta.label,
      clicked: false,
      changed: false,
      resultingUrl: before.url,
      error: String(err),
      resultScreenshot: null,
      resultUiIssues: [],
    };
  }
}

export interface QuoteButtonResult {
  label: string;
  position: string;
  href: string | null;
  clicked: boolean;
  works: boolean;
  outcome: string;
  resultingUrl: string;
  error: string | null;
  screenshot: string | null;
}

// Marks every visible "quote" button/link on the page with data-wbt-quote=N
// (in page order) and describes each - deterministic, so the count is the
// real number on the page rather than whatever a model chose to mention.
const MARK_QUOTE_BUTTONS_SCRIPT = `
(() => {
  const found = [];
  const els = Array.from(document.querySelectorAll('a, button, [role="button"], input[type="submit"], input[type="button"]'));
  for (const el of els) {
    el.removeAttribute('data-wbt-quote');
    const text = (el.innerText || el.value || '').replace(/\\s+/g, ' ').trim();
    // "Get a quote", and buttons that start a quote without saying so: "See if
    // your home is solar ready", "Get my price", "Check your eligibility",
    // "Calculate your savings", "Book a free survey"...
    if (!text || text.length > 60 || !/\\b(quotes?|ready|(get|see|check)( a| my| your)?( free| instant| online)? (price|pricing|cost)|instant price|get started|start now|check (my|your|if)|see if|find out (your|my|how much|if)|calculate|eligib|book( a| your)?( free)? (survey|visit|assessment))\\b/i.test(text)) continue;
    const href = el.getAttribute('href') || '';
    if (/^(tel|mailto|sms):/i.test(href)) continue;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    if (r.width === 0 || r.height === 0 || s.visibility === 'hidden' || s.display === 'none' || s.opacity === '0') continue;
    if (r.right < 0 || r.left > innerWidth) continue; // off-canvas (e.g. a closed slide-in menu)
    if (found.some((f) => f.el.contains(el))) continue; // inner part of a button already counted
    found.push({ el, text, href });
  }
  const pageHeight = Math.max(document.documentElement.scrollHeight, 1);
  return found.map((f, i) => {
    f.el.setAttribute('data-wbt-quote', String(i));
    const y = (f.el.getBoundingClientRect().top + scrollY) / pageHeight;
    return {
      text: f.text,
      href: f.href || null,
      position: y < 0.2 ? 'top of page' : y > 0.75 ? 'bottom of page' : 'middle of page',
    };
  });
})()
`;

async function openLandingPage(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(800);
  await page.waitForLoadState("networkidle", { timeout: 2000 }).catch(() => {});
}

/**
 * Finds every visible quote button on the landing page and clicks each one
 * in turn (reloading the page fresh before each), checking it actually leads
 * somewhere: a new page, a pop-up, a form appearing, or a new tab.
 */
async function checkAllQuoteButtons(
  page: Page,
  url: string,
  viewport: ViewportName,
  screenshotDir: string,
  log: (msg: string) => void,
  shouldStop: () => boolean = () => false
): Promise<QuoteButtonResult[]> {
  const buttons = (await page.evaluate(MARK_QUOTE_BUTTONS_SCRIPT).catch(() => [])) as Array<{
    text: string;
    href: string | null;
    position: string;
  }>;
  log(
    buttons.length > 0
      ? `found ${buttons.length} quote button(s) (${viewport}): ${buttons.map((b) => `"${b.text}"`).join(", ")}`
      : `no quote buttons found on the landing page (${viewport})`
  );

  const results: QuoteButtonResult[] = [];
  for (let i = 0; i < buttons.length; i++) {
    if (shouldStop()) {
      log(`STOPPED by user before quote button ${i + 1}/${buttons.length} (${viewport})`);
      break;
    }
    const btn = buttons[i];
    log(`clicking quote button ${i + 1}/${buttons.length} (${viewport}): "${btn.text}" (${btn.position})...`);
    const result: QuoteButtonResult = {
      label: btn.text,
      position: btn.position,
      href: btn.href,
      clicked: false,
      works: false,
      outcome: "",
      resultingUrl: url,
      error: null,
      screenshot: null,
    };
    let newTab: Page | null = null;
    const onNewTab = (p: Page) => {
      newTab = p;
    };
    const testOne = async () => {
      if (i > 0) {
        await openLandingPage(page, url);
        await page.evaluate(MARK_QUOTE_BUTTONS_SCRIPT);
      }
      const before = await page.evaluate(() => ({
        url: location.href,
        formFieldCount: document.querySelectorAll("input, textarea, select").length,
      }));
      const target = page.locator(`[data-wbt-quote="${i}"]`).first();
      if ((await target.count()) === 0) throw new Error("button no longer on the page after reloading");
      page.context().on("page", onNewTab);
      // Plain DOM scroll, not scrollIntoViewIfNeeded(): found via real testing
      // that a button far down a mobile page (with a scroll-in animation)
      // never counted as "stable", and the Playwright scroll waited 30s on
      // it - stalling the whole check.
      await target.evaluate((el) => el.scrollIntoView({ block: "center" }), undefined, { timeout: 3000 }).catch(() => {});
      // A button that animates non-stop (seen: "See if your home is battery storage
      // ready") is never "stable", so the normal click gives up - force-click it
      await target
        .click({ timeout: 3000 })
        .catch(() => target.click({ force: true, timeout: 3000 }))
        .catch(() => target.evaluate((el) => (el as HTMLElement).click(), undefined, { timeout: 3000 }));
      result.clicked = true;
      // A link can take a few seconds to start loading the next page
      await page.waitForURL((u) => u.href !== before.url, { timeout: 5000 }).catch(() => {});
      await page.waitForLoadState("networkidle", { timeout: 1500 }).catch(() => {});

      const after = await page
        .evaluate(() => ({
          url: location.href,
          formFieldCount: document.querySelectorAll("input, textarea, select").length,
          hasVisibleDialog: Array.from(document.querySelectorAll('[role="dialog"], .modal, [aria-modal="true"]')).some((el) => {
            const r = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            return r.width > 0 && r.height > 0 && style.visibility !== "hidden" && style.display !== "none";
          }),
        }))
        .catch(() => ({ url: page.url(), formFieldCount: 0, hasVisibleDialog: false }));

      const openedTab = newTab as Page | null;
      let shotPage: Page = page;
      if (openedTab) {
        await openedTab.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
        result.works = true;
        result.resultingUrl = openedTab.url();
        result.outcome = `opened ${openedTab.url()} in a new tab`;
        shotPage = openedTab;
      } else if (after.url !== before.url) {
        result.works = true;
        result.resultingUrl = after.url;
        result.outcome = `went to ${after.url}`;
      } else if (after.hasVisibleDialog) {
        result.works = true;
        result.outcome = "opened a pop-up";
      } else if (after.formFieldCount > before.formFieldCount) {
        result.works = true;
        result.outcome = "showed a form on the same page";
      } else {
        result.outcome = "clicked but nothing happened - may be broken";
      }
      const shotPath = `${screenshotDir}/${viewport}-quote-${i + 1}.png`;
      if (await safeScreenshot(shotPage, shotPath, log)) result.screenshot = shotPath;
      if (openedTab) await openedTab.close().catch(() => {});
    };
    try {
      // Safety net so one unresponsive button can never stall the check.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = await Promise.race([
        testOne().then(() => false),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(true), 30000);
        }),
      ]).finally(() => clearTimeout(timer));
      if (timedOut) {
        result.works = false;
        result.outcome = "didn't respond within 30s";
      }
    } catch (err) {
      result.error = String(err);
      result.outcome = "could not be clicked";
    } finally {
      page.context().off("page", onNewTab);
    }

    // Found via real testing: a button found on the page can be re-drawn by the
    // site (a cookie banner or pop-up loading late) before the click lands, so the
    // click times out and a working button got reported as broken. The tester
    // failing to click isn't the site failing - for a plain link, open its address
    // directly and count it as working if that page loads.
    if (result.error && btn.href && !shouldStop()) {
      try {
        const linkUrl = new URL(btn.href, url).toString();
        const res = await page.goto(linkUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
        if (res && res.status() < 400) {
          result.works = true;
          result.resultingUrl = page.url();
          result.outcome = `its link opens ${page.url()} (the tester couldn't click the button itself: ${String(result.error).split("\n")[0]})`;
          result.error = null;
          const shotPath = `${screenshotDir}/${viewport}-quote-${i + 1}.png`;
          if (await safeScreenshot(page, shotPath, log)) result.screenshot = shotPath;
        } else {
          result.outcome = `could not be clicked, and its link ${linkUrl} returned ${res ? res.status() : "no response"}`;
        }
      } catch (linkErr) {
        log(`quote button ${i + 1} link check failed: ${linkErr}`);
      }
    }
    log(`quote button ${i + 1}/${buttons.length} "${btn.text}" (${viewport}): ${result.works ? "✓" : "✕"} ${result.outcome}`);
    results.push(result);
  }
  return results;
}

/**
 * Fast, standalone version of the UI check that does NOT run the AI
 * form-filling loop at all - just loads the page once and screenshots it.
 * The full walkFunnel() (AI planning + fill + submit + wait-for-networkidle
 * per step, x2 viewports) takes minutes; when someone only wants to know
 * "does this button look clickable", that full form-walking cost is wasted
 * work, so this exists as a much quicker (~seconds) alternative.
 */
export async function checkPageUi(
  url: string,
  viewport: ViewportName,
  screenshotDir: string,
  onProgress?: (message: string) => void,
  shouldStop: () => boolean = () => false,
  // The funnel this check is for (e.g. ".../battery-storage-quote/"): when the
  // homepage has no quote buttons, that service's own page is checked instead
  entryHint?: string
): Promise<{
  screenshot: string;
  // The page whose quote buttons were checked - the homepage, or a service page
  landingUrl: string;
  uiIssues: string[];
  ctaCheck: CtaCheckResult | null;
  quoteButtons: QuoteButtonResult[];
  // UK spelling / grammar mistakes in the page text - checked on desktop only,
  // since the words are the same on mobile
  grammarIssues: GrammarIssue[] | null;
}> {
  const log = (msg: string) => {
    console.log(`[ui-check] ${msg}`);
    (onProgress ?? (() => {}))(msg);
  };
  mkdirSync(screenshotDir, { recursive: true });
  const viewportConfig = VIEWPORT_CONFIGS[viewport];

  log(`loading ${url} (${viewport})...`);
  const browser = await chromium.launch({
    headless: HEADLESS,
    channel: "chrome",
    args: ["--disable-blink-features=AutomationControlled"],
  });
  try {
    const context = await browser.newContext({
      viewport: viewportConfig.viewport,
      isMobile: viewportConfig.isMobile,
      hasTouch: viewportConfig.hasTouch,
      deviceScaleFactor: viewportConfig.deviceScaleFactor,
      userAgent: viewportConfig.userAgent,
    });
    await context.addInitScript({ content: HIDE_WEBDRIVER_SCRIPT });
    const page = await context.newPage();
    // "domcontentloaded" rather than "load" - a single slow third-party
    // asset (ad/tracker) that never fires the full load event shouldn't
    // fail a check that only needs the page visually rendered to
    // screenshot, and mobile in particular can hit this (seen in practice:
    // the same URL's mobile load timed out at 30s on "load" while desktop
    // didn't).
    // Same as a funnel walk: one retry for a slow site, and a plain-words error
    // for an expired SSL certificate or an unreachable site
    await openStartPage(page, url, log);
    await page.waitForTimeout(1500);
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});

    const screenshotPath = `${screenshotDir}/${viewport}.png`;
    const screenshotOk = await safeScreenshot(page, screenshotPath, log);

    log(`checking button clickability (${viewport})...`);
    // The UK grammar check runs alongside the design check (desktop only)
    const pageText = viewport === "desktop" ? await page.evaluate(() => document.body.innerText).catch(() => "") : "";
    const grammarPromise = viewport === "desktop" ? checkUkGrammar(pageText, log) : Promise.resolve(null);
    const uiIssues = screenshotOk ? await checkUiIssues(screenshotPath, viewport, log) : [];
    log(uiIssues.length > 0 ? `found ${uiIssues.length} issue(s)` : "no issues found");
    const grammarIssues = await grammarPromise;
    if (grammarIssues) log(`UK spelling & grammar: ${grammarIssues.length} mistake(s) found`);

    let quoteButtons = await checkAllQuoteButtons(page, url, viewport, screenshotDir, log, shouldStop);

    // No quote buttons on the homepage: on some sites they're only on each
    // service's own page ("See if your home is battery storage ready" on
    // /battery-storage/). Check the buttons there - the page a visitor goes to
    // from the homepage on the way to this funnel.
    let landingUrl = url;
    if (quoteButtons.length === 0 && entryHint && !shouldStop()) {
      await openLandingPage(page, url);
      // The page on the way to this funnel: a hero button or menu item whose page
      // links to it (e.g. "DAMP PROOFING" -> /damp-proofing/ with "GET A QUOTE")
      const servicePage = (await findLandingPagesFor(page, entryHint))[0];
      if (servicePage) {
        log(`no quote buttons on the homepage - checking ${servicePage.href}, the page that leads to this funnel (${viewport})`);
        await openLandingPage(page, servicePage.href);
        const found = await checkAllQuoteButtons(page, servicePage.href, viewport, screenshotDir, log, shouldStop);
        if (found.length > 0) {
          quoteButtons = found;
          landingUrl = servicePage.href;
        }
      }
    }

    // Only needed when the page has no "quote" buttons at all (e.g. its main
    // button says "Book Now" or "Contact Us") - otherwise every quote button
    // was just clicked above, so this would repeat that work.
    let ctaCheck: CtaCheckResult | null = null;
    if (quoteButtons.length === 0) {
      await openLandingPage(page, url);
      log(`identifying primary CTA (${viewport})...`);
      const cta = await identifyPrimaryCta(await getAllFramesHtml(page));
      if (cta) {
        log(`testing primary CTA (${viewport}): "${cta.label}"...`);
        ctaCheck = await checkPrimaryCta(page, cta, viewport, screenshotDir, log);
      } else {
        log(`no primary CTA identified (${viewport})`);
      }
    }

    await context.close();
    return { screenshot: screenshotPath, uiIssues, ctaCheck, quoteButtons, grammarIssues, landingUrl };
  } finally {
    await browser.close();
  }
}

// Auto-selects the first real option on any <select> still sitting on its
// placeholder - deterministic rather than relying on the (unreliable in
// practice) model to notice a dropdown was just populated by a search and
// switch from "fill" to "select" itself. Found via real-world testing: a
// site can reset its postcode text field back to empty right after a
// successful address lookup while the results dropdown next to it is fully
// populated - the model kept re-filling the now-empty-looking field instead
// of selecting a result, across multiple different real sites, even after
// the system prompt was strengthened to call this out explicitly.
const AUTO_SELECT_DROPDOWN_SCRIPT = `
(function () {
  var selects = document.querySelectorAll("select");
  var picked = [];
  for (var i = 0; i < selects.length; i++) {
    var sel = selects[i];
    if (sel.selectedIndex > 0) continue;
    if (sel.options.length <= 1) continue;
    // First real option, but preferring one without an apostrophe: several sites'
    // quote forms crash saving an address like "King's Road" (reported separately),
    // and the test itself should get through
    var chosen = -1;
    var plain = -1;
    for (var j = 0; j < sel.options.length; j++) {
      var opt = sel.options[j];
      var text = (opt.textContent || "").trim();
      var val = (opt.value || "").trim();
      if (!val) continue;
      if (/^(select|choose)\\b|manual|add.*address|can.?t find/i.test(text)) continue;
      if (chosen === -1) chosen = j;
      if (!/['\\u2019\`]/.test(text)) {
        plain = j;
        break;
      }
    }
    if (plain !== -1) chosen = plain;
    if (chosen === -1) continue;
    sel.selectedIndex = chosen;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    sel.dispatchEvent(new Event("input", { bubbles: true }));
    picked.push((sel.id || sel.name || "select") + " -> " + sel.options[chosen].textContent.trim());
  }
  return picked;
})()
`;

const HAS_EMPTY_VISIBLE_SELECT_SCRIPT = `
(function () {
  var selects = document.querySelectorAll("select");
  for (var i = 0; i < selects.length; i++) {
    var el = selects[i];
    var rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    var style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") continue;
    if (el.options.length <= 1) return true;
  }
  return false;
})()
`;

/**
 * A postcode search fills its address dropdown from an API call that can
 * land a second or two after the click - found via real testing that
 * networkidle can resolve before that request even starts, so the page was
 * read with the dropdown still showing only its "Select an address"
 * placeholder and the model wrongly concluded the search had failed. Only
 * waits while a visible dropdown is actually still empty, so steps without
 * one pay nothing.
 */
async function waitForEmptyDropdownsToPopulate(page: Page, maxMs: number): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    let anyEmpty = false;
    for (const frame of page.frames()) {
      const empty = await evaluateWithTimeout(frame.evaluate(HAS_EMPTY_VISIBLE_SELECT_SCRIPT), FRAME_READ_TIMEOUT_MS).catch(
        () => false
      );
      if (empty) {
        anyEmpty = true;
        break;
      }
    }
    if (!anyEmpty) return;
    await page.waitForTimeout(400);
  }
}

// Returns how many dropdowns it picked an option in
async function autoSelectPopulatedDropdowns(page: Page, log: (msg: string) => void): Promise<number> {
  let count = 0;
  for (const frame of page.frames()) {
    try {
      const picked = (await evaluateWithTimeout(
        frame.evaluate(AUTO_SELECT_DROPDOWN_SCRIPT),
        FRAME_READ_TIMEOUT_MS
      )) as string[];
      if (picked.length > 0) {
        log(`auto-selected populated dropdown(s): ${picked.join("; ")}`);
        count += picked.length;
      }
    } catch {
      // frame detached/cross-origin restricted/stuck - skip
    }
  }
  return count;
}

// After a postcode search: keep checking for the address list for a few seconds.
// Found on a real site (desktop): the "Select an address" box only appears once
// the lookup answers, so the empty-dropdown wait above saw no dropdown at all and
// returned straight away; the list arrived a moment later, the model then took
// the search as failed and tried the second postcode, and the walk got stuck.
const UK_POSTCODE = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i;
async function waitAndPickAddress(page: Page, log: (msg: string) => void, maxMs = 7000): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if ((await autoSelectPopulatedDropdowns(page, log)) > 0) return;
    await page.waitForTimeout(500);
  }
}

// Looks for a visible, enabled button/link whose exact text is "Next" or
// "Continue" - found via real testing that telling the model about this in
// prose rules alone isn't reliable enough (a probabilistic model can still
// miss it and re-search a field that already succeeded, e.g. a map-based
// address step with no dropdown at all). Detecting it deterministically in
// code and handing the model an explicit correction naming the exact
// selector is far more reliable than hoping it reads a paragraph of rules.
const FIND_FORWARD_BUTTON_SCRIPT = `
(() => {
  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const style = getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
  }
  const candidates = Array.from(document.querySelectorAll("button, a, input[type=button], input[type=submit]"));
  for (const el of candidates) {
    const text = (el.innerText || el.value || "").trim().toLowerCase();
    if ((text === "next" || text === "continue") && isVisible(el) && !el.disabled) {
      const label = (el.innerText || el.value).trim();
      if (el.id) return { selector: "#" + el.id, label };
      const tag = el.tagName.toLowerCase();
      return { selector: tag + ":has-text(\\"" + label + "\\")", label };
    }
  }
  return null;
})()
`;

async function findForwardButtonHint(
  page: Page
): Promise<{ selector: string; label: string; frame: number } | null> {
  const frames = page.frames();
  for (let frameIndex = 0; frameIndex < frames.length; frameIndex++) {
    try {
      const found = (await evaluateWithTimeout(
        frames[frameIndex].evaluate(FIND_FORWARD_BUTTON_SCRIPT),
        FRAME_READ_TIMEOUT_MS
      )) as { selector: string; label: string } | null;
      if (found) return { ...found, frame: frameIndex };
    } catch {
      // frame detached/cross-origin restricted/stuck - skip
    }
  }
  return null;
}

/**
 * Purpose-built prompt for completing a follow-up modal/form revealed by a
 * final-action button (e.g. "Save Quote" -> a "Send My Quote" popup).
 * Deliberately NOT reusing askModelForNextActions's main funnel prompt:
 * found via real debugging that the model latched onto leftover "thank
 * you"/confirmation text from the ALREADY-completed page behind the modal
 * and concluded isComplete:true without ever looking at the actual new
 * form in front of it. This prompt explicitly tells it to ignore that.
 */
async function askModelToCompleteFollowUpForm(
  framesHtml: string,
  phoneNumber: string | undefined,
  // Set when the previous round's actions didn't move the form on
  correction?: string
): Promise<AiPlan> {
  if (!OPENAI_API_KEY) {
    throw new Error(
      "Missing OPENAI_API_KEY. Add it to .env.local (see .env.local.example) or export it in your shell."
    );
  }

  const systemPrompt = `You just clicked a button on an ALREADY-COMPLETED quote funnel's results page, and it revealed a secondary form or modal (e.g. "Send My Quote", a callback request, a survey booking form). Your ONLY job right now is to check whether THIS NEW form/modal has fillable input fields and a submit button that haven't been submitted yet - if so, fill and submit it.

IMPORTANT: IGNORE any pre-existing "thank you" / confirmation messaging elsewhere on the page from the funnel that already completed earlier - that is NOT relevant here and must NOT cause you to conclude nothing needs doing. Only judge based on whether there's a genuine unfilled/unsubmitted form or modal visible right now.

Decide between two outcomes:
1. NOTHING TO DO - there is no new fillable form/modal (e.g. the button just showed a static info panel with no inputs, or the form was already submitted). Set "isComplete": true and "actions": [].
2. FILL AND SUBMIT - a form/modal with input fields and a submit button is visible. Fill this exact test identity into any matching fields (even if some already show these exact values, still include them so the fill fires and its handlers run): first name "wbt", last name "support", email "${TEST_EMAIL}", phone "${phoneNumber ?? "+447366249700"}". If there's an installation address field, fill it with "10 Downing Street, London, SW1A 2AA". Check any required agreement/terms checkbox.

If this form ALSO includes a PAYMENT/CARD section (e.g. fields labeled "Card number", "Expiry"/"MM/YY", "CVC"/"CVV" - often rendered inside their own iframe by a processor like Stripe, which will show up as its own "=== FRAME N ..." section with its own input fields), fill it with this exact card - it is Stripe's own publicly documented TEST card, which Stripe deliberately rejects on any live key, so it is always safe to use and you should NEVER substitute a different number: card number "4242424242424242", expiry "04/28" (or if expiry/CVC are separate fields, expiry month "04" and year "28" or "2028"), CVC "222". If the card fields are split across a different frame than the rest of the form, still include fill actions for that frame's inputs using its own frame number.

IMPORTANT: a payment section can exist as an empty placeholder before the card processor has finished loading its fields into it (e.g. a "Pay With Card" tab/button is present and its content area is empty, or shows nothing but a submit button) - in that state there is genuinely nothing to fill yet. NEVER invent or guess plausible-looking selectors (like "#card-number" or "input[name='cardnumber']") for fields that aren't actually present anywhere in the HTML you were given - a selector must come from real markup you can see, never a guess based on what such a field is usually called. If you see a payment section but no actual card input fields anywhere in the given HTML/frames, click whatever reveals it (the payment tab/button itself, e.g. "Pay With Card") and stop there for this round - do not also try to click the final submit button yet. The card fields will be readable on a later round once they've finished loading.

Click the PRIMARY submit button (e.g. "Send Quote", "Submit", "Confirm", "Book", "Pay Now", "Pay") - never "Skip"/"Cancel"/"Close"/"Not now". Set "isComplete": false and provide these actions.

Rules:
- Every action must include "frame": the frame number from the "=== FRAME N ..." headers - a payment iframe's own fields belong to ITS frame number, not the frame of the page around it.
- AVOID ":nth-child(N)" - use Playwright's ":has-text(\"...\")" anchored to a real tag/class instead, matched on exact visible text.
- For a photo/file upload box, use "upload" with its selector - a test photo is attached automatically.
- MULTI-STEP FORMS (e.g. an "E-Survey" with contact details, then questions, then photo uploads, then Submit): you only see the CURRENT step. Complete every field and question on it - pick a sensible option for each question, upload a photo into each upload box - then click its forward button ("Next Step", "Continue", "Get Started"). The next step is handled in the next round. Only the last step's button submits.
- Reply with ONLY JSON: {"isComplete": boolean, "reasoning": string, "actions": [{"type": "check"|"fill"|"click"|"select"|"upload", "selector": string, "value"?: string, "frame": number}]}`;

  const res = await openAiFetch({
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      response_format: { type: "json_object" },
      temperature: 0,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `${correction ? `IMPORTANT: ${correction}\n\n` : ""}Current step frames:\n\n${framesHtml}`,
        },
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(`OpenAI API error ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenAI response had no content");

  return JSON.parse(content) as AiPlan;
}

/**
 * Escape alone only closes Bootstrap-style modals - found via real testing
 * that a Bulma-style modal ("modal-close-button", "modal-background") stayed
 * open behind the scenes, and its invisible overlay then swallowed the NEXT
 * final-action click ("Proceed to checkout" silently did nothing). After
 * Escape, click any still-visible close control or backdrop until none are
 * left.
 */
const MODAL_CLOSE_SELECTOR = [
  '[aria-label="close" i]',
  ".modal-close",
  ".modal-close-button",
  ".modal-background",
  ".close",
  '[data-dismiss="modal"]',
  '[data-bs-dismiss="modal"]',
]
  .map((s) => `${s}:visible`)
  .join(", ");

/**
 * Stripe renders each card field inside its own js.stripe.com iframe - found
 * via real testing that the model, reading those frames as plain HTML,
 * guessed selectors that mixed the parent page's markup with the iframe's
 * ("#card-form input[name='cardnumber']" in the Stripe frame), so nothing
 * was ever typed and checkout could never be paid. Fill them directly
 * instead. The card is Stripe's own documented test card: accepted as a fake
 * payment on a test key (pk_test_), always declined on a live key.
 */
const STRIPE_TEST_CARD_FIELDS: Array<{ label: string; selector: string; value: string }> = [
  {
    label: "card number",
    selector: 'input[name="cardnumber"], input[autocomplete="cc-number"], #Field-numberInput',
    value: "4242424242424242",
  },
  { label: "expiry", selector: 'input[name="exp-date"], input[autocomplete="cc-exp"], #Field-expiryInput', value: "0428" },
  { label: "CVC", selector: 'input[name="cvc"], input[autocomplete="cc-csc"], #Field-cvcInput', value: "222" },
  {
    label: "postcode",
    selector: 'input[name="postal"], input[autocomplete="postal-code"], #Field-postalCodeInput',
    value: "SW1A 1AA",
  },
];

function isStripeFrame(frame: Frame): boolean {
  return /js\.stripe\.com\/v3\/elements-inner/.test(frame.url());
}

async function fillStripeCardIfPresent(page: Page, log: (msg: string) => void): Promise<boolean> {
  const stripeFrames = page.frames().filter(isStripeFrame);
  if (stripeFrames.length === 0) return false;
  const filled: string[] = [];
  for (const field of STRIPE_TEST_CARD_FIELDS) {
    for (const frame of stripeFrames) {
      const input = frame.locator(field.selector).first();
      if (!(await input.isVisible().catch(() => false))) continue;
      if ((await input.inputValue().catch(() => "")).trim()) break; // already filled on an earlier round
      // Typed key by key rather than fill(): Stripe's inputs format and
      // validate on real keystrokes and ignore a value set all at once.
      await input.click({ timeout: 2000 }).catch(() => {});
      await input.pressSequentially(field.value, { delay: 30 }).catch(() => {});
      filled.push(field.label);
      break;
    }
  }
  if (filled.length > 0) {
    log(`filled Stripe ${filled.join(", ")} with Stripe's test card 4242 4242 4242 4242 (fake payment on a test key, declined on a live key)`);
  }
  return filled.length > 0;
}

// Only clicks a submit-like button that is actually on top at its own centre
// - with a modal open, the page's buttons behind it are still "visible" to
// the DOM but covered by the modal's overlay, and several of them ("Save
// quotes", "Save this boiler") match the same words as the modal's own
// submit.
const CLICK_TOPMOST_SUBMIT_SCRIPT = `
(() => {
  const ok = /\\b(send|submit|book|request|confirm|save|get|continue|pay)\\b/i;
  const bad = /skip|close|cancel|not now|back|no thanks/i;
  const els = Array.from(document.querySelectorAll('button, input[type=submit], input[type=button], [role=button], a.button, a.btn'));
  for (const el of els) {
    const text = (el.innerText || el.value || '').trim();
    if (!text || !ok.test(text) || bad.test(text)) continue;
    // Only a button inside an open pop-up - found via real testing that with
    // no modal covering the page, a results-page button ("Save quotes")
    // matched instead and opened a different form.
    if (!el.parentElement || !el.parentElement.closest('[role="dialog"], dialog[open], [aria-modal="true"], .modal, .modal-content, .modal-card, .modal-dialog, [class*="popup" i], [class*="lightbox" i]')) continue;
    let r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.top < 0 || r.bottom > innerHeight) {
      el.scrollIntoView({ block: 'center' });
      r = el.getBoundingClientRect();
    }
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (hit && (hit === el || el.contains(hit))) {
      el.click();
      return text;
    }
  }
  return null;
})()
`;

async function clickTopmostSubmitButton(page: Page): Promise<string | null> {
  for (const frame of page.frames()) {
    const clicked = (await evaluateWithTimeout(frame.evaluate(CLICK_TOPMOST_SUBMIT_SCRIPT), FRAME_READ_TIMEOUT_MS).catch(
      () => null
    )) as string | null;
    if (clicked) return clicked;
  }
  return null;
}

async function closeOpenModals(page: Page): Promise<void> {
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(300);
  for (let i = 0; i < 3; i++) {
    const closer = page.locator(MODAL_CLOSE_SELECTOR).first();
    if ((await closer.count().catch(() => 0)) === 0) return;
    await closer.click({ timeout: 1500, force: true }).catch(() => {});
    await page.waitForTimeout(300);
  }
}

// A click that timed out isn't the end: found via real testing on mobile that a
// "Book Your E-Survey" link existed 6 times on the page (header, menu, sections),
// the first was hidden behind the closed mobile menu, and the click waited on it
// until it timed out. A visitor would just tap one of the visible copies, so try
// each copy that's actually on screen, and for a link that still won't click,
// open its address the way the tap would. Returns true when one of these worked.
async function clickFallback(page: Page, frame: Frame, selector: string, notes: string[]): Promise<boolean> {
  const all = frame.locator(selector);
  const count = await all.count().catch(() => 0);
  for (let i = 0; i < count; i++) {
    const candidate = all.nth(i);
    if (!(await candidate.isVisible().catch(() => false))) continue;
    try {
      await candidate.click({ timeout: 2500 });
      notes.push(`click on "${selector}" timed out on its first match - clicked visible match ${i + 1} of ${count} instead`);
      return true;
    } catch {
      // try the next copy
    }
  }

  // Still nothing: a plain link can be followed directly
  const href = await all
    .first()
    .evaluate((el) => (el instanceof HTMLAnchorElement && el.href && !el.href.startsWith("javascript:") ? el.href : null))
    .catch(() => null);
  if (href) {
    await page.goto(href, { waitUntil: "domcontentloaded", timeout: 30000 });
    notes.push(`click on link "${selector}" couldn't be performed - opened its address ${href} directly instead`);
    return true;
  }

  // Last resort for a button: fire its click handler directly
  const clicked = await all
    .first()
    .evaluate((el) => {
      (el as HTMLElement).click();
      return true;
    })
    .catch(() => false);
  if (clicked) notes.push(`click on "${selector}" timed out - triggered it directly instead`);
  return clicked;
}

// Words in the address of a service's own pages, from its quote page's address:
// /solar-quote/ -> solar; /ashp-quote/ -> ashp, air-source, heat-pump. A "/x/"
// entry must be a whole path segment (so "ac" doesn't match "contact").
const SERVICE_PAGE_WORDS: [RegExp, string[]][] = [
  [/ashp|heat-?pump|air-?source/, ["ashp", "air-source", "heat-pump", "heatpump"]],
  [/(^|-)ac(-|$)|air-?con|cooling/, ["air-con", "aircon", "air-conditioning", "cooling", "/ac/"]],
  [/batter/, ["battery", "batteries"]],
  [/solar/, ["solar"]],
  [/boiler-repair/, ["boiler-repair", "repair"]],
  [/boiler-cover/, ["boiler-cover"]],
  [/boiler-service/, ["boiler-service", "servicing"]],
  [/boiler/, ["boiler"]],
  [/ev-?charg/, ["ev-charg"]],
  [/bathroom/, ["bathroom"]],
  [/insulation/, ["insulation"]],
  [/damp/, ["damp"]],
  [/roof/, ["roof"]],
];

function serviceWords(targetPath: string): string[] {
  const slug = targetPath.toLowerCase().replace(/\/+$/, "").split("/").pop() ?? "";
  const service = slug.replace(/-?(quote|quotes|survey|e-survey|instant-price|estimate)$/, "");
  return SERVICE_PAGE_WORDS.find(([re]) => re.test(service))?.[1] ?? (service.length >= 3 ? [service] : []);
}

// A button that starts a quote on a service's own page: "Get a quote",
// "See if your home is solar ready", "Get my price", "Book a survey"...
const QUOTE_BUTTON_TEXT = /quote|price|ready|get started|start now|check (my|your)|survey|book|enquir|find out|calculate/i;

// Links on the current page (the homepage) to the service's own page for the funnel
// at `target` - e.g. /battery-storage/ for /battery-storage-quote/ - that isn't a
// quote page itself. The service's main page first: visible links before hidden
// ones, then the shortest address.
export async function findServicePageLinks(
  page: Page,
  target: string
): Promise<{ href: string; text: string; visible: boolean; index: number }[]> {
  const home = page.url();
  const words = serviceWords(new URL(target, home).pathname);
  if (words.length === 0) return [];
  const siteHost = sameSiteHost(new URL(home).host);
  const key = (u: string) => {
    const url = new URL(u);
    return `${url.hostname.replace(/^www\./, "")}${url.pathname.replace(/\/+$/, "")}`.toLowerCase();
  };
  const candidates: { href: string; text: string; visible: boolean; index: number }[] = [];
  const links = page.locator("a[href]");
  const count = await links.count().catch(() => 0);
  for (let i = 0; i < count; i++) {
    const link = links.nth(i);
    const href = await link.getAttribute("href").catch(() => null);
    if (!href) continue;
    let url: URL;
    try {
      url = new URL(href, home);
    } catch {
      continue;
    }
    const path = url.pathname.toLowerCase();
    const segments = `/${path.replace(/^\/+|\/+$/g, "")}/`;
    if (sameSiteHost(url.host) !== siteHost || path.replace(/\/+$/, "") === "") continue;
    if (/quote|survey|price|contact|blog|news|review|privacy|terms|career|about/.test(path)) continue;
    if (!words.some((w) => (w.startsWith("/") ? segments.includes(w) : path.includes(w)))) continue;
    if (candidates.some((c) => key(c.href) === key(url.toString()))) continue;
    candidates.push({
      href: url.toString(),
      text: ((await link.textContent().catch(() => "")) ?? "").trim().slice(0, 40),
      visible: await link.isVisible().catch(() => false),
      index: i,
    });
  }
  candidates.sort((a, b) => Number(b.visible) - Number(a.visible) || new URL(a.href).pathname.length - new URL(b.href).pathname.length);
  return candidates;
}

// Pages a visitor goes through from the homepage to reach the funnel at `target`:
// the homepage's own links (hero buttons like "DAMP PROOFING", menu items) whose
// page has a link to the funnel - e.g. / -> /damp-proofing/ ("GET A QUOTE") ->
// /quick-quote/. Found by loading each candidate page's HTML in the background (no
// clicks), at most 10 of them. Pages that link to the funnel come first (service
// pages named after the funnel, e.g. /solar/ for /solar-quote/, before others),
// then service pages that don't. Empty when nothing on the homepage leads there.
export async function findLandingPagesFor(
  page: Page,
  target: string
): Promise<{ href: string; text: string; visible: boolean; index: number; linksToFunnel: boolean }[]> {
  const home = page.url();
  let targetPath: string;
  try {
    targetPath = new URL(target, home).pathname.replace(/\/+$/, "").toLowerCase();
  } catch {
    return [];
  }
  const siteHost = sameSiteHost(new URL(home).host);
  const service = await findServicePageLinks(page, target);

  // Every link on the homepage, in page order (index matches locator("a[href]").nth)
  const links = (await page
    .evaluate(() =>
      Array.from(document.querySelectorAll("a[href]")).map((a, index) => {
        const r = a.getBoundingClientRect();
        const s = getComputedStyle(a);
        return {
          href: (a as HTMLAnchorElement).href,
          text: ((a as HTMLElement).innerText || "").replace(/\s+/g, " ").trim().slice(0, 40),
          visible: r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none",
          index,
        };
      })
    )
    .catch(() => [])) as { href: string; text: string; visible: boolean; index: number }[];

  const pathOf = (u: string) => new URL(u).pathname.replace(/\/+$/, "").toLowerCase();
  const seen = new Set<string>([pathOf(home), targetPath]);
  const candidates: { href: string; text: string; visible: boolean; index: number; service: boolean }[] = [];
  for (const c of service) {
    if (seen.has(pathOf(c.href))) continue;
    seen.add(pathOf(c.href));
    candidates.push({ ...c, service: true });
  }
  for (const l of links.filter((x) => x.visible)) {
    let url: URL;
    try {
      url = new URL(l.href);
    } catch {
      continue;
    }
    const path = url.pathname.replace(/\/+$/, "").toLowerCase();
    if (!/^https?:$/.test(url.protocol) || sameSiteHost(url.host) !== siteHost || !path || seen.has(path)) continue;
    // Not where a quote journey starts
    if (/\.(pdf|jpe?g|png|webp|gif|zip)$|\/(contact|about|blog|news|reviews?|testimonials?|privacy|terms|cookie|careers?|sitemap|faqs?|gallery|team|wp-|feed|tag|category|author)/.test(path)) continue;
    seen.add(path);
    candidates.push({ href: url.toString(), text: l.text, visible: true, index: l.index, service: false });
  }

  // Which of them link to the funnel - read each page's HTML, quickest first
  const escapedPath = targetPath.replace(/[.*+?^${}()|[\]\\]/g, (ch) => `\\${ch}`);
  const linkToTarget = new RegExp(`href=["'](?:https?://[^"'/]+)?${escapedPath}/?(?:[?#][^"']*)?["']`, "i");
  const checked = await Promise.all(
    candidates.slice(0, 10).map(async (c) => {
      const html = await page
        .context()
        .request.get(c.href, { timeout: 10000 })
        .then((r) => (r.ok() ? r.text() : ""))
        .catch(() => "");
      return { ...c, linksToFunnel: linkToTarget.test(html) };
    })
  );
  const order = (c: (typeof checked)[number]) => (c.linksToFunnel ? 0 : 2) + (c.service ? 0 : 1);
  return checked
    .filter((c) => c.linksToFunnel || c.service)
    .sort((a, b) => order(a) - order(b))
    .map(({ service: _service, ...c }) => c);
}

// From the homepage, get into the funnel at `target` the way a visitor does:
// 1. click a link straight to it, if the homepage has one;
// 2. otherwise open the service's own landing page (e.g. /solar/ for /solar-quote/)
//    and click its quote button ("See if your home is solar ready");
// 3. only if neither works, open the quote page's address directly.
export async function enterFunnel(page: Page, target: string, log: (msg: string) => void): Promise<void> {
  const normalize = (u: string) => {
    try {
      const url = new URL(u, page.url());
      return `${url.hostname.replace(/^www\./, "")}${url.pathname.replace(/\/+$/, "")}`.toLowerCase();
    } catch {
      return u;
    }
  };
  const want = normalize(target);
  if (normalize(page.url()) === want) return;
  const siteHost = sameSiteHost(new URL(page.url()).host);
  const settle = async () => {
    await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(800);
  };

  // A visible link on the current page straight to the quote page
  const clickDirectLink = async (): Promise<{ entered: boolean; anyLink: boolean }> => {
    const links = page.locator("a[href]");
    const count = await links.count().catch(() => 0);
    let anyLink = false;
    for (let i = 0; i < count; i++) {
      const link = links.nth(i);
      const href = await link.getAttribute("href").catch(() => null);
      if (!href || normalize(href) !== want) continue;
      anyLink = true;
      if (!(await link.isVisible().catch(() => false))) continue;
      try {
        await link.click({ timeout: 5000 });
        await settle();
        // A link that opens a new tab, or one the site's JS swallows, leaves this
        // tab where it was - only count it once this tab is really on the funnel
        if (normalize(page.url()) === want) return { entered: true, anyLink };
      } catch {
        // try another copy of the link
      }
    }
    return { entered: false, anyLink };
  };

  const home = page.url();
  let entered = false;
  let anyLink = false;

  // 1. Through the service's own landing page first (homepage → /solar/ → its quote
  //    button → /solar-quote/), the way most visitors arrive, so that page's quote
  //    button gets tested too
  const candidates = await findLandingPagesFor(page, target);
  if (candidates.length > 0) {
    for (const landing of candidates.slice(0, 2)) {
      if (entered) break;
      if (normalize(page.url()) !== normalize(home)) {
        await page.goto(home, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
        await settle();
      }
      // Click the link like a visitor; a link hidden in a closed mobile menu is opened by its address
      const link = page.locator("a[href]").nth(landing.index);
      const clicked = landing.visible && (await link.click({ timeout: 5000 }).then(() => true).catch(() => false));
      if (!clicked) await page.goto(landing.href, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
      await settle();
      await closeOpenModals(page).catch(() => {});
      const landingPath = new URL(page.url()).pathname;
      if (normalize(page.url()) === want) {
        entered = true;
        break;
      }

      // On the service page: a link straight to the quote page...
      const onLanding = await clickDirectLink();
      anyLink = anyLink || onLanding.anyLink;
      if (onLanding.entered) {
        log(`entered the funnel like a visitor: homepage → ${landingPath} → ${new URL(page.url()).pathname}`);
        entered = true;
        break;
      }

      // ...or its quote button, which may be a button rather than a link
      const landingUrl = page.url();
      const buttons = page.locator("a, button, [role='button']").filter({ hasText: QUOTE_BUTTON_TEXT });
      const buttonCount = Math.min(await buttons.count().catch(() => 0), 12);
      for (let b = 0; b < buttonCount && !entered; b++) {
        const button = buttons.nth(b);
        if (!(await button.isVisible().catch(() => false))) continue;
        const href = (await button.getAttribute("href").catch(() => null)) ?? "";
        if (/^(tel|mailto|sms):/i.test(href)) continue;
        const text = ((await button.textContent().catch(() => "")) ?? "").trim().replace(/\s+/g, " ").slice(0, 50);
        await button.click({ timeout: 5000 }).catch(() => {});
        await settle();
        if (normalize(page.url()) === want) {
          log(`entered the funnel like a visitor: homepage → ${landingPath} → "${text}" → ${new URL(page.url()).pathname}`);
          entered = true;
        } else if (normalize(page.url()) !== normalize(landingUrl)) {
          // Went somewhere else - back to the service page for the next button
          await page.goto(landingUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
          await settle();
        }
      }
    }
  }

  // 2. No service page (or it has no way through): a link on the homepage straight to the quote page
  if (!entered) {
    if (normalize(page.url()) !== normalize(home)) {
      await page.goto(home, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
      await settle();
    }
    const direct = await clickDirectLink();
    anyLink = anyLink || direct.anyLink;
    if (direct.entered) {
      log(`entered the funnel by clicking its link on the homepage (${new URL(page.url()).pathname})`);
      entered = true;
    }
  }

  // 3. Last resort: open the quote page's address
  let response = null;
  if (!entered) {
    response = await page.goto(new URL(target, home).toString(), { waitUntil: "domcontentloaded", timeout: 30000 });
    log(
      anyLink
        ? `the link to ${target} couldn't be clicked (hidden, e.g. inside a closed mobile menu) - opened it directly`
        : `no way through to ${target} from the homepage or its service page - opened it directly`
    );
  }

  // The funnel page itself must exist. Seen in practice: the homepage's "Get a
  // quote" buttons all led to /ac-quote/, which showed "Oops! That page can't be
  // found" - the AI then hunted for the link on the 404 page and failed confusingly.
  await page.waitForTimeout(800);
  const status = response?.status() ?? 200;
  const notFoundText = await page
    .evaluate(() => {
      const title = document.title || "";
      const heading = (document.querySelector("h1")?.textContent || "").trim();
      const probe = `${title} ${heading}`;
      return /page (can.?t|cannot|could not|couldn.?t) be found|page not found|404|nothing (was )?found|doesn.?t exist/i.test(probe)
        ? (heading || title).slice(0, 120)
        : null;
    })
    .catch(() => null);
  if (status >= 400 || notFoundText) {
    throw new FunnelPageMissingError(
      `Funnel page not found: ${target} ${status >= 400 ? `answers error ${status}` : "loads but shows"}${notFoundText ? ` "${notFoundText}"` : ""}${anyLink ? " - the site's own buttons link to it, so visitors land on a broken page" : ""}`
    );
  }
}

// The page a funnel test is for doesn't exist (404 / "page not found")
class FunnelPageMissingError extends Error {}

// On a survey options page, click every option button ("E-SURVEY", "IN PERSON") and
// check each one opens something - a new page or new content. Nothing is filled
// in. Goes back to the options page between options. Returns one result each.
export async function checkSurveyOptions(
  page: Page,
  optionsUrl: string,
  screenshotDir: string,
  shotPrefix: string,
  log: (msg: string) => void,
  shouldStop: () => boolean,
  // The button that opened this page ("Book your survey") - never one of its options
  openerLabel?: string
): Promise<{ options: FinalActionResult[]; pageShot: string | null }> {
  const isOpener = (label: string) =>
    !!openerLabel && label.toLowerCase() === openerLabel.trim().replace(/\s+/g, " ").toLowerCase();
  // The options can load several seconds after the page (seen: ~5s) - keep looking
  // for up to 10 seconds. Visible, distinct options only (header links like
  // "Help" don't match the text).
  // Options can also appear one after another, so keep scanning until two scans
  // in a row find the same options
  const labels: string[] = [];
  let lastCount = -1;
  for (let attempt = 0; attempt < 10 && !(labels.length > 0 && labels.length === lastCount); attempt++) {
    lastCount = labels.length;
    await page.waitForTimeout(1000);
    const candidates = page.locator("a, button, [role='button'], input[type='submit'], input[type='button']").filter({ hasText: SURVEY_OPTION_TEXT });
    const count = Math.min(await candidates.count().catch(() => 0), 12);
    for (let k = 0; k < count; k++) {
      const c = candidates.nth(k);
      if (!(await c.isVisible().catch(() => false))) continue;
      const label = ((await c.textContent().catch(() => "")) ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
      if (label && !labels.includes(label) && !isOpener(label)) labels.push(label);
    }
  }
  if (labels.length === 0) {
    log(`no survey options found on ${optionsUrl}`);
    return { options: [], pageShot: null };
  }
  log(`survey options to check: ${labels.join(", ")}`);
  // A screenshot of the options page itself, now its buttons have loaded
  const pageShot = `${screenshotDir}/${shotPrefix}_survey_options.png`;
  const pageShotOk = await safeScreenshot(page, pageShot, log);

  const results: FinalActionResult[] = [];
  for (let n = 0; n < labels.length && n < 4; n++) {
    if (shouldStop()) break;
    const label = labels[n];
    if (normalizeUrl(page.url()) !== normalizeUrl(optionsUrl)) {
      await page.goto(optionsUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
      // Wait for this option's button to load again (up to 10s)
      await page
        .locator("a, button, [role='button']")
        .filter({ hasText: label })
        .first()
        .waitFor({ state: "visible", timeout: 10000 })
        .catch(() => {});
    }
    const textBefore = await page.evaluate(() => document.body.innerText).catch(() => "");
    const option = page
      .locator("a, button, [role='button'], input[type='submit'], input[type='button']")
      .filter({ hasText: new RegExp(`^\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i") });
    let clicked = false;
    const optionCount = await option.count().catch(() => 0);
    for (let k = 0; k < optionCount && !clicked; k++) {
      const o = option.nth(k);
      if (!(await o.isVisible().catch(() => false))) continue;
      await o.scrollIntoViewIfNeeded().catch(() => {});
      clicked = await o.click({ timeout: 5000 }).then(() => true).catch(() => o.click({ timeout: 5000, force: true }).then(() => true).catch(() => false));
    }
    await page.waitForTimeout(1500);
    await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
    const landed = page.url();
    const textAfter = await page.evaluate(() => document.body.innerText).catch(() => "");
    const opened = clicked && (normalizeUrl(landed) !== normalizeUrl(optionsUrl) || textAfter !== textBefore);
    const shot = `${screenshotDir}/${shotPrefix}_survey_option_${n + 1}.png`;
    const shotOk = await safeScreenshot(page, shot, log);
    log(`survey option "${label}" ${opened ? `opened (${landed})` : "didn't open anything"}`);
    results.push({
      label,
      selector: `text=${label}`,
      screenshot: shotOk ? shot : null,
      resultingUrl: landed,
      error: clicked ? null : `Couldn't click "${label}"`,
      warning: clicked && !opened ? `Clicked "${label}" but nothing opened` : null,
    });
  }
  return { options: results, pageShot: pageShotOk ? pageShot : null };
}

// Marks the clickable box around a visible "Request callback" text with
// data-wbt-callback="1" and returns its label, or null. A raw string so tsx
// doesn't add helpers the page doesn't have (see MARK_VISIBLE_EMPTY_UPLOADS_SCRIPT).
const MARK_CALLBACK_ITEM_SCRIPT = `
(function () {
  var re = /request (a )?call ?back|call me back/i;
  var all = document.querySelectorAll("p, span, h4, h5, a, button, div, li");
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    // The element whose own text is "Request callback" (not a big container)
    if (!re.test(el.textContent || "") || (el.textContent || "").length > 60) continue;
    var r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    var node = el;
    for (var up = 0; up < 5 && node; up++, node = node.parentElement) {
      if (node.tagName === "A" || node.tagName === "BUTTON" || node.getAttribute("onclick") ||
          node.getAttribute("data-target") || node.getAttribute("role") === "button" ||
          /modal-trigger|callback/i.test(node.className || "")) {
        document.querySelectorAll("[data-wbt-callback]").forEach(function (o) { o.removeAttribute("data-wbt-callback"); });
        node.setAttribute("data-wbt-callback", "1");
        return (node.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 40) || "Request callback";
      }
    }
  }
  return null;
})()
`;

// After "Help" opened its menu: click "Request callback" (or similar) and keep a
// screenshot of the form it opens. Nothing is filled in; the form is closed after.
// Returns its result, or null when the menu has no such item.
export async function openCallbackFromHelpMenu(
  page: Page,
  screenshotDir: string,
  shotPrefix: string,
  log: (msg: string) => void
): Promise<FinalActionResult | null> {
  await page.waitForTimeout(600);
  // Find the visible "Request callback" text, then the nearest clickable box around
  // it (seen: <div class="header-callback js-modal-trigger" onclick="openmodelpopup(this)">
  // holding "We'll call you / Request callback") - clicking the whole Help menu
  // instead just closes it
  const marked = (await page.evaluate(MARK_CALLBACK_ITEM_SCRIPT).catch(() => null)) as string | null;
  if (!marked) {
    log(`"Help" menu has no "Request callback" item`);
    return null;
  }
  const target = page.locator('[data-wbt-callback="1"]').first();
  const label = marked;
  const textBefore = await page.evaluate(() => document.body.innerText).catch(() => "");
  const clicked = await target.click({ timeout: 5000 }).then(() => true).catch(() => target.click({ timeout: 5000, force: true }).then(() => true).catch(() => false));
  await page.waitForTimeout(1500);
  const textAfter = await page.evaluate(() => document.body.innerText).catch(() => "");
  const opened = clicked && textAfter !== textBefore;
  const shot = `${screenshotDir}/${shotPrefix}_callback.png`;
  const shotOk = await safeScreenshot(page, shot, log);
  log(`"${label}" ${opened ? "opened its form (not filled in)" : "didn't open anything"}`);
  await closeOpenModals(page);
  return {
    label,
    selector: `text=${label}`,
    screenshot: shotOk ? shot : null,
    resultingUrl: page.url(),
    error: clicked ? null : `Couldn't click "${label}"`,
    warning: clicked && !opened ? `Clicked "${label}" but nothing opened` : null,
  };
}

// Same page whatever the trailing slash or #fragment
function normalizeUrl(u: string): string {
  try {
    const url = new URL(u);
    return `${url.hostname.replace(/^www\./, "")}${url.pathname.replace(/\/+$/, "")}${url.search}`.toLowerCase();
  } catch {
    return u;
  }
}

// On a phone-verification screen, press its "Send code" / "Send OTP" button so the
// site texts the code - filling an empty phone box with the test number first.
// Returns what it did, or null when there's no such button.
async function pressSendCodeButton(
  page: Page,
  phoneNumber: string | undefined,
  // A second try may only offer "Resend code"
  allowResend = false
): Promise<string | null> {
  const emptyPhone = phoneNumber ? await findEmptyPhoneField(page) : null;
  if (emptyPhone && phoneNumber) {
    await page.frames()[emptyPhone.frame].fill(emptyPhone.selector, phoneNumber, { timeout: 3000 }).catch(() => {});
  }
  const frames = page.frames();
  for (let i = 0; i < frames.length; i++) {
    const mark = await evaluateWithTimeout(
      frames[i].evaluate((resendOk) => {
        const els = Array.from(document.querySelectorAll('button, a, input[type="button"], input[type="submit"], [role="button"]'));
        for (const el of els) {
          const text = ((el as HTMLInputElement).value || el.textContent || "").trim();
          const onclick = el.getAttribute("onclick") || "";
          const looksLikeSend =
            (/\b(send|get|request|text me|resend)\b/i.test(text) && /\b(code|otp|sms|pin|verification)\b/i.test(text)) ||
            /send_?otp|sendotp|sendcode|send_?code|resend/i.test(onclick);
          if (!looksLikeSend || (!resendOk && /resend/i.test(text))) continue;
          const r = (el as HTMLElement).getBoundingClientRect();
          const s = getComputedStyle(el as HTMLElement);
          if (r.width === 0 || r.height === 0 || s.display === "none" || s.visibility === "hidden" || (el as HTMLButtonElement).disabled) continue;
          document.querySelectorAll("[data-wbt-send-code]").forEach((old) => old.removeAttribute("data-wbt-send-code"));
          el.setAttribute("data-wbt-send-code", "1");
          return text.slice(0, 40) || "send code";
        }
        return null;
      }, allowResend),
      FRAME_READ_TIMEOUT_MS
    ).catch(() => null);
    if (!mark) continue;
    const button = frames[i].locator('[data-wbt-send-code="1"]').first();
    await button.click({ timeout: 3000 }).catch(() => button.evaluate((el) => (el as HTMLElement).click()));
    return `${emptyPhone ? `filled the phone number and ` : ""}pressed "${mark}" so the site sends the SMS code`;
  }
  return null;
}

// Retry an SMS code on a different test number: replace the number in the page's
// phone box (only if it's there and editable) and press Send/Resend code again.
// Returns what it did, or null when the page doesn't allow changing the number.
async function switchPhoneNumberAndResend(page: Page, newNumber: string): Promise<string | null> {
  const frames = page.frames();
  for (let i = 0; i < frames.length; i++) {
    const found = await evaluateWithTimeout(
      frames[i].evaluate(() => {
        const fields = Array.from(
          document.querySelectorAll<HTMLInputElement>(
            'input[type="tel"], input[name*="phone" i], input[id*="phone" i], input[name*="mobile" i], input[id*="mobile" i]'
          )
        );
        for (const el of fields) {
          const r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          if (el.type === "hidden" || el.disabled || el.readOnly || r.width === 0 || r.height === 0 || s.display === "none" || s.visibility === "hidden") continue;
          document.querySelectorAll("[data-wbt-phone]").forEach((old) => old.removeAttribute("data-wbt-phone"));
          el.setAttribute("data-wbt-phone", "1");
          return true;
        }
        return false;
      }),
      FRAME_READ_TIMEOUT_MS
    ).catch(() => false);
    if (!found) continue;
    const ok = await frames[i]
      .locator('[data-wbt-phone="1"]')
      .first()
      .fill(newNumber, { timeout: 3000 })
      .then(() => true)
      .catch(() => false);
    if (!ok) return null;
    const pressed = await pressSendCodeButton(page, undefined, true);
    return pressed ? `changed the phone number to ${newNumber} and ${pressed.replace(/^pressed/, "pressed")}` : null;
  }
  return null;
}

// Fill every empty photo/file upload on screen with the test photo, without waiting
// for the AI to ask. An upload's real <input type="file"> is usually hidden inside
// a visible "Upload" box, so an input counts as on screen when it or one of its
// three nearest parents is visible. Returns how many were filled.
// A raw string, not a TS function: tsx compiles helper functions declared inside a
// function with a "__name(...)" wrapper that doesn't exist in the page, so the
// function version threw "__name is not defined" and uploaded nothing.
const MARK_VISIBLE_EMPTY_UPLOADS_SCRIPT = `
(function () {
  function shown(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    var s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
  }
  // Inside a hidden section (a later step of the form, a closed modal)
  function inHiddenSection(input) {
    for (var el = input.parentElement; el && el !== document.body; el = el.parentElement) {
      var s = getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden") return true;
    }
    return false;
  }
  var n = 0;
  var inputs = document.querySelectorAll('input[type="file"]');
  for (var i = 0; i < inputs.length; i++) {
    var input = inputs[i];
    if (input.disabled || (input.files && input.files.length > 0)) continue;
    if (inHiddenSection(input)) continue;
    var node = input;
    var visible = false;
    for (var up = 0; up < 4 && node && node !== document.body && !visible; up++, node = node.parentElement) visible = shown(node);
    if (!visible) continue;
    input.setAttribute("data-wbt-auto-upload", String(i));
    n++;
  }
  return n;
})()
`;

async function fillVisibleUploads(page: Page): Promise<number> {
  let filled = 0;
  for (const frame of page.frames()) {
    const marked = (await evaluateWithTimeout(frame.evaluate(MARK_VISIBLE_EMPTY_UPLOADS_SCRIPT), FRAME_READ_TIMEOUT_MS).catch(
      () => 0
    )) as number;
    if (!marked) continue;
    const inputs = frame.locator("[data-wbt-auto-upload]");
    const count = await inputs.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const ok = await inputs
        .nth(i)
        .setInputFiles(TEST_PHOTO_PATH)
        .then(() => true)
        .catch(() => false);
      if (ok) filled++;
      await page.waitForTimeout(300);
    }
    await frame
      .evaluate(() => document.querySelectorAll("[data-wbt-auto-upload]").forEach((el) => el.removeAttribute("data-wbt-auto-upload")))
      .catch(() => {});
  }
  return filled;
}

// Put the test photo into an upload box. Upload boxes are usually a styled label or
// div with the real <input type="file"> hidden inside or beside it: set the file on
// that input directly. Failing that, click the box - the walk's "filechooser"
// handler attaches the photo to whatever picker opens.
async function uploadTestPhoto(page: Page, frame: Frame, selector: string): Promise<void> {
  const target = frame.locator(selector).first();
  const marker = `wbt-upload-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const found = await target
    .evaluate((el, mark) => {
      // Walk up from the box until exactly one file input is in reach - stop if
      // a level holds several (that's the whole grid, not this box)
      let node: Element | null = el;
      for (let i = 0; i < 5 && node; i++, node = node.parentElement) {
        const inputs = node.matches('input[type="file"]') ? [node] : Array.from(node.querySelectorAll('input[type="file"]'));
        if (inputs.length === 1) {
          inputs[0].setAttribute("data-wbt-upload", mark);
          return true;
        }
        if (inputs.length > 1) return false;
      }
      return false;
    }, marker)
    .catch(() => false);
  if (found) {
    await frame.locator(`[data-wbt-upload="${marker}"]`).setInputFiles(TEST_PHOTO_PATH);
    return;
  }

  const chooser = page.waitForEvent("filechooser", { timeout: 4000 }).catch(() => null);
  await target.click({ timeout: 3000 }).catch(() => target.evaluate((el) => (el as HTMLElement).click()));
  if (!(await chooser)) throw new Error(`no file input or file picker found for upload box "${selector}"`);
}

// The first JavaScript error from the site's own code among `errors` (console and
// page errors), as "sendOtpToPhoneNumber is not defined (boiler-repair-quote.js line
// 527)". Errors in third-party scripts (chat widgets, trackers) don't stop the form
// and are skipped.
function findSiteCodeError(errors: string[], siteHost: string): string | null {
  const host = sameSiteHost(siteHost);
  for (const raw of errors) {
    if (!/(ReferenceError|TypeError|SyntaxError|RangeError)\b|is not defined|is not a function|Cannot read propert/i.test(raw)) continue;
    const urls = raw.match(/https?:\/\/[^\s)'"]+/g) ?? [];
    const siteUrl = urls.find((u) => {
      try {
        return sameSiteHost(new URL(u).host) === host;
      } catch {
        return false;
      }
    });
    // A console error naming only other sites' scripts isn't the site's code; one
    // naming no script at all only counts if the browser itself raised it
    if (urls.length > 0 && !siteUrl) continue;
    if (urls.length === 0 && !raw.startsWith("[pageerror]")) continue;

    const message =
      raw.match(/((?:Reference|Type|Syntax|Range)Error: [^\n]+)/)?.[1] ??
      raw.replace(/^\[(console|pageerror)\]\s*/, "").split("\n")[0];
    const loc = siteUrl?.match(/\/([^/?#]+?)(?:\?[^:]*)?:(\d+)(?::\d+)?$/);
    return `${message.replace(/^(Reference|Type|Syntax|Range)Error: /, "").trim().slice(0, 160)}${loc ? ` (${loc[1]} line ${loc[2]})` : ""}`;
  }
  return null;
}

// Open the page a walk starts on. A slow host gets a second, longer try before the
// test is failed; the errors that do end it say what's wrong in plain words.
async function openStartPage(page: Page, url: string, log: (msg: string) => void): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: attempt === 1 ? 30000 : 60000 });
      return;
    } catch (err) {
      const msg = String(err);
      if (/ERR_CERT_/i.test(msg)) {
        const kind = msg.match(/ERR_CERT_[A-Z_]+/)?.[0] ?? "ERR_CERT";
        throw new Error(
          `Site security certificate problem: ${url} ${kind === "ERR_CERT_DATE_INVALID" ? "has an expired (or not yet valid) SSL certificate" : `has an invalid SSL certificate (${kind})`} - browsers show visitors a "Your connection is not private" warning instead of the site`
        );
      }
      if (/ERR_NAME_NOT_RESOLVED/i.test(msg)) throw new Error(`Site not reachable: ${url} - its domain name doesn't resolve (DNS)`);
      if (/ERR_CONNECTION_(REFUSED|RESET|CLOSED)|ERR_EMPTY_RESPONSE/i.test(msg)) {
        if (attempt === 1) {
          log(`the site refused the connection - trying once more...`);
          continue;
        }
        throw new Error(`Site not reachable: ${url} - its server refused or dropped the connection`);
      }
      if (/Timeout/i.test(msg)) {
        if (attempt === 1) {
          log(`the site took over 30s to load - trying once more with a longer wait...`);
          continue;
        }
        throw new Error(`Site too slow: ${url} didn't load within 60 seconds (tried twice)`);
      }
      throw err;
    }
  }
}

// "#submit-btn1" that matches nothing, because the site wrote the attribute without
// its "=" (id"submit-btn1") - seen on a real form. Browsers still show and run the
// button, but it has no id. Find the element whose markup carries that id anyway
// and give it a temporary attribute to target. Returns the new selector or null.
async function recoverBrokenIdSelector(frame: Frame, selector: string): Promise<string | null> {
  const m = selector.match(/^#([\w-]+)$/);
  if (!m) return null;
  const found = await frame
    .evaluate((id) => {
      const all = Array.from(document.querySelectorAll("body *"));
      const el = all.find((e) =>
        Array.from(e.attributes).some((a) => a.name.includes(id) || (a.name !== "class" && a.value === id))
      ) as HTMLElement | undefined;
      if (!el) return false;
      el.setAttribute("data-wbt-recovered", id);
      return true;
    }, m[1])
    .catch(() => false);
  return found ? `[data-wbt-recovered="${m[1]}"]` : null;
}

function resolveFrame(page: Page, frameIndex: number | undefined): Frame {
  const frames = page.frames();
  const frame = frames[frameIndex ?? 0];
  if (!frame) {
    throw new Error(`AI referenced frame ${frameIndex}, but only ${frames.length} frame(s) exist`);
  }
  return frame;
}

export interface FinalActionResult {
  label: string;
  selector: string;
  screenshot: string | null;
  resultingUrl: string;
  error: string | null;
  warning: string | null;
  nestedActions?: FinalActionResult[];
}

const MAX_FINAL_ACTIONS = 6;
// A button on the product/results page (depth 0) that navigates to a whole
// new page (e.g. a checkout page) gets ITS buttons tested too, and so on -
// "click whatever you find and keep going" through the whole flow (upgrades
// -> checkout -> payment, however many pages that takes). Capped only to
// stop a genuine runaway (a same-site loop, or a chain far longer than any
// real checkout flow would be), not to artificially stop after one hop.
const MAX_FINAL_ACTION_DEPTH = 8;

/**
 * Asks the model to list every distinct "final action" button/link on a
 * completed funnel's results page (e.g. "Save Quote", "Secure Your Online
 * Price", "Book a Survey") - these are common on quote-comparison/product
 * result pages and are worth verifying independently, since the funnel
 * itself already "completed" by the time they're reached but they're
 * often the actual conversion points a real visitor would use.
 */
async function identifyFinalActionButtons(
  framesHtml: string
): Promise<Array<{ label: string; selector: string; selectSelector: string | null; frame: number }>> {
  if (!OPENAI_API_KEY) return [];
  try {
    const res = await openAiFetch({
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        response_format: { type: "json_object" },
        temperature: 0,
        messages: [
          {
            role: "system",
            content: `This is the final results/confirmation page of a quote funnel that just completed. List every distinct BUTTON OR LINK ACTUALLY PRESENT in the page frames given below that triggers its own separate action for the user. Common examples on this kind of page include things like "Save Quote", "Secure Your Online Price", "Book a Survey", "Buy Now", "Download Quote", "Call Us" - but those are illustrative only, NOT a checklist: only report a button if you can point to the real element for it in the HTML given, using its own actual visible text as the label. If the page has no real content or none of its buttons/links trigger a distinct action, return an empty list - do NOT invent or default to any of the example labels above just because they're common on this type of page. Skip generic navigation (header/footer links, "Back", social icons) and skip duplicate buttons that do the exact same thing repeated across multiple product cards (e.g. if the same "Buy Now" button appears once per product and there are 5 products, include it only ONCE). Give each a short human-readable label and a CSS selector: ALWAYS anchor it to the element's own tag or class first, THEN add ":has-text(\\"...\\")" matched on its exact visible text - e.g. "button.cta:has-text(\\"Save Quote\\")" or "a.buy-now:has-text(\\"Buy Now\\")", never a bare ":has-text(...)" with nothing in front of it, and never ":nth-child". If a button sits inside a product/option CARD that must first be picked/selected (e.g. a radio button, a "Select"/"Choose this" control, or the card itself needs clicking to make it the active choice) before that button's action would apply to the right item, also give "selectSelector" for that card's own select control, anchored the same way. If the button already unambiguously acts on its own specific item with no separate selection step needed, set "selectSelector" to null - do not invent an unnecessary click. Limit to at most ${MAX_FINAL_ACTIONS} buttons - pick the most distinct/important ones if there are more. Reply with ONLY JSON: {"buttons": [{"label": string, "selector": string, "selectSelector": string | null, "frame": number}]}`,
          },
          { role: "user", content: `Page frames:\n\n${framesHtml}` },
        ],
      }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return [];
    const parsed = JSON.parse(content) as {
      buttons?: Array<{ label: string; selector: string; selectSelector?: string | null; frame: number }>;
    };
    if (!Array.isArray(parsed.buttons)) return [];
    return parsed.buttons.slice(0, MAX_FINAL_ACTIONS).map((b) => ({ ...b, selectSelector: b.selectSelector ?? null }));
  } catch {
    return [];
  }
}

/**
 * Tests each final-action button found on a just-completed funnel's results
 * page, one at a time: click it, screenshot the outcome, then return to the
 * results page to try the next one from the same quote result. A button
 * that leads to a genuinely new page (e.g. "Proceed to checkout") gets its
 * OWN buttons tested the same way, recursively, following the flow through
 * however many pages it takes (upgrades -> checkout -> payment, etc.) up to
 * MAX_FINAL_ACTION_DEPTH, via the `depth` param.
 */
async function testFinalActionButtons(
  page: Page,
  screenshotDir: string,
  log: (msg: string) => void,
  phoneNumber: string | undefined,
  depth: number = 0,
  shouldStop: () => boolean = () => false
): Promise<FinalActionResult[]> {
  // A results page can open its own optional pop-up straight away (e.g. a
  // "Send my quote" form that covers a whole mobile screen) - close it so
  // the buttons are read and tested on the real page underneath.
  if (depth === 0) await closeOpenModals(page);
  const html = await getAllFramesHtml(page);
  // Found via real testing: given a nearly-empty page (e.g. a since-expired
  // or already-consumed page reached via revisiting a stale URL), the model
  // would hallucinate a full set of buttons straight from this prompt's own
  // illustrative examples ("Save Quote", "Buy Now", etc.) instead of
  // recognizing there's nothing real to find - every one then "fails" with
  // a fabricated selector, cluttering the report with noise. Skip the AI
  // call entirely rather than trust it to self-police on so little input.
  if (html.replace(/<[^>]+>/g, "").trim().length < 40) {
    log("page has little to no real content - skipping final action button testing");
    return [];
  }
  const found = await identifyFinalActionButtons(html);
  // Phone numbers ("02039620533", "Speak to our team") aren't clicked at all: a
  // call link does nothing in a test browser, and isn't part of the funnel
  // Nor are reviews, contact, email and social links - not part of the funnel
  const notTested = (b: { label: string }) => PHONE_BUTTON.test(b.label.trim()) || NOT_FUNNEL_BUTTON.test(b.label.trim());
  const skipped = found.filter(notTested);
  if (skipped.length > 0) {
    log(`not testing (phone / reviews / contact links): ${skipped.map((b) => b.label).join(", ")}`);
  }
  const buttons = found.filter((b) => !notTested(b));
  if (buttons.length === 0) {
    log("no distinct final action buttons found on the completion page to test");
    return [];
  }
  // Test "Proceed to checkout" (or equivalent) LAST. It navigates away to a
  // new page, and on sites whose results page lives only in client-side
  // state, revisiting the results URL afterward brings back the start of
  // the quiz instead - found via real testing that testing checkout first
  // made every button after it fail with "no visible element matched",
  // even though they worked fine. The other buttons mostly open in-page
  // modals, so testing them first keeps the results page intact for all
  // of them, and checkout still always gets tested.
  buttons.sort((a, b) => Number(CHECKOUT_LABEL.test(a.label)) - Number(CHECKOUT_LABEL.test(b.label)));
  log(`found ${buttons.length} final action button(s) to test: ${buttons.map((b) => b.label).join(", ")}`);

  const results: FinalActionResult[] = [];
  // The one true anchor every button gets tested from - captured ONCE here,
  // never re-derived from page.url() mid-loop. Earlier this only tracked
  // the URL from right before the PREVIOUS button's click, which drifts to
  // wherever the browser ended up if a restore ever went even slightly
  // wrong, corrupting every subsequent button's "starting point" too.
  const resultsPageUrl = page.url();
  for (let i = 0; i < buttons.length; i++) {
    if (shouldStop()) {
      log(`STOPPED by user before final action ${i + 1}/${buttons.length}`);
      break;
    }
    const btn = buttons[i];
    if (DISMISS_BUTTON.test(btn.label.trim())) {
      log(`final action ${i + 1}/${buttons.length}: "${btn.label}" only closes a pop-up - counted as working`);
      results.push({ label: btn.label, selector: btn.selector, screenshot: null, resultingUrl: page.url(), error: null, warning: null });
      continue;
    }
    log(`testing final action ${i + 1}/${buttons.length}: "${btn.label}"...`);

    // Found via real debugging: most "final action" buttons on a results
    // page (e.g. Bootstrap-style "js-modal-trigger" buttons) just open an
    // in-page modal - the URL never changes, so there's nothing to restore
    // afterward. Only a genuine navigation needs restoring, and even then
    // it can't always be trusted: this site's entire multi-step wizard
    // turned out to be a SINGLE browser history entry (no URL ever changes
    // across all its steps), so going back from a real navigation can land
    // all the way at step 1 instead of the results page.
    //
    // A prior version treated one failed restore as permanent and silently
    // skipped every remaining button for the rest of the run - found via
    // real testing that this fired too eagerly (e.g. after a genuinely
    // successful "Save Quote" submit or a completed checkout/survey flow)
    // and stopped testing buttons that would have worked fine. Each button
    // now gets its own independent restore attempt instead: if we're not
    // already on the results page, try to get back to it fresh for THIS
    // button specifically, and only skip THIS one if that fails - a later
    // button still gets its own fair shot even if an earlier restore didn't
    // pan out.
    if (i > 0 && page.url() !== resultsPageUrl) {
      try {
        await page.goto(resultsPageUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
        await page.waitForTimeout(800);
        await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {});
      } catch (err) {
        log(`could not return to the results page before testing "${btn.label}": ${err}`);
        results.push({
          label: btn.label,
          selector: btn.selector,
          screenshot: null,
          resultingUrl: page.url(),
          error: `Skipped - could not navigate back to the results page to test this button: ${err}`,
          warning: null,
        });
        continue;
      }
    }

    const urlBeforeClick = page.url();
    const textBeforeClick = await page.evaluate(() => document.body.innerText).catch(() => "");
    try {
      const frame = resolveFrame(page, btn.frame);

      const debugErrors: string[] = [];
      const onConsole = (msg: { type: () => string; text: () => string }) => {
        if (msg.type() === "error") debugErrors.push(msg.text());
      };
      const onPageError = (err: Error) => debugErrors.push(`pageerror: ${err.message}`);
      if (process.env.WBT_DEBUG_HTML) {
        try {
          const matches = await frame.locator(btn.selector).evaluateAll((els) =>
            els.map((el) => ({
              visible: (el as HTMLElement).offsetParent !== null,
              outerHTML: el.outerHTML.slice(0, 300),
            }))
          );
          log(`DEBUG "${btn.label}" selector "${btn.selector}" matches (${matches.length}): ${JSON.stringify(matches)}`);
        } catch (err) {
          log(`DEBUG could not inspect selector for "${btn.label}": ${err}`);
        }
        page.on("console", onConsole);
        page.on("pageerror", onPageError);
      }

      if (btn.selectSelector) {
        try {
          log(`selecting the product/option for "${btn.label}" first...`);
          await clickFirstVisibleMatch(frame, btn.selectSelector);
          await page.waitForTimeout(600);
        } catch (err) {
          log(`could not select the product/option for "${btn.label}" (trying the button anyway): ${err}`);
        }
      }

      // The AI's selector can point only at hidden copies of a button the page
      // repeats for each product (seen: "Book your survey" once per boiler, the
      // matched copies all hidden on mobile). Then click any visible button or
      // link with the same text instead.
      await clickFirstVisibleMatch(frame, btn.selector).catch(async (err) => {
        const label = btn.label.trim();
        const sameText = frame
          .locator("a, button, [role='button'], input[type='submit'], input[type='button']")
          .filter({ hasText: new RegExp(`^\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i") });
        const count = Math.min(await sameText.count().catch(() => 0), 20);
        for (let k = 0; k < count; k++) {
          const candidate = sameText.nth(k);
          if (!(await candidate.isVisible().catch(() => false))) continue;
          await candidate.scrollIntoViewIfNeeded().catch(() => {});
          await candidate.click({ timeout: ACTION_TIMEOUT_MS }).catch(() => candidate.click({ timeout: ACTION_TIMEOUT_MS, force: true }));
          log(`"${btn.label}" - its selector matched only hidden copies; clicked a visible "${label}" instead`);
          return;
        }
        throw err;
      });
      await page.waitForTimeout(1200);
      await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {});

      if (process.env.WBT_DEBUG_HTML) {
        page.off("console", onConsole);
        page.off("pageerror", onPageError);
        if (debugErrors.length > 0) {
          log(`DEBUG console/page errors during "${btn.label}" click: ${JSON.stringify(debugErrors.slice(0, 10))}`);
        }
      }

      // A "final action" button often just opens a secondary lead-capture
      // form/modal (e.g. "Save Quote" -> a "Send My Quote" popup with its
      // own submit button) rather than completing anything by itself -
      // reusing the same fill/submit logic the main funnel walk already
      // uses lets this verify the WHOLE action, not just that clicking it
      // revealed a form.
      let finalScreenshotPath = `${screenshotDir}/final_action_${i + 1}.png`;
      let filledFollowUpForm = false;
      // A better screenshot for this button, e.g. a survey options page once its
      // buttons had loaded (the one taken straight after the click is too early)
      let finalScreenshotOverride: string | null = null;
      // The follow-up form was filled in and then nothing was left to do (its
      // success / "sent" message showing) - the button worked, whatever small
      // hiccups happened on the way (e.g. typing into a hidden copy first)
      let followUpSucceeded = false;
      // A follow-up form can reveal itself in stages (e.g. a "Pay With Card"
      // toggle that only then loads a Stripe card iframe) - a single
      // read-plan-act pass fills whatever was visible on the FIRST read and
      // stops, missing anything that only appears after that. Loop the same
      // way the main funnel walk does: re-read, re-plan, re-act, until the
      // model says there's nothing left to fill. Capped as a backstop, but
      // the real stop condition is "same actions proposed twice in a row" -
      // found via real testing that a submit which doesn't visibly change
      // the page (a modal that stays open, a slow-to-update confirmation)
      // makes the model repeat the exact same fill-and-submit plan every
      // round, which would otherwise re-click a real "Pay"/"Submit" button
      // and create duplicate real leads/charges on every round.
      let previousActionsKey: string | null = null;
      // Distinct from filledFollowUpForm (which only proves a fill was
      // ATTEMPTED): true when the loop gave up because the model kept
      // proposing the same stuck plan, rather than because the form
      // actually reported itself complete - a form that never registered a
      // fill (e.g. a styled checkbox .check() didn't visibly tick it) looks
      // exactly like this, and needs to surface as a warning, not silently
      // pass as if nothing was wrong.
      let followUpGaveUpStuck = false;
      // applyActions() resolves with notes about anything it had to correct
      // or couldn't verify (e.g. a checkbox that never registered) - this
      // used to be silently dropped here (only the rejection path was
      // handled), so a real, honest note from applyActions never reached
      // the report for this follow-up-modal path even after it started
      // producing one.
      const followUpAllNotes: string[] = [];
      // A retry with a hint is allowed once per button, and only for a step
      // whose button just moves forward - never a real Submit/Pay/Book
      let retriedStuckStep = false;
      // Click-only buttons: survey buttons ("Book your survey", "E-Survey") and
      // "Help me choose?" only have to be clickable - the form they open isn't
      // filled in or submitted, and the buttons inside it aren't tested
      const surveyOnly = CLICK_ONLY_BUTTON.test(btn.label) || /survey/i.test(page.url());
      if (surveyOnly) log(`"${btn.label}" - only checking it can be clicked, not filling in what it opens`);
      // 8 rounds, not 3: a follow-up can be a whole multi-step form, one step per round
      for (let round = 0; round < (surveyOnly ? 0 : 8); round++) {
        // Already sent? A success message that wasn't on the page before the click
        // means the form went through. Seen in practice: a "Send my quote" pop-up
        // that stays open, still filled in, with "Quote sent successfully!" under
        // it - the AI wanted to send it again and the duplicate guard flagged it.
        if (filledFollowUpForm) {
          const textNow = await page.evaluate(() => document.body.innerText).catch(() => "");
          const success = textNow.match(FORM_SENT_TEXT)?.[0];
          // The message may already have been on the page before this button: seen
          // on a site where "Save quotes" and "Save this boiler" open the same pop-up,
          // which keeps "Quote sent successfully!" from the first send. The form has
          // just been filled in and sent, so the message showing now counts too.
          if (success) {
            const leftOver = FORM_SENT_TEXT.test(textBeforeClick) ? " (the pop-up also showed it from an earlier send)" : "";
            log(`"${btn.label}" - the form was sent ("${success.trim()}")${leftOver} - counts as working`);
            followUpSucceeded = true;
            break;
          }
        }
        // Upload boxes get the test photo straight away - found on a boiler
        // E-Survey (front of boiler, pipework, flue, tank...) that the AI never
        // reached the photos of
        const uploaded = await fillVisibleUploads(page);
        if (uploaded > 0) {
          const note = `uploaded the test photo into ${uploaded} upload box${uploaded === 1 ? "" : "es"}`;
          log(`"${btn.label}" - ${note}`);
          followUpAllNotes.push(note);
          await page.waitForTimeout(800);
        }
        const followUpHtml = await getAllFramesHtml(page);
        if (!followUpHtml.trim()) break;
        if (process.env.WBT_DEBUG_HTML) {
          require("node:fs").writeFileSync(
            `${screenshotDir}/final_${i + 1}_followup_round${round + 1}_raw.html`,
            followUpHtml
          );
          const liveValues = await page
            .evaluate(() => {
              const out: Record<string, unknown> = {};
              document.querySelectorAll("input, textarea, select").forEach((el, idx) => {
                const key = (el as HTMLElement).id || (el as HTMLInputElement).name || `el${idx}`;
                const input = el as HTMLInputElement;
                out[key] = input.type === "checkbox" || input.type === "radio" ? input.checked : input.value;
              });
              return out;
            })
            .catch(() => ({}));
          require("node:fs").writeFileSync(
            `${screenshotDir}/final_${i + 1}_followup_round${round + 1}_live_values.json`,
            JSON.stringify(liveValues, null, 2)
          );
        }
        try {
          await fillStripeCardIfPresent(page, log);
          let followUpPlan = await askModelToCompleteFollowUpForm(followUpHtml, phoneNumber);
          if (process.env.WBT_DEBUG_HTML) {
            log(`DEBUG follow-up plan round ${round + 1} for "${btn.label}": ${JSON.stringify(followUpPlan)}`);
          }
          // Card fields are handled by fillStripeCardIfPresent above - drop
          // the model's own guesses at them, which only ever miss.
          if (page.frames().some(isStripeFrame)) {
            followUpPlan.actions = followUpPlan.actions.filter(
              (a) =>
                !isStripeFrame(resolveFrame(page, a.frame)) &&
                !(a.type === "fill" && /card|cvc|cvv|exp|expiry/i.test(a.selector))
            );
          }
          if (followUpPlan.isComplete || followUpPlan.actions.length === 0) {
            // Filled in earlier and now nothing is left to do: the form was sent
            if (filledFollowUpForm) followUpSucceeded = true;
            break;
          }
          let actionsKey = JSON.stringify(followUpPlan.actions);
          // Same plan again on a step whose button only moves forward ("Next
          // Step", "Continue"): something on the step was missed. Ask once more
          // with that spelled out - safe, as nothing is submitted by a Next.
          if (actionsKey === previousActionsKey && !retriedStuckStep) {
            const lastClick = [...followUpPlan.actions].reverse().find((a) => a.type === "click");
            const buttonText = lastClick
              ? await resolveFrame(page, lastClick.frame)
                  .locator(lastClick.selector)
                  .first()
                  .evaluate((el) => ((el as HTMLInputElement).value || el.textContent || "").trim())
                  .catch(() => "")
              : "";
            const forwardOnly =
              /^(next|continue|get started|proceed|next step|go)\b/i.test(buttonText) &&
              !/submit|send|pay|book|confirm|checkout|order|reserve/i.test(buttonText);
            if (forwardOnly) {
              retriedStuckStep = true;
              log(`"${btn.label}" - "${buttonText}" didn't move the form on - asking again for what was missed...`);
              followUpPlan = await askModelToCompleteFollowUpForm(
                await getAllFramesHtml(page),
                phoneNumber,
                `Your last actions (${actionsKey.slice(0, 600)}) did NOT move this step on - it's still showing. Something required on this step was missed: read the whole step for a validation message, and make sure every question has an answer selected, every dropdown is chosen, every required checkbox is ticked and every upload box has a photo ("upload" action). Then click the forward button.`
              );
              if (followUpPlan.isComplete || followUpPlan.actions.length === 0) {
                if (filledFollowUpForm) followUpSucceeded = true;
                break;
              }
              actionsKey = JSON.stringify(followUpPlan.actions);
            }
          }
          if (actionsKey === previousActionsKey) {
            log(`"${btn.label}" - follow-up form proposed the same fill/submit again with no visible change - stopping to avoid a duplicate submission`);
            followUpGaveUpStuck = true;
            break;
          }
          previousActionsKey = actionsKey;
          log(`"${btn.label}" opened a follow-up form - completing it (round ${round + 1}): ${followUpPlan.reasoning}`);
          const roundNotes = await applyActions(page, followUpPlan.actions).catch((err) => {
            log(`follow-up form for "${btn.label}" could not be completed: ${err}`);
            return [String(err)];
          });
          // Found via real testing: the model guessed a submit button that
          // doesn't exist in the modal ("button:has-text('Submit')" where the
          // real button says something else), so the form was filled but
          // never sent. Fall back to the modal's own visible submit button.
          const missedClick = followUpPlan.actions.some(
            (a) => a.type === "click" && roundNotes.some((n) => n.includes(`"${a.selector}"`) || n.includes(` ${a.selector} `))
          );
          if (missedClick) {
            const clicked = await clickTopmostSubmitButton(page);
            if (clicked) {
              const note = `the planned submit click missed - clicked the visible "${clicked}" button instead`;
              log(`"${btn.label}" - ${note}`);
              roundNotes.push(note);
            }
          }
          if (roundNotes.length > 0) {
            log(`"${btn.label}" follow-up form round ${round + 1} - notes: ${roundNotes.join("; ")}`);
            followUpAllNotes.push(...roundNotes);
          }
          filledFollowUpForm = true;
          await page.waitForTimeout(1200);
          await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {});
          finalScreenshotPath = `${screenshotDir}/final_action_${i + 1}_followup.png`;
        } catch (err) {
          log(`follow-up check for "${btn.label}" failed: ${err}`);
          break;
        }
      }

      const screenshotOk = await safeScreenshot(page, finalScreenshotPath, log);

      // URL change is one sign of a real navigation, but some sites swap in
      // an entirely different view client-side without ever changing the
      // URL at all (found via real testing: this exact site's whole
      // multi-step quiz, AND its post-quote "checkout" step with its own
      // upsell products and buttons, all stay on one unchanging URL). The
      // clicked button's own element being gone from the DOM afterward is a
      // more reliable signal of a genuine view swap than the URL: a modal
      // opened on TOP of the page leaves the page (and the button) behind
      // it still present, while a client-side route change replaces the
      // whole view, the button included.
      //
      // BUT that presence check isn't trustworthy when we just filled and
      // submitted a follow-up form (e.g. "Save Quote"'s modal): a successful
      // submit legitimately re-renders that part of the page (a "sent!"
      // message, the modal closing), which can just as easily detach the
      // original button's DOM node as a real page swap would - found via
      // real testing that this false-positive then triggered an unreliable
      // page.goto() "restore" attempt that reset the whole quiz, cascading
      // into every later button being wrongly skipped. When a form was
      // filled, trust the URL alone; only fall back to DOM-presence when
      // nothing was filled, where it's the more reliable of the two signals.
      let landedUrl = page.url();
      let urlChanged = landedUrl !== urlBeforeClick;
      let buttonStillPresent = urlChanged || filledFollowUpForm
        ? !urlChanged
        : await frame.locator(btn.selector).count().catch(() => 0).then((c) => c > 0);
      // Found via real testing: this same button, same site, sometimes
      // swaps the view within the first check and sometimes takes several
      // more seconds (an async bot-challenge/verification step on the
      // site's side finishing at inconsistent speed) - checking only once
      // right after the click intermittently caught it too early and wrongly
      // concluded nothing had happened. Poll a while longer before giving up.
      for (let attempt = 0; attempt < 6 && !urlChanged && buttonStillPresent && !filledFollowUpForm; attempt++) {
        await page.waitForTimeout(1000);
        landedUrl = page.url();
        urlChanged = landedUrl !== urlBeforeClick;
        if (!urlChanged) {
          buttonStillPresent = await frame.locator(btn.selector).count().catch(() => 0).then((c) => c > 0);
        }
      }
      log(`"${btn.label}" -> ${landedUrl}`);
      const navigatedAway = urlChanged || !buttonStillPresent;
      let nestedActions: FinalActionResult[] | undefined;
      let warning: string | null = null;
      if (followUpGaveUpStuck) {
        warning = `The follow-up form for "${btn.label}" never actually completed - the model kept proposing the same fill/submit with no progress (e.g. a checkbox or required field that didn't register), so this was left as-is rather than risk a duplicate submission.`;
        log(`"${btn.label}" - ${warning}`);
      }
      if (followUpAllNotes.length > 0) {
        const notesText = `follow-up form action notes: ${followUpAllNotes.join("; ")}`;
        if (followUpSucceeded && !followUpGaveUpStuck) {
          // Sent in the end: the notes are just how it got there, not a problem
          log(`"${btn.label}" - form sent successfully (${notesText.slice(0, 200)})`);
        } else {
          warning = warning ? `${warning} ${notesText}` : notesText;
        }
      }
      if (!navigatedAway) {
        // For a button that doesn't navigate, open a dialog, or reveal a
        // fillable form (e.g. "Add" on an upsell/accessory item, which
        // should bump a running total shown elsewhere on the page) - a real
        // click still leaves SOME trace in the page's visible text. If it's
        // byte-identical to before, the click likely did nothing at all,
        // which the other checks above wouldn't catch since nothing
        // "failed" outright. Skipped when a follow-up form WAS filled and
        // submitted - that's already direct proof something happened, and a
        // modal that closes/auto-dismisses on success can legitimately
        // leave the page looking identical to before by the time this
        // check runs, which would otherwise be a false "no change" warning.
        if (surveyOnly) {
          // A survey button only has to be clickable - it's never filled in, so
          // the click itself counts as working, whatever it opens
          log(`"${btn.label}" - clicked (what it opens isn't filled in) - counts as working`);
          // "Help" opens a small menu: click its "Request callback" too and keep a
          // screenshot of the form it opens - nothing is filled in
          if (/^help\b/i.test(btn.label.trim())) {
            const callback = await openCallbackFromHelpMenu(page, screenshotDir, `final_action_${i + 1}`, log);
            if (callback) nestedActions = [callback];
          }
        } else if (!filledFollowUpForm && !warning) {
          const textAfterClick = await page.evaluate(() => document.body.innerText).catch(() => "");
          if (textBeforeClick && textAfterClick === textBeforeClick) {
            warning = `Clicked but the page's visible content didn't change at all afterward - it may not be doing anything (e.g. an "Add" that never updates the price shown elsewhere).`;
            log(`"${btn.label}" - ${warning}`);
          }
        }
        // Just opened a modal/overlay in place - close it so the next button
        // is clickable, no navigation-restore needed at all.
        await closeOpenModals(page);
      } else {
        // A real navigation to a distinct page on the SAME site (e.g. a
        // checkout page) is worth testing in its own right, one level
        // deeper. An external site (a review platform, a payment gateway,
        // social media) is a different story - found via real testing that
        // "Read Our Reviews" left the site for a Google Maps listing page,
        // and the model then hallucinated a full set of quote-funnel-style
        // buttons that don't exist there at all, since it had no signal
        // that this wasn't part of the funnel anymore.
        const sameSite = (() => {
          try {
            return new URL(landedUrl).hostname === new URL(urlBeforeClick).hostname;
          } catch {
            return false;
          }
        })();
        if (surveyOnly || /survey/i.test(landedUrl)) {
          // A survey options page ("How would you like to complete your survey?"
          // with E-SURVEY / IN PERSON): click each option to check it opens -
          // nothing is filled in - then come back
          log(`"${btn.label}" opened the survey page (${landedUrl}) - checking each of its options opens (not filling anything in)`);
          if (sameSite) {
            // The survey page can open a few seconds after the click (seen: options
            // were looked for while still on the results page, and "Book your survey"
            // itself was taken as an option) - wait for it to really be open
            if (!/survey/i.test(new URL(page.url()).pathname)) {
              await page.waitForURL((u) => /survey/i.test(u.pathname), { timeout: 15000 }).catch(() => {});
              await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
            }
            const optionsUrl = /survey/i.test(new URL(page.url()).pathname) ? page.url() : landedUrl;
            const survey = await checkSurveyOptions(page, optionsUrl, screenshotDir, `final_action_${i + 1}`, log, shouldStop, btn.label);
            nestedActions = survey.options;
            // Show the options page itself (taken once its buttons had loaded)
            if (survey.pageShot) finalScreenshotOverride = survey.pageShot;
            const broken = nestedActions.filter((o) => o.error || o.warning).map((o) => o.label);
            if (broken.length > 0) {
              warning = `Survey option${broken.length === 1 ? "" : "s"} didn't open: ${broken.join(", ")}`;
              log(`"${btn.label}" - ${warning}`);
            }
          }
        } else if (depth < MAX_FINAL_ACTION_DEPTH && sameSite) {
          log(`"${btn.label}" led to a new page on the same site - testing its buttons too...`);
          nestedActions = await testFinalActionButtons(page, screenshotDir, log, phoneNumber, depth + 1, shouldStop);
        } else if (depth < MAX_FINAL_ACTION_DEPTH) {
          log(`"${btn.label}" navigated to an external site (${landedUrl}) - not testing its buttons`);
        }
        // No restore attempt here anymore - the top-of-loop check at the
        // start of the NEXT iteration handles returning to resultsPageUrl
        // (using the one true anchor, not this button's possibly-drifted
        // urlBeforeClick), and only skips that one specific button if the
        // restore genuinely fails, rather than every button from here on.
      }

      results.push({
        label: btn.label,
        selector: btn.selector,
        screenshot: finalScreenshotOverride ?? (screenshotOk ? finalScreenshotPath : null),
        resultingUrl: landedUrl,
        error: null,
        warning,
        nestedActions,
      });
    } catch (err) {
      results.push({
        label: btn.label,
        selector: btn.selector,
        screenshot: null,
        resultingUrl: page.url(),
        error: String(err),
        warning: null,
      });
      log(`"${btn.label}" FAILED: ${err}`);
    }
  }
  return results;
}

/**
 * Applies each action independently and keeps going on individual
 * failures (e.g. a chat widget popup physically overlapping one checkbox
 * in a multi-select list) - a real user would just skip a blocked option
 * and continue, not abandon the whole form. Only throws if EVERY action
 * failed, meaning the AI's plan was entirely unusable on this page.
 */
async function applyActions(page: Page, plannedActions: PlannedAction[]): Promise<string[]> {
  const notes: string[] = [];
  // Never press the same answer twice - on a toggle it would un-select it again
  const actions = dropDoubleToggles(plannedActions);
  let failedCount = 0;
  // Radio groups already answered in this batch (frame index + group name).
  const answeredRadioGroups = new Set<string>();

  for (let actionIndex = 0; actionIndex < actions.length; actionIndex++) {
    const action = actions[actionIndex];
    if (action.selector) action.selector = fixDoubledQuotes(action.selector);
    try {
      const frame = resolveFrame(page, action.frame);
      // Real pages often reuse the same class across multiple steps (only
      // one visible at a time), and Playwright's non-locator click()/
      // check()/fill() silently act on the first DOM match rather than
      // erroring on ambiguity - which can silently target a hidden element
      // from a different step. Scoping to :visible avoids that regardless
      // of which selector shape the model picked.
      const visibleSelector = `${action.selector}:visible`;
      let count = await frame.locator(visibleSelector).count();
      let selector = count > 0 ? visibleSelector : action.selector;
      if (count === 0) count = await frame.locator(action.selector).count();
      if (count === 0) {
        // The plan is decided from one page read, but actually executing it
        // (a full round trip to the model) takes a couple of seconds - long
        // enough for a still-loading section of the page (e.g. a form that
        // was mid-render when read) to finish appearing by the time we get
        // here. An instant, non-waiting count() can catch that in-between
        // state and wrongly report "not found" for a field that's genuinely
        // about to exist. Give it one short bounded wait before giving up.
        const attached = await frame
          .locator(action.selector)
          .first()
          .waitFor({ state: "attached", timeout: 3000 })
          .then(() => true)
          .catch(() => false);
        if (attached) {
          count = await frame.locator(visibleSelector).count();
          selector = count > 0 ? visibleSelector : action.selector;
          if (count === 0) count = await frame.locator(action.selector).count();
        }
      }
      if (count === 0) {
        const recovered = await recoverBrokenIdSelector(frame, action.selector);
        if (recovered) {
          selector = recovered;
          count = 1;
          notes.push(`"${action.selector}" isn't a valid id on the page (its markup is broken, e.g. id"..." without "=") - used the element carrying it instead`);
        }
      }
      if (count === 0) {
        notes.push(`selector not found in frame ${action.frame ?? 0}: "${action.selector}"`);
        failedCount++;
        continue;
      }

      // Disambiguate duplicate ids/classes: found in practice that a page
      // can legitimately render the SAME id multiple times - one copy per
      // repeated section (e.g. a "Save quote" modal duplicated once per
      // product card), only one of which is genuinely open at a time. The
      // ":visible" pseudo-class count above can undercount the truly-open
      // instance during a brief render window, silently falling back to
      // the ambiguous base selector - where a plain fill()/click() then
      // waits on the FIRST DOM-order match specifically, which may never
      // be the visible one, timing out even though a LATER match genuinely
      // is visible right now. Actively probe each match for the real one
      // instead of assuming DOM order.
      if (count > 1 && selector === action.selector) {
        let resolvedIndex = -1;
        for (let attempt = 0; attempt < 3 && resolvedIndex === -1; attempt++) {
          for (let i = 1; i <= count; i++) {
            const isVisible = await frame
              .locator(`:nth-match(${action.selector}, ${i})`)
              .isVisible()
              .catch(() => false);
            if (isVisible) {
              resolvedIndex = i;
              break;
            }
          }
          if (resolvedIndex === -1 && attempt < 2) await page.waitForTimeout(400);
        }
        if (resolvedIndex !== -1) {
          selector = `:nth-match(${action.selector}, ${resolvedIndex})`;
        }
      }
      // Still on the bare selector here means every match is currently
      // hidden (e.g. a field the site already pre-filled and hid, or one of
      // several duplicate copies of a modal that isn't open). Found via real
      // testing that waiting the full action timeout on each of these cost
      // ~5s per field for elements that never became visible - give a
      // hidden-only target a short window instead.
      const actionTimeout = selector === action.selector ? 1500 : ACTION_TIMEOUT_MS;

      // Found via real testing: the model ticked all 4 answers of a
      // single-choice question. That site jumps to the next question as soon
      // as an answer is picked, so the extra clicks silently skipped the next
      // 3 questions - which then stayed unanswered and blocked the final
      // submit. Only the first answer per radio group is clicked.
      if (action.type !== "fill") {
        const radioGroup = await frame
          .locator(selector)
          .first()
          .evaluate((el) => (el instanceof HTMLInputElement && el.type === "radio" && el.name ? el.name : null))
          .catch(() => null);
        if (radioGroup) {
          const key = `${action.frame ?? 0}:${radioGroup}`;
          if (answeredRadioGroups.has(key)) {
            notes.push(`skipped "${action.selector}" - "${radioGroup}" is a single-choice question and was already answered`);
            continue;
          }
          answeredRadioGroups.add(key);
        }
      }

      // The model occasionally picks the wrong action type for a checkbox/
      // radio input - found via real testing "fill" with a truthy-looking
      // value like "true" (Playwright throws "Input of type checkbox
      // cannot be filled") and separately "select" (Playwright throws
      // "Element is not a <select> element") both used on the SAME kind of
      // required "I agree" checkbox in different runs, silently leaving it
      // unset and the form stuck either way. Rather than special-case each
      // wrong type the model might reach for, redirect ANY action type
      // targeting a genuine checkbox/radio straight to check()/uncheck().
      // An upload box, or any action the model aimed at a file input ("fill"/"click"
      // on <input type="file"> can't pick a file): attach the test photo
      const isFileInput =
        action.type === "upload" ||
        (await frame
          .locator(selector)
          .first()
          .evaluate((el) => el instanceof HTMLInputElement && el.type === "file")
          .catch(() => false));
      if (isFileInput) {
        await uploadTestPhoto(page, frame, selector);
        notes.push(`uploaded the test photo via "${selector}"`);
        if (actionIndex < actions.length - 1) await page.waitForTimeout(600);
        continue;
      }

      let handledAsCheckbox = false;
      if (action.type !== "check") {
        const inputType = await frame
          .locator(selector)
          .first()
          .evaluate((el) => (el as HTMLInputElement).type)
          .catch(() => null);
        if (inputType === "checkbox" || inputType === "radio") {
          const wantsChecked = !/^(false|0|no|off|)$/i.test((action.value ?? "true").trim());
          if (wantsChecked) {
            await frame.check(selector, { timeout: actionTimeout }).catch(async () => {
              await frame.locator(selector).first().evaluate((el) => (el as HTMLElement).click());
            });
          } else {
            await frame.uncheck(selector, { timeout: actionTimeout }).catch(() => {});
          }
          notes.push(
            `"${selector}" is a ${inputType} input, not a "${action.type}" target - treated it as a ${wantsChecked ? "check" : "uncheck"} instead`
          );
          handledAsCheckbox = true;
        }
      }

      if (!handledAsCheckbox) {
      switch (action.type) {
        case "check": {
          let usedFallback = false;
          // Some sites implement a "checkbox" as a plain <label>/<div> with
          // a CSS-only pseudo-element square and no real <input> anywhere in
          // the DOM (confirmed in practice via an HTML dump: a
          // <label class="check-container"> wrapping only text, no input) -
          // .check() is built for real checkbox/radio semantics and behaves
          // unpredictably against a target like that (sometimes silently
          // "works" depending on timing, sometimes throws "did not change
          // its state"). Detect that up front and go straight to a plain
          // click instead of gambling on .check()'s outcome against
          // something that was never a real checkbox to begin with.
          const isRealCheckable = await frame
            .locator(selector)
            .first()
            .evaluate((el) => {
              const tag = (el as HTMLElement).tagName;
              const role = (el as HTMLElement).getAttribute("role");
              if (tag === "INPUT") {
                const type = (el as HTMLInputElement).type;
                return type === "checkbox" || type === "radio";
              }
              return role === "checkbox" || role === "radio";
            })
            .catch(() => true); // unknown -> assume real, keep the existing .check() path

          // The commonest non-input target is a <label> for a real checkbox, e.g.
          // label[for='check-box'] reading "I agree with <a>terms</a> and <a>privacy
          // policy</a>". Clicking the label's middle can land on one of those links
          // instead of the box, and the read-back further down only covers <input>
          // targets, so a missed tick went unnoticed and the form refused to submit
          // ("Please confirm the checkbox above"). Tick the label's own control
          // directly and report whether it stuck.
          const labelControlChecked = isRealCheckable
            ? null
            : await frame
                .locator(selector)
                .first()
                .evaluate((el) => {
                  const control = el instanceof HTMLLabelElement ? el.control : null;
                  if (!(control instanceof HTMLInputElement) || (control.type !== "checkbox" && control.type !== "radio")) {
                    return null;
                  }
                  if (!control.checked) control.click();
                  return control.checked;
                })
                .catch(() => null);

          if (labelControlChecked !== null) {
            usedFallback = true;
            if (!labelControlChecked) {
              notes.push(
                `checkbox for label "${selector}" did not register as checked after clicking its input - the site may be silently rejecting or resetting it`
              );
            }
          } else if (!isRealCheckable) {
            await frame
              .locator(selector)
              .first()
              .click({ timeout: actionTimeout })
              .catch(async () => {
                await frame.locator(selector).first().evaluate((el) => (el as HTMLElement).click());
              });
            usedFallback = true;
          } else {
          try {
            await frame.check(selector, { timeout: actionTimeout });
          } catch (checkErr) {
            // Three common real-world patterns native .check() can't handle:
            // (1) a plain <div onclick=...> styled to look like a checkbox
            // instead of a real <input type="checkbox">, which .check()
            // rejects outright; (2) a REAL <input type="checkbox"> that's
            // intentionally visually hidden (opacity/position tricks) with
            // a custom-styled label/indicator shown instead - a very common
            // accessible-checkbox pattern, which fails .check()'s visibility
            // requirement even though the input is fully functional; (3) a
            // fixed-position widget overlapping it, same as the "click" case
            // handles. A JS .click() works for all three: it doesn't require
            // visibility or hit-testing and still fires the real change
            // event either way.
            if (
              String(checkErr).includes("Not a checkbox or radio button") ||
              String(checkErr).includes("element is not visible") ||
              String(checkErr).includes("intercepts pointer events") ||
              // A fourth real-world pattern: a genuine <input type="checkbox">
              // whose own click handler manages its "checked" state itself
              // (common in custom-styled checkboxes) rather than letting the
              // click toggle it natively - .check()'s own post-click
              // verification throws this exact message in that case, even
              // though the click landed fine. The JS .click() fallback below
              // fires the same real click/change events either way, and the
              // checkedState verification further down still catches a site
              // that genuinely rejects the check.
              String(checkErr).includes("did not change its state") ||
              // A fifth: a real but visually hidden input where .check() sits
              // "waiting for element to be visible, enabled and stable" until the
              // action timeout, so it fails with a TimeoutError rather than "not
              // visible" (seen on mobile: check #check-box, Timeout 1500ms).
              String(checkErr).includes("TimeoutError")
            ) {
              // .first(): the same selector .check() just accepted as a
              // single (possibly ambiguous) target via the legacy frame-
              // level API, which silently acts on the first DOM match
              // rather than erroring on ambiguity (see the note on
              // visibleSelector above) - the newer Locator API used here for
              // .evaluate() enforces exactly one match and throws a "strict
              // mode violation" otherwise, so .first() is required to keep
              // the same lenient behavior for a selector that legitimately
              // matches more than one element (confirmed in practice: a
              // shared "name" attribute across two same-purpose checkboxes,
              // where the real <input> is CSS-hidden so :visible can't
              // narrow it down to one).
              await frame.locator(selector).first().evaluate((el) => (el as HTMLElement).click());
              usedFallback = true;
            } else {
              throw checkErr;
            }
          }
          }
          // Neither path above actually confirms the box ended up checked -
          // found via real testing that a site can silently reject/reset a
          // checkbox (its own JS listening for something our click/check
          // didn't reproduce) while Playwright reports no error at all, so
          // "didn't throw" alone is not proof it worked. Read back the real
          // state the same way "fill" verifies inputValue() afterward - but
          // only for a genuine <input type="checkbox">, since a div-based
          // fake checkbox has no .checked property to read and "the click
          // didn't throw" is the only signal available for that shape.
          const checkedState = await frame
            .locator(selector)
            .first()
            .evaluate((el) => {
              const input = el as HTMLInputElement;
              return input instanceof HTMLInputElement && input.type === "checkbox"
                ? input.checked
                : null;
            })
            .catch(() => null);
          if (checkedState === false) {
            const isChecked = () =>
              frame
                .locator(selector)
                .first()
                .evaluate((el) => (el as HTMLInputElement).checked)
                .catch(() => null);
            if (!usedFallback) {
              await frame
                .locator(selector)
                .first()
                .evaluate((el) => (el as HTMLElement).click())
                .catch(() => {});
            }
            if ((await isChecked()) !== true) {
              // Found via real testing ("I agree" in a Save Quote modal):
              // neither check() nor a scripted click registered, because the
              // site's styled checkbox listens on its label - which is what a
              // person actually taps. Give the label one real click.
              const labelHandle = await frame
                .locator(selector)
                .first()
                .evaluateHandle((el) => (el as HTMLInputElement).labels?.[0] ?? el.closest("label") ?? el.parentElement)
                .catch(() => null);
              const label = labelHandle?.asElement();
              if (label) await label.click({ timeout: 2000, force: true }).catch(() => {});
            }
            if ((await isChecked()) !== true) {
              notes.push(
                `checkbox "${selector}" did not register as checked after check(), a JS click and a label click - the site may be silently rejecting or resetting it`
              );
            }
          }
          break;
        }
        case "fill": {
          // A readonly field (common for a "confirm your phone number"
          // step that's pre-populated from an earlier step) can't be
          // typed into by design - that's not a bug, it already has the
          // right value, so just skip the fill instead of timing out.
          const isReadonly = await frame
            .locator(selector)
            .evaluate((el) => (el as HTMLInputElement).hasAttribute("readonly"))
            .catch(() => false);
          if (isReadonly) {
            notes.push(`skipped fill on "${selector}" - field is readonly (already pre-filled)`);
          } else {
            await frame.fill(selector, action.value ?? "", {
              timeout: actionTimeout,
            });
            // Some sites reformat a field on blur (seen in practice: a phone
            // input that force-prefixes a country code without checking the
            // value already has one, turning "+15551234567" into
            // "+44+15551234567") - that corruption then silently fails the
            // site's own validation on submit. Triggering blur now, right
            // after filling, makes any such reformat happen deterministically
            // instead of firing unpredictably later (e.g. when a subsequent
            // action moves focus elsewhere), so it can be caught and reset
            // immediately rather than surfacing as an unexplained stuck form.
            await frame
              .locator(selector)
              .evaluate((el) => (el as HTMLElement).blur())
              .catch(() => {});
            const actualValue = await frame
              .locator(selector)
              .inputValue()
              .catch(() => null);
            const intendedValue = action.value ?? "";
            // Only revert when the site made the value LONGER (e.g. force-
            // prefixing a country code without checking one is already
            // there, turning "+15551234567" into "+44+15551234567") - that
            // shape is corruption, not normalization. A site that made it
            // SHORTER or the same length (e.g. stripping the "+" we typed)
            // is very likely just normalizing to whatever format its own
            // validator actually expects - found via real testing that
            // fighting that and forcing our original value back left the
            // field failing the site's own validation and getting cleared
            // on submit, when the site's own reformat would have been fine.
            if (actualValue !== null && actualValue !== intendedValue && actualValue.length > intendedValue.length) {
              await frame.locator(selector).evaluate((el, v) => {
                const input = el as HTMLInputElement;
                input.value = v;
                input.dispatchEvent(new Event("input", { bubbles: true }));
                input.dispatchEvent(new Event("change", { bubbles: true }));
              }, intendedValue);
              notes.push(
                `field "${selector}" was reformatted to "${actualValue}" after filling "${intendedValue}" - reset it back to the intended value`
              );
            } else if (actualValue !== null && actualValue !== intendedValue) {
              notes.push(
                `field "${selector}" was normalized by the site from "${intendedValue}" to "${actualValue}" - left as-is (looks like the site's own expected format)`
              );
            }
          }
          break;
        }
        case "click":
          try {
            await frame.click(selector, { timeout: actionTimeout });
          } catch (clickErr) {
            // A fixed-position widget (e.g. a chat bubble) overlapping the
            // target is a real usability issue worth surfacing, but it
            // shouldn't stop us from verifying the rest of the funnel - a
            // real visitor can often still tap through or around it, so
            // force the click through instead of giving up here.
            if (String(clickErr).includes("intercepts pointer events")) {
              // force:true would still dispatch the click at the element's
              // on-screen coordinates, which the overlay physically covers
              // - it would silently click the overlay instead. Calling the
              // DOM .click() method directly bypasses screen coordinates
              // and hit-testing entirely, invoking the real click handler.
              // .first(): with two matching buttons (header + page) the bare
              // locator threw "strict mode violation" and failed the step
              await frame.locator(selector).first().evaluate((el) => (el as HTMLElement).click());
              notes.push(
                `click on "${selector}" was blocked by an overlapping element and had to bypass it - worth checking this on the live site`
              );
            } else if (String(clickErr).includes("element is not stable")) {
              // Found via real testing on mobile: a CTA inside a looping
              // animation (slider/pulse) never holds still, so Playwright's
              // wait-until-stable check times out on every attempt even
              // though a real person can tap it fine. The DOM click doesn't
              // need the element to be still.
              await frame.locator(selector).first().evaluate((el) => (el as HTMLElement).click());
            } else if (await clickFallback(page, frame, action.selector, notes)) {
              // handled - see clickFallback
            } else {
              throw clickErr;
            }
          }
          break;
        case "select":
          try {
            await frame.locator(selector).selectOption(
              { label: action.value ?? "" },
              { timeout: actionTimeout }
            );
          } catch {
            // model may have given the option's value attribute instead of
            // its visible label - fall back to matching on that
            await frame.locator(selector).selectOption(action.value ?? "", {
              timeout: actionTimeout,
            });
          }
          break;
      }
      }
    } catch (err) {
      notes.push(`action failed (${action.type} ${action.selector} in frame ${action.frame ?? 0}): ${err}`);
      failedCount++;
    }

    // A whole batch (e.g. pick a date, check a time preference, click
    // Confirm) fires with no pause between actions by default - fine for
    // plain inputs, but found via real testing that a custom widget (a JS
    // date-picker) can visually update on click while its OWN internal
    // validation state hasn't caught up yet, so an immediate "Confirm" click
    // right after selecting a date can see it as still unselected and reject
    // the form. A brief pause between actions (not after the last one - the
    // caller's own post-batch settle wait covers that) gives each widget a
    // moment to finish reacting before the next action fires. Skipped after
    // a plain text fill: that's already set and blurred synchronously above,
    // with no widget state to catch up on - on a 5-6 field contact form the
    // pause was otherwise costing ~2s per step for nothing.
    if (actionIndex < actions.length - 1 && action.type !== "fill") {
      await page.waitForTimeout(400);
    }
  }

  if (failedCount === actions.length && actions.length > 0) {
    throw new Error(`Every action failed: ${notes.join("; ")}`);
  }
  return notes;
}

export async function walkFunnel(
  startUrl: string,
  opts: {
    screenshotDir: string;
    maxSteps?: number;
    browser?: Browser;
    viewport?: ViewportName;
    onProgress?: (message: string) => void;
    // Use this Twilio number for the whole walk instead of the next one in
    // the round-robin - lets parallel runs each keep their own number so
    // one run can never pick up another run's OTP code.
    phoneNumber?: string;
    // For a site with several funnels (boiler, heat pump, air con, solar...) the
    // walk starts on the homepage like a real visitor, and this says which one to
    // enter - usually the funnel page's URL, e.g. "https://site.co.uk/ashp-quote/".
    // Without it the model starts whichever funnel it finds first.
    entryHint?: string;
    // Checked between steps (and between results-page buttons): returning true
    // ends the walk there with failure "Stopped by user".
    shouldStop?: () => boolean;
    // After a successful submit, also click every button on the results page
    // (Save quote, Book a survey, payment...) and complete their follow-up forms.
    // Default true. False ends the walk at the submit: much quicker, and no extra
    // leads from follow-up forms.
    testFinalActions?: boolean;
    // Whether another test number may be sent a code (not blocked by Twilio, not
    // over today's limit). Without it, any other configured number may be used.
    numberAvailable?: (phoneNumber: string) => boolean;
  }
): Promise<WalkResult> {
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  const viewport = opts.viewport ?? "desktop";
  const viewportConfig = VIEWPORT_CONFIGS[viewport];
  const onProgress = opts.onProgress ?? (() => {});
  mkdirSync(opts.screenshotDir, { recursive: true });

  const twilioNumber = opts.phoneNumber ?? selectTwilioNumber();
  const shouldStop = opts.shouldStop ?? (() => false);
  // Cleared once the walk is inside the funnel (see enterFunnel below)
  let aiEntryHint = opts.entryHint;
  // Messages the site showed in browser pop-ups (alert / confirm). The test browser
  // closes them by itself, so without this the model never saw them - seen on a
  // postcode search whose "Address lookup failed" alert left it guessing for steps.
  const siteAlerts: string[] = [];
  let alertsShownToModel = 0;
  const ask = (framesHtml: string, failedAttempts: PlannedAction[][], correction?: string) => {
    const fresh = siteAlerts.slice(alertsShownToModel);
    alertsShownToModel = siteAlerts.length;
    const alertNote = fresh.length
      ? `\n\nTHE PAGE SHOWED A BROWSER POP-UP after your last actions (already closed): ${fresh.map((m) => `"${m}"`).join("; ")}. That is the site's own message - take it into account.`
      : "";
    return askModelForNextActions(framesHtml + alertNote, failedAttempts, twilioNumber, correction, aiEntryHint);
  };
  if (opts.entryHint) onProgress(`entering the funnel via the link to ${opts.entryHint}`);
  onProgress(
    twilioNumber ? `Twilio number for this run: ${twilioNumber}` : "Twilio not configured for this run"
  );

  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const steps: StepLog[] = [];
  const pendingUiChecks: Promise<void>[] = [];

  const ownBrowser = !opts.browser;
  const browser =
    opts.browser ??
    (await chromium.launch({
      headless: HEADLESS,
      channel: "chrome",
      // Reduces automation fingerprinting (e.g. the navigator.webdriver
      // flag Playwright sets by default) that bot-detection services like
      // Cloudflare check for - helps avoid false-positive blocks when
      // testing a site you're authorized to test. Not a guaranteed bypass
      // of stronger challenges, which are an intentional moving target.
      args: ["--disable-blink-features=AutomationControlled"],
    }));
  const context = await browser.newContext({
    viewport: viewportConfig.viewport,
    isMobile: viewportConfig.isMobile,
    hasTouch: viewportConfig.hasTouch,
    deviceScaleFactor: viewportConfig.deviceScaleFactor,
    userAgent: viewportConfig.userAgent,
  });
  await context.addInitScript({ content: HIDE_WEBDRIVER_SCRIPT });

  // Lets whoever manages Cloudflare/WAF for a client's site add an
  // allowlist rule ("skip challenge when this header is present") instead
  // of relying on fragile anti-fingerprinting tricks. Scoped to only the
  // site under test (via route interception, not context-wide
  // extraHTTPHeaders) - sending it to every third-party request too (fonts,
  // CDNs, analytics) makes their CORS preflight reject the request outright
  // since they don't recognize the custom header, breaking asset loading
  // that has nothing to do with the funnel itself.
  const testHost = new URL(startUrl).host;
  await context.route("**/*", (route) => {
    const reqUrl = new URL(route.request().url());
    if (sameSiteHost(reqUrl.host) === sameSiteHost(testHost)) {
      route.continue({
        headers: { ...route.request().headers(), "X-WBT-Funnel-Tester": "1" },
      });
    } else {
      route.continue();
    }
  });

  const page = await context.newPage();

  // Any click that opens a file picker (an "Upload" box) gets the test photo, the
  // way a visitor would pick one - and no native file dialog is left open
  page.on("filechooser", (chooser) => {
    chooser
      .setFiles(TEST_PHOTO_PATH)
      .then(() => onProgress("upload: attached the test photo"))
      .catch((err) => onProgress(`upload: couldn't attach the test photo (${err})`));
  });

  page.on("console", (msg: ConsoleMessage) => {
    if (msg.type() === "error") consoleErrors.push(`[console] ${msg.text()}`);
  });
  // With the first stack line, so a crash can be traced to the site's own script
  page.on("pageerror", (err) => {
    const where = (err.stack || "").split("\n").find((l) => /^\s*at /.test(l))?.trim();
    pageErrors.push(`[pageerror] ${err.name}: ${err.message}${where ? `\n    ${where}` : ""}`);
  });

  // Logs every XHR/fetch call (skips static assets like scripts/images) so
  // it's possible to see - instead of guess - whether a "Search"/lookup
  // click actually triggered a real API request and what it returned.
  const apiCalls: string[] = [];
  // apiCalls index up to which SMS-code requests have been dealt with, and how many
  // steps a Stop has waited for a code on its way (see the stop check below)
  let otpHandledAt = 0;
  let stopDeferredSteps = 0;

  // A payment gateway's publishable key reveals test vs live mode - worth
  // surfacing since accidentally completing a real payment during automated
  // testing would be a genuine financial action, not just a QA check. Checked
  // on every request regardless of resource type, since the key usually rides
  // along on a <script> tag's src (e.g. Stripe.js) rather than an XHR/fetch
  // call the other listener above already covers.
  let paymentKeyLogged = false;
  page.on("request", (req) => {
    if (paymentKeyLogged) return;
    const match = req.url().match(/pk_(test|live)_[A-Za-z0-9]+/);
    if (match) {
      paymentKeyLogged = true;
      const note = `[payment-key] Found a Stripe publishable key in ${match[1].toUpperCase()} mode (${match[0].slice(0, 12)}...) via ${req.url().slice(0, 120)}`;
      apiCalls.push(note);
      console.log(`[ai-walker] ${note}`);
    }
  });

  page.on("dialog", async (dialog) => {
    const message = dialog.message().replace(/\s+/g, " ").trim().slice(0, 200);
    if (message) {
      siteAlerts.push(message);
      log(`the page showed a pop-up message: "${message}"`);
    }
    await dialog.accept().catch(() => {});
  });

  page.on("response", async (response) => {
    const req = response.request();
    if (!["xhr", "fetch"].includes(req.resourceType())) return;
    let bodyPreview = "";
    try {
      const text = await response.text();
      bodyPreview = text.slice(0, 300);
    } catch {
      bodyPreview = "(could not read body)";
    }
    const entry = `${response.status()} ${req.method()} ${response.url()} -> ${bodyPreview}`;
    apiCalls.push(entry);
    console.log(`[ai-walker] [api] ${entry}`);
  });

  let completed = false;
  let failure: string | null = null;
  const startHost = testHost;
  let lastHtml: string | null = null;
  let attemptsOnThisPage: PlannedAction[][] = [];
  // Attempts forgotten by the last "page changed" reset below, and the URL they
  // were made on - used to catch a reset that wasn't real progress.
  let forgottenAttempts: PlannedAction[][] = [];
  let forgottenUrl = "";
  let forgottenText = "";
  let gtmPresentThroughout = true;
  let gtagPresentThroughout = true;
  let finalActions: FinalActionResult[] = [];
  // How many errors there were when the current page first appeared - errors after
  // these marks happened on the page the walk is on now
  let consoleErrorMark = 0;
  let pageErrorMark = 0;
  // A page stuck on its loading spinner gets one reload (see the WAITING handling)
  let reloadedStuckPage = false;
  const otpNumbers = new Set<string>();
  const otpOutcomes: Record<string, "received" | "missing"> = {};

  const log = (msg: string) => {
    console.log(`[ai-walker] ${msg}`);
    onProgress(msg);
  };

  log(`starting: ${startUrl} (${viewport})`);

  try {
    // "domcontentloaded" rather than "load" - see the identical fix and
    // rationale above in the screenshot-capture path: a single slow
    // third-party asset (ad/tracker/chat widget) that never fires the full
    // load event shouldn't fail a navigation to a page that's otherwise
    // fully rendered and usable.
    await openStartPage(page, startUrl, log);
    // Some embedded funnel widgets chain several sequential API calls
    // (client lookup -> embed HTML -> config -> styling -> benefits, etc.)
    // before the real form ever renders, so the very first read needs the
    // same generous wait as every later step - not a shorter one.
    await page.waitForTimeout(1200);
    await page
      .waitForLoadState("networkidle", { timeout: 4000 })
      .catch(() => {
        // real sites often have persistent background activity (chat
        // widgets, tracking pixels) that never goes fully idle - fine
      });

    // Enter the right funnel first, without leaving it to the model. Found via real
    // testing on mobile: the homepage's link to the battery funnel sat inside the
    // closed mobile menu, so the model tapped the visible "Get a quote" instead and
    // tested the solar funnel. Click a visible link to the funnel being tested; if
    // the only links are hidden, open its address the way that link would.
    if (opts.entryHint) {
      try {
        await enterFunnel(page, opts.entryHint, log);
        // Inside the funnel now: telling the AI to "click the link to <funnel>" from
        // here only made it hunt for that link on the form page and fail at step 1
        aiEntryHint = undefined;
      } catch (err) {
        if (err instanceof FunnelPageMissingError) {
          failure = err.message;
          log(`ABORT: ${failure}`);
        } else {
          log(`could not enter the funnel directly (${err}) - leaving it to the AI`);
        }
      }
    }

    for (let i = 0; i < maxSteps && !failure; i++) {
      const stepNumber = i + 1;

      if (shouldStop()) {
        // An SMS code was just requested and not entered yet: finish that first (up
        // to 2 more steps). A code sent and never used is one of the strongest
        // signs Twilio's Fraud Guard uses to block a number.
        const codeOnItsWay = apiCalls
          .slice(otpHandledAt)
          .some((c) => /^2\d\d POST \S*((send|resend|request)[-_]?(otp|code|sms|verification)|send-?sms)/i.test(c) && !/temporarily blocked|"success":\s*false/i.test(c));
        if (codeOnItsWay && stopDeferredSteps < 2) {
          stopDeferredSteps++;
          log(`step ${stepNumber} - stop requested, but an SMS code is on its way - entering it first so it isn't wasted`);
        } else {
          failure = `Stopped by user at step ${stepNumber}`;
          log(`STOPPED: ${failure}`);
          break;
        }
      }

      // "cd-me.com" redirecting to "www.cd-me.com" is the same site - comparing hosts
      // exactly stopped every test of that site on its first step
      if (sameSiteHost(new URL(page.url()).host) !== sameSiteHost(startHost)) {
        failure = `Navigated off the original site (from ${startHost} to ${page.url()}) - stopping for safety`;
        log(`ABORT: ${failure}`);
        break;
      }

      // Wrapped in a bounded retry loop for the WAITING outcome (a
      // transient "calculating your quote..." style screen with no
      // interactive elements yet) - re-reads and re-asks without consuming
      // one of the maxSteps slots, instead of the model being forced to
      // either hallucinate a click on something unrelated or return empty
      // actions and trip the "no actions" validation error.
      let plan: AiPlan | null = null;
      let waitRetries = 0;
      let aiMs = 0;
      while (true) {
        log(`step ${stepNumber}/${maxSteps} - reading page...`);
        // An address list that filled in after the last step's checks: pick it now,
        // before the AI decides the postcode search failed
        await autoSelectPopulatedDropdowns(page, log);
        // Photo upload boxes on this step get the test photo before the AI looks
        const uploadedHere = await fillVisibleUploads(page);
        if (uploadedHere > 0) {
          log(`step ${stepNumber} - uploaded the test photo into ${uploadedHere} upload box${uploadedHere === 1 ? "" : "es"}`);
          await page.waitForTimeout(800);
        }

        let html = await getAllFramesHtml(page);
        if (!html.trim()) {
          // Content still loading (e.g. a widget mid-way through several
          // chained API calls before it renders anything) - give it one more
          // moment rather than immediately telling the model there's nothing
          // there at all.
          log(`step ${stepNumber} - page looked empty, waiting and retrying read...`);
          await page.waitForTimeout(3000);
          html = await getAllFramesHtml(page);
        }
        // If the page looks identical to last iteration, nothing we did
        // actually progressed the form - keep a memory of what was tried so
        // the (stateless, per-call) model doesn't just repeat the same guess
        // forever. Once the page genuinely changes, forget old attempts.
        if (html === lastHtml) {
          // attemptsOnThisPage already holds the previous iteration's actions
          forgottenAttempts = [];
        } else {
          if (attemptsOnThisPage.length > 0 && lastHtml !== null) {
            forgottenAttempts = attemptsOnThisPage;
            forgottenUrl = page.url();
            forgottenText = mainFrameText(lastHtml);
          }
          attemptsOnThisPage = [];
          consoleErrorMark = consoleErrors.length;
          pageErrorMark = pageErrors.length;
        }
        lastHtml = html;

        if (process.env.WBT_DEBUG_HTML) {
          require("node:fs").writeFileSync(`${opts.screenshotDir}/${stepNumber}_raw.html`, html);
          const liveValues = await page
            .evaluate(() => {
              const out: Record<string, unknown> = {};
              document.querySelectorAll("input, textarea, select").forEach((el, i) => {
                const key = (el as HTMLElement).id || (el as HTMLInputElement).name || `el${i}`;
                const input = el as HTMLInputElement;
                out[key] = input.type === "checkbox" || input.type === "radio" ? input.checked : input.value;
              });
              return out;
            })
            .catch(() => ({}));
          require("node:fs").writeFileSync(
            `${opts.screenshotDir}/${stepNumber}_live_values.json`,
            JSON.stringify(liveValues, null, 2)
          );
        }

        const aiStart = Date.now();
        try {
          log(`step ${stepNumber} - asking AI what to do...`);
          plan = await ask(html, attemptsOnThisPage);
          // An exact-HTML match is too strict to tell "same page" on its own: a
          // chat widget or tracking iframe changing its URL, or an error message
          // flickering, makes the HTML differ even though nothing progressed. Seen
          // on mobile: the memory reset every step, so the model re-searched the
          // same postcode 17 times and ran out of steps instead of trying the
          // fallback or calling it BLOCKED. If it now wants to repeat something it
          // already tried on this same URL, it hasn't moved on - restore the memory
          // and ask again.
          // But the visible page text must be the same too: one-page multi-question
          // forms keep the same URL, and two questions in a row can share an answer
          // ("Ground floor rooms?" 1, then "External doors?" 1) - same click, new
          // question. Treating that as stuck confused the model into giving up.
          const sameActions = (a: PlannedAction[], b: PlannedAction[]) => JSON.stringify(a) === JSON.stringify(b);
          if (
            attemptsOnThisPage.length === 0 &&
            forgottenAttempts.length > 0 &&
            page.url() === forgottenUrl &&
            mainFrameText(html) === forgottenText &&
            plan.actions.length > 0 &&
            forgottenAttempts.some((tried) => sameActions(tried, plan!.actions))
          ) {
            log(
              `step ${stepNumber} - AI wants to repeat actions already tried on this page (the HTML changed but nothing progressed) - re-asking with that history...`
            );
            attemptsOnThisPage = forgottenAttempts;
            forgottenAttempts = [];
            plan = await ask(html, attemptsOnThisPage);
          }
          // Seen in practice on number-answer questions (rooms: 1, 2, 3...): the
          // model garbled the quotes around the number and returned the same
          // click many times with a broken selector (".box.all-option.m-2:has-text("),
          // so every action failed and the walk ended. Check the plan before
          // running it and send it back once with the problem spelled out.
          const planProblems = describePlanProblems(plan.actions ?? []);
          if (planProblems) {
            log(`step ${stepNumber} - AI's actions are malformed (${planProblems}) - re-asking with a correction...`);
            plan = await ask(
              html,
              attemptsOnThisPage,
              `Your previous answer had malformed actions: ${planProblems}. Give each action once, with a complete selector. For an option whose visible text is a number or a short word, wrap the text in SINGLE quotes, e.g. ".box.all-option:has-text('1')" - never leave a selector ending in ":has-text(". Pick exactly one answer per question.`
            );
            // Still broken: drop the unusable actions rather than fail on them
            const stillBad = describePlanProblems(plan.actions ?? []);
            if (stillBad && Array.isArray(plan.actions)) {
              const usable = dedupeActions(plan.actions.filter((a) => !selectorProblem(a.selector)));
              log(`step ${stepNumber} - actions still malformed after correction (${stillBad}) - keeping ${usable.length} usable action(s)`);
              plan.actions = usable;
            }
          }
          // Seen in practice: on a "Confirm your phone number" step the model
          // clicked "Send Verification Code" with the number box still empty - the
          // site just said "please enter a valid phone number", no SMS was sent, and
          // the walk then waited for a code that could never come. If a send/verify
          // click is planned while a visible phone box is empty, fill it first.
          const sendsCode = (plan.actions ?? []).some(
            (a) => a.type === "click" && /otp|verif|send.?code|send.?sms|code/i.test(a.selector)
          );
          if (sendsCode) {
            const emptyPhone = await findEmptyPhoneField(page);
            if (emptyPhone && !plan.actions.some((a) => a.type === "fill" && a.selector === emptyPhone.selector)) {
              const testPhone = twilioNumber ?? "+447366249700";
              log(`step ${stepNumber} - a "send code" click is planned but the phone box ${emptyPhone.selector} is empty - filling ${testPhone} first`);
              plan.actions = [{ type: "fill", selector: emptyPhone.selector, value: testPhone, frame: emptyPhone.frame }, ...plan.actions];
            }
          }
          // Seen in practice: the model's own reasoning correctly says "no OTP
          // input exists yet, send the code first" while its structured output
          // still sets needsOtp with no field selectors and empty actions -
          // its reasoning and its decision contradict each other. Rather than
          // silently getting stuck (empty actions, nothing to fill), force one
          // corrective re-ask that spells out the contradiction directly.
          if (plan.needsOtp && (!plan.otpFieldSelectors || plan.otpFieldSelectors.length === 0)) {
            log(
              `step ${stepNumber} - AI said needsOtp but gave no OTP field selectors (no input exists yet) - re-asking with a correction...`
            );
            plan = await ask(
              html,
              attemptsOnThisPage,
              `You just set "needsOtp": true but gave no "otpFieldSelectors" - that means no OTP input field actually exists on this page yet, so this is NOT the NEEDS_OTP case. Re-examine the page: find and click whatever button starts the verification process (e.g. "Send Code", "Verify Phone", "Confirm") - set "needsOtp": false and provide that click in "actions" instead.`
            );
          }
          // Found via real testing: after a single postcode search whose
          // click missed the actual Search button (so no lookup ever ran),
          // the model declared the page BLOCKED claiming "both postcode
          // attempts failed" when only one had been made - skipping the
          // retry its own rules require. BLOCKED is only legitimate once the
          // step has genuinely been retried, so push back once before
          // accepting it.
          if (plan.isBlocked && attemptsOnThisPage.length < 2) {
            log(
              `step ${stepNumber} - AI said BLOCKED after only ${attemptsOnThisPage.length} attempt(s) on this page - re-asking with a correction...`
            );
            plan = await ask(
              html,
              attemptsOnThisPage,
              `You marked this step BLOCKED, but it has only been attempted ${attemptsOnThisPage.length} time(s) on this page, so the retry rules have NOT been exhausted yet. Look again: if a search/lookup (e.g. a postcode) produced no results, retry it - using the fallback value only where the rules say so - and make sure your click targets the actual search/lookup button right next to that field (use its exact visible text, e.g. ':has-text("Search")'), not a generic class shared with other buttons. If a dropdown now has real options, select one instead. Set "isBlocked": false and provide those actions.`
            );
          }
          // A prose rule alone isn't reliable enough for this - found via
          // real testing that the model can still miss an already-appeared
          // "Next"/"Continue" button and repeat a search instead (e.g. a
          // map-based address step with no dropdown at all, where the map
          // visually updating isn't something a text-only HTML read can
          // perceive the way a screenshot would). Only check this on a
          // REPEAT attempt at the same page (attemptsOnThisPage non-empty) -
          // a first-time read where "Next" sits next to fields still being
          // filled in is completely normal and shouldn't be forced early.
          if (attemptsOnThisPage.length > 0 && !plan.isComplete && !plan.isBlocked) {
            const forwardHint = await findForwardButtonHint(page);
            if (forwardHint) {
              const alreadyClicksIt = plan.actions.some(
                (a) =>
                  a.type === "click" &&
                  a.selector === forwardHint.selector &&
                  (a.frame ?? 0) === forwardHint.frame
              );
              if (!alreadyClicksIt) {
                log(
                  `step ${stepNumber} - a forward button ("${forwardHint.label}") is present but the plan doesn't click it after ${attemptsOnThisPage.length} attempt(s) on this page - re-asking with a correction...`
                );
                plan = await ask(
                  html,
                  attemptsOnThisPage,
                  `A "${forwardHint.label}" button is visible and enabled on this page right now (selector "${forwardHint.selector}" in frame ${forwardHint.frame}) - since you've already attempted this exact step ${attemptsOnThisPage.length} time(s) before without it progressing, this button appearing means your previous action already succeeded. Click this exact button now instead of repeating a fill/search - set "isComplete": false, "isBlocked": false, and include ONLY this click (plus any other genuinely still-empty required fields on THIS page, if any) in "actions".`
                );
              }
            }
          }
          aiMs += Date.now() - aiStart;
          log(`step ${stepNumber} - AI: ${plan.reasoning}`);
        } catch (err) {
          failure = `AI planning failed at step ${stepNumber}: ${err}`;
          log(`ABORT: ${failure}`);
          break;
        }

        if (plan.isWaiting) {
          if (waitRetries < MAX_WAIT_RETRIES) {
            waitRetries++;
            log(
              `step ${stepNumber} - page is still loading/calculating (no interactive elements yet), waiting and re-reading (${waitRetries}/${MAX_WAIT_RETRIES})...`
            );
            await page.waitForTimeout(3000);
            continue;
          }
          // Stuck on a spinner while entering the funnel (seen: the quote widget
          // never started after a site pop-up got in the way): reload the page once
          // and wait again. Only in the first few steps, before anything has been
          // submitted, so a reload can never send a form twice.
          if (!reloadedStuckPage && stepNumber <= 3) {
            reloadedStuckPage = true;
            waitRetries = 0;
            log(`step ${stepNumber} - the page is still only loading - reloading it once and trying again...`);
            await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
            await page.waitForTimeout(2000);
            await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
            await closeOpenModals(page);
            continue;
          }
          plan.isBlocked = true;
          plan.reasoning = `Page never finished loading/calculating after ${MAX_WAIT_RETRIES} wait retries${reloadedStuckPage ? " and a reload" : ""} - no interactive elements ever appeared. Original reasoning: ${plan.reasoning}`;
        }
        break;
      }

      if (failure) break;
      if (!plan) break; // unreachable in practice - satisfies TypeScript

      if (plan.isComplete || plan.isBlocked) {
        completed = plan.isComplete === true;
        const screenshotPath = `${opts.screenshotDir}/${stepNumber}_${plan.isComplete ? "complete" : "blocked"}.png`;
        const { tracking, uiIssues } = await screenshotAndAnalyze(
          page,
          screenshotPath,
          viewport,
          log,
          `step ${stepNumber}`,
          pendingUiChecks
        );
        if (!tracking.gtmPresent) gtmPresentThroughout = false;
        if (!tracking.gtagPresent) gtagPresentThroughout = false;
        if (plan.isComplete) {
          log(`step ${stepNumber} - COMPLETE`);
        } else {
          // The site's own pop-up message is usually the real reason - keep the latest
          const siteSaid = siteAlerts.length ? ` | Site message: "${siteAlerts[siteAlerts.length - 1]}"` : "";
          failure = `Blocked at step ${stepNumber}: ${plan.reasoning}${siteSaid}`;
          log(`step ${stepNumber} - BLOCKED: ${plan.reasoning}${siteSaid}`);
        }
        log(`step ${stepNumber} - tracking: GTM=${tracking.gtmPresent} gtag=${tracking.gtagPresent}`);
        steps.push({
          stepNumber,
          url: page.url(),
          reasoning: plan.reasoning,
          actions: [],
          actionWarnings: [],
          screenshot: screenshotPath,
          tracking,
          uiIssues,
        });
        if (plan.isComplete && opts.testFinalActions !== false) {
          finalActions = await testFinalActionButtons(page, opts.screenshotDir, log, twilioNumber, 0, shouldStop);
        } else if (plan.isComplete) {
          log(`step ${stepNumber} - form submitted; finishing here (results-page buttons not tested)`);
        }
        break;
      }

      if (plan.needsOtp) {
        // Code boxes on screen don't mean a code was sent. Seen in practice on a
        // "Phone Verification" page with the boxes AND a "Send code" button: the
        // model went straight to waiting, the site was never asked to text a code,
        // and every attempt timed out. If no send-code request has gone out yet,
        // press that button first (filling an empty phone box if there is one).
        const codeRequested = apiCalls.some((c) => /^\d{3} POST \S*(otp|verif|sms|send-?code)/i.test(c));
        if (!codeRequested) {
          const pressed = await pressSendCodeButton(page, twilioNumber);
          if (pressed) {
            log(`step ${stepNumber} - no code had been requested yet - ${pressed}`);
            await page.waitForTimeout(2500);
          }
        }
        log(`step ${stepNumber} - OTP verification screen detected, fetching code from Twilio...`);
        // A couple of minutes' buffer rather than "now" - the SMS was
        // actually sent by a click in the PREVIOUS step, slightly before
        // this screen appeared, and a little slack is harmless since we
        // also filter by digit pattern in the message body.
        const sinceIso = new Date(Date.now() - 2 * 60 * 1000).toISOString();
        if (twilioNumber) otpNumbers.add(twilioNumber);
        // The site's send-code request was refused because Twilio has blocked this
        // number: no code can come, so don't wait for one - go straight to the other number
        const lastSendCall = [...apiCalls].reverse().find((c) => /^\d{3} POST \S*(send-?otp|send-?code|sms)/i.test(c));
        const numberBlocked = !!lastSendCall && /temporarily blocked/i.test(lastSendCall);
        if (numberBlocked) {
          log(`step ${stepNumber} - the site says Twilio has blocked ${twilioNumber} - not waiting for a code, switching number`);
        }
        let { code, blocked: otpBlocked } = numberBlocked
          ? { code: null as string | null, blocked: false }
          : await fetchOtpFromTwilio(sinceIso, twilioNumber, log);
        if (twilioNumber && !otpBlocked) otpOutcomes[twilioNumber] = code ? "received" : "missing";

        // Nothing arrived: if the page lets the number be changed, try once more on
        // the other test number - in case the site or a carrier is blocking this one.
        // Never a number Twilio has blocked: a refused send keeps it blocked longer.
        const numberAvailable = opts.numberAvailable ?? (() => true);
        const otherNumber = TWILIO_PHONE_NUMBERS.find((n) => n !== twilioNumber && numberAvailable(n));
        if (!code && !otpBlocked && otherNumber && !shouldStop()) {
          const switched = await switchPhoneNumberAndResend(page, otherNumber);
          if (switched) {
            log(`step ${stepNumber} - no code reached ${twilioNumber} - ${switched}`);
            otpNumbers.add(otherNumber);
            await page.waitForTimeout(2500);
            ({ code, blocked: otpBlocked } = await fetchOtpFromTwilio(new Date(Date.now() - 30 * 1000).toISOString(), otherNumber, log));
            if (!otpBlocked) otpOutcomes[otherNumber] = code ? "received" : "missing";
            if (code) log(`step ${stepNumber} - the code arrived on the second number ${otherNumber}`);
          } else {
            // The number is locked on this page (seen: a read-only phone box). No
            // "Resend" to the same number: a second code to a number whose first one
            // never arrived is exactly what gets it blocked by Twilio's Fraud Guard.
            log(`step ${stepNumber} - no code reached ${twilioNumber} and the number can't be changed here - not asking for another code`);
          }
        }
        // The code this step asked for has been dealt with - a Stop can take effect now
        otpHandledAt = apiCalls.length;

        const otpActions: PlannedAction[] = [];
        if (code && plan.otpFieldSelectors && plan.otpFieldSelectors.length > 0) {
          if (plan.otpFieldSelectors.length === 1) {
            otpActions.push({
              type: "fill",
              selector: plan.otpFieldSelectors[0],
              value: code,
              frame: plan.otpFrame,
            });
          } else {
            for (let i = 0; i < plan.otpFieldSelectors.length && i < code.length; i++) {
              otpActions.push({
                type: "fill",
                selector: plan.otpFieldSelectors[i],
                value: code[i],
                frame: plan.otpFrame,
              });
            }
          }
          if (plan.otpSubmitSelector) {
            // The model guesses this selector from one page read and
            // sometimes names an element that doesn't exist (found via
            // real testing: "button[type=submit]" on a form whose Verify
            // button is type="button") - the click then silently misses
            // and the code is never submitted. Fall back to the visible
            // button labelled like a verify/submit action.
            const submitMatches = await resolveFrame(page, plan.otpFrame)
              .locator(`${plan.otpSubmitSelector}:visible`)
              .count()
              .catch(() => 0);
            const submitSelector =
              submitMatches > 0
                ? plan.otpSubmitSelector
                : `button:text-matches("verify|confirm|continue|submit", "i")`;
            if (submitMatches === 0) {
              log(
                `step ${stepNumber} - OTP submit selector "${plan.otpSubmitSelector}" matched nothing visible - using the visible Verify/Confirm/Continue/Submit button instead`
              );
            }
            otpActions.push({ type: "click", selector: submitSelector, frame: plan.otpFrame });
          }
        }

        let otpWarnings: string[] = [];
        if (!code && otpBlocked) {
          failure = `OTP blocked at step ${stepNumber} by Twilio's content filter (Error 30038) - the site sent the code but Twilio removed the digits before it reached us. Needs Twilio to allow inbound OTP messages on this account; not a site or code issue.`;
          log(`ABORT: ${failure}`);
        } else if (!code) {
          // The site's own "send code" request, if one was seen, says which side failed
          const sendCall = [...apiCalls]
            .reverse()
            .find((c) => /^\d{3} POST \S*(otp|verif|sms|send-?code)/i.test(c));
          const sendStatus = sendCall ? Number(sendCall.slice(0, 3)) : null;
          const sendOk = sendCall ? sendStatus! < 400 && !/"success"\s*:\s*false|"error"/i.test(sendCall) : null;
          const sendNote =
            sendOk === true
              ? " The site's send-code request reported success, so the SMS was lost between the site's SMS provider and the number"
              : sendOk === false
                ? ` The site's own send-code request failed (${sendCall!.slice(0, 160)})`
                : "";
          failure = twilioNumber
            ? `OTP required at step ${stepNumber} but no code arrived: the site asked for an SMS code, but none reached ${twilioNumber} in time - the site's SMS sending may be broken, or it is limiting repeat requests.${sendNote}`
            : `OTP required at step ${stepNumber} but no code arrived: Twilio is not configured in the funnel tester, so SMS codes can't be received`;
          log(`ABORT: ${failure}`);
        } else if (otpActions.length === 0) {
          failure = `OTP code ${code} received but the AI didn't provide field selectors to enter it`;
          log(`ABORT: ${failure}`);
        } else {
          try {
            otpWarnings = await applyActions(page, otpActions);
            await page.waitForTimeout(1200);
            await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {});
            // Sites verify the code with an async request that can take
            // several seconds - found via real testing that reading the page
            // straight after the normal settle still caught the code screen
            // mid-verification, so the next step re-filled and re-submitted
            // the same code, then crashed when the screen finally swapped
            // to the results page under it. Wait for the code input to go
            // away before moving on.
            const otpFrame = resolveFrame(page, plan.otpFrame);
            const firstOtpSelector = plan.otpFieldSelectors![0];
            let otpScreenGone = false;
            for (let i = 0; i < 15; i++) {
              const stillVisible = await otpFrame
                .locator(firstOtpSelector)
                .first()
                .isVisible()
                .catch(() => false);
              if (!stillVisible) {
                otpScreenGone = true;
                break;
              }
              await page.waitForTimeout(1000);
            }
            if (!otpScreenGone) {
              const note = `the OTP screen was still showing 15s after submitting code ${code} - the site may have rejected it`;
              log(`step ${stepNumber} - ${note}`);
              otpWarnings = [...otpWarnings, note];
            }
          } catch (err) {
            // Same stale-plan case as a normal step: every OTP selector gone
            // by execution time because the site already verified the code
            // and moved on - that's a success, not a crash.
            const isTotalSelectorMiss = /Every action failed/.test(String(err));
            const currentHtml = isTotalSelectorMiss ? await getAllFramesHtml(page).catch(() => "") : "";
            if (isTotalSelectorMiss && currentHtml && currentHtml !== lastHtml) {
              const note = `the OTP fields were gone by the time the code was entered, but the page had already changed since it was read (code likely already accepted) - treated as advanced, not a failure`;
              log(`step ${stepNumber} - ${note}`);
              otpWarnings = [note];
            } else {
              failure = `Failed to submit OTP code at step ${stepNumber}: ${err}`;
              log(`ABORT: ${failure}`);
            }
          }
        }

        const screenshotPath = `${opts.screenshotDir}/${stepNumber}_otp.png`;
        const { tracking, uiIssues } = await screenshotAndAnalyze(
          page,
          screenshotPath,
          viewport,
          log,
          `step ${stepNumber}`,
          pendingUiChecks
        );
        if (!tracking.gtmPresent) gtmPresentThroughout = false;
        if (!tracking.gtagPresent) gtagPresentThroughout = false;
        steps.push({
          stepNumber,
          url: page.url(),
          reasoning: plan.reasoning,
          actions: otpActions,
          actionWarnings: otpWarnings,
          screenshot: screenshotPath,
          tracking,
          uiIssues,
        });

        if (failure) break;
        continue;
      }

      attemptsOnThisPage = [...attemptsOnThisPage, plan.actions];
      log(`step ${stepNumber} - actions: ${JSON.stringify(plan.actions)}`);

      let actionWarnings: string[] = [];
      const actionsStart = Date.now();
      let actionsMs = 0;
      try {
        actionWarnings = await applyActions(page, plan.actions);
        actionsMs = Date.now() - actionsStart;
        if (actionWarnings.length > 0) {
          log(`step ${stepNumber} - warnings: ${actionWarnings.join("; ")}`);
        }
        // Real sites vary too much to reliably detect "step advanced" via
        // URL changes - a top-level navigation, an SPA-style iframe widget
        // that never changes its URL between steps, or a same-URL re-render
        // are all common. A settle delay plus best-effort networkidle covers
        // all three without depending on any single signal. Generous after
        // a fill, because that's what triggers slow third-party lookups
        // (address/postcode APIs). After a plain click it's capped much
        // shorter: sites with constant background traffic (analytics,
        // chat widgets) never reach networkidle, and measured runs showed
        // click-only steps burning the full 4s cap on almost every step.
        const hadFill = plan.actions.some((a) => a.type === "fill");
        await page.waitForTimeout(hadFill ? 1200 : 800);
        await page.waitForLoadState("networkidle", { timeout: hadFill ? 4000 : 1500 }).catch(() => {
          // persistent background activity on real sites - fine, proceed anyway
        });
        // networkidle can come back clean while the page is still showing its
        // OWN "Calculating your quote... Fetching fixed prices..." interstitial
        // (its background requests finished, but the UI swap to the real
        // results page hasn't happened yet) - found via real testing that
        // reading right then can still catch the previous, about-to-be-
        // replaced form's markup, leading the model to re-plan a fill/submit
        // for fields that vanish by the time we execute (a real submit
        // wrongly reported as a crash). Poll a bit longer specifically for
        // that visible wording before trusting the next read.
        for (let i = 0; i < 5; i++) {
          const stillLoading = await page
            .evaluate(() => /calculating|fetching (fixed )?prices|please wait|loading your/i.test(document.body.innerText))
            .catch(() => false);
          if (!stillLoading) break;
          await page.waitForTimeout(1500);
        }
        // Only after a "fill" - that's the signature of a search/lookup
        // interaction (postcode, address, etc.) that might have just
        // populated a results dropdown elsewhere on the page.
        if (plan.actions.some((a) => a.type === "fill")) {
          await waitForEmptyDropdownsToPopulate(page, 5000);
          const picked = await autoSelectPopulatedDropdowns(page, log);
          // A postcode was searched but no list was ready yet: give it a few more seconds
          if (picked === 0 && plan.actions.some((a) => a.type === "fill" && UK_POSTCODE.test((a.value ?? "").trim()))) {
            await waitAndPickAddress(page, log);
          }
        }
      } catch (err) {
        // "Every action failed" (all selectors missing, not just one) after a
        // fill-heavy plan (e.g. a contact-form submit) most often means the
        // plan was already stale by the time we got to execute it - the site
        // had moved on to its NEXT page before we could act, so naturally
        // none of the old fields exist anymore. That's a real submit wrongly
        // reported as a crash, not a genuine bug - confirmed by checking
        // whether the live page has actually changed since this plan was
        // made. Only treat it as a real failure when the page looks the same
        // as when we read it (a genuinely broken/missing form).
        const isTotalSelectorMiss = /Every action failed/.test(String(err));
        const currentHtml = isTotalSelectorMiss ? await getAllFramesHtml(page).catch(() => "") : "";
        if (isTotalSelectorMiss && currentHtml && currentHtml !== lastHtml) {
          const note = `every selector in this plan was gone by execution time, but the page had already changed since it was read (likely already submitted/advanced) - treated as stale, not a failure: ${err}`;
          log(`step ${stepNumber} - ${note}`);
          actionWarnings = [note];
        } else {
          failure = `Action execution failed at step ${stepNumber} (${JSON.stringify(
            plan.actions
          )}): ${err}`;
          log(`step ${stepNumber} - FAILED: ${failure}`);
        }
      }

      const settleMs = Date.now() - actionsStart - actionsMs;
      const screenshotStart = Date.now();
      const screenshotPath = `${opts.screenshotDir}/${stepNumber}.png`;
      const { tracking, uiIssues } = await screenshotAndAnalyze(
        page,
        screenshotPath,
        viewport,
        log,
        `step ${stepNumber}`,
        pendingUiChecks
      );
      const fmt = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
      log(
        `step ${stepNumber} - timing: AI ${fmt(aiMs)}, actions ${fmt(actionsMs)}, settle ${fmt(settleMs)}, screenshot ${fmt(Date.now() - screenshotStart)}`
      );
      if (!tracking.gtmPresent) gtmPresentThroughout = false;
      if (!tracking.gtagPresent) gtagPresentThroughout = false;
      if (!tracking.gtmPresent || !tracking.gtagPresent) {
        log(`step ${stepNumber} - tracking WARNING: GTM=${tracking.gtmPresent} gtag=${tracking.gtagPresent}`);
      }
      steps.push({
        stepNumber,
        actionWarnings,
        url: page.url(),
        reasoning: plan.reasoning,
        actions: plan.actions,
        screenshot: screenshotPath,
        tracking,
        uiIssues,
      });

      if (failure) break;
    }

    if (!completed && !failure) {
      failure = `Exceeded max steps (${maxSteps}) without reaching a completion page`;
      log(`${failure}`);
    }

    // Stuck on a page where the site's own script crashed: that crash is almost
    // always the real reason. Seen in practice: Submit did nothing because the
    // site's boiler-repair-quote.js threw "sendOtpToPhoneNumber is not defined",
    // while the AI blamed the (correctly ticked) terms checkbox.
    if (!completed && failure && /^(Blocked at step|Exceeded max steps|Action execution failed)/.test(failure)) {
      const codeError = findSiteCodeError(
        [...pageErrors.slice(pageErrorMark), ...consoleErrors.slice(consoleErrorMark)],
        startHost
      );
      if (codeError) {
        failure += ` | Site code error: ${codeError}`;
        log(`the site's own code threw an error on this page: ${codeError}`);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The site couldn't be opened at all - that's the answer, not a tester crash
    failure = /^Site (security certificate problem|not reachable|too slow)/.test(message) ? message : `Walk crashed: ${err}`;
    log(`${failure.startsWith("Walk crashed") ? "CRASHED" : "ABORT"}: ${failure}`);
  } finally {
    await context.close();
    if (ownBrowser) await browser.close();
  }

  // Background UI checks read saved screenshot files, not the live page, so
  // they're unaffected by the browser closing above.
  await Promise.all(pendingUiChecks);

  log(`finished: ${startUrl} -> ${completed ? "COMPLETED" : "FAILED"}`);
  // If nothing ever got read (e.g. crashed before any step), don't claim
  // tracking was "present throughout" something that never happened.
  const anyStepsRecorded = steps.length > 0;
  return {
    startUrl,
    viewport,
    completed,
    failure,
    steps,
    consoleErrors,
    pageErrors,
    apiCalls,
    gtmPresentThroughout: anyStepsRecorded && gtmPresentThroughout,
    gtagPresentThroughout: anyStepsRecorded && gtagPresentThroughout,
    finalActions,
    otpNumbers: Array.from(otpNumbers),
    otpOutcomes,
  };
}

export { OPENAI_MODEL };
