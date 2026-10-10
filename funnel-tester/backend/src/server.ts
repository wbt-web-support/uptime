import express from "express";
import cors from "cors";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { walkFunnel, checkPageUi, type CtaCheckResult, type GrammarIssue, type QuoteButtonResult } from "./aiWalker";
import { logger } from "./logger";

try {
  process.loadEnvFile(path.join(__dirname, "..", ".env.local"));
} catch {
  // no .env.local - fine if config is set some other way
}

const PORT = process.env.PORT ?? 4000;
// On Railway the app folder is wiped on every redeploy (including the one a
// variable change triggers), taking every saved report and screenshot with
// it - point DATA_DIR at a mounted Volume to keep them.
const DATA_DIR = process.env.DATA_DIR ?? path.join(__dirname, "..");
const REPORT_DIR = path.join(DATA_DIR, "reports");
const SCREENSHOT_ROOT = path.join(DATA_DIR, "screenshots");
// Comma-separated list, e.g. "https://funnel-tester-three.vercel.app,http://localhost:3000"
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? "*")
  .split(",")
  .map((o) => o.trim());

const app = express();
app.use(
  cors({
    origin: ALLOWED_ORIGINS.includes("*") ? true : ALLOWED_ORIGINS,
  })
);
app.use(express.json());

// Every request in, with its outcome (status + duration) once it finishes -
// without this, a request that fails before reaching a route's own error
// handling (bad JSON body, CORS rejection, etc.) left no trace anywhere.
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const durationMs = Date.now() - start;
    const line = `${req.method} ${req.originalUrl} -> ${res.statusCode} (${durationMs}ms)`;
    if (res.statusCode >= 500) logger.error(line);
    else if (res.statusCode >= 400) logger.warn(line);
    else logger.info(line);
  });
  next();
});

// Shared secret for every endpoint except /health. Without it, anyone who can
// reach this server can start runs (each submits a real lead on a client's site),
// point Chrome at any URL, and read the screenshots back. Callers send it as
// "Authorization: Bearer <key>". Unset = open, which is only fine on your own PC.
const API_KEY = process.env.FUNNEL_TESTER_API_KEY;

function keyMatches(given: string | undefined): boolean {
  if (!API_KEY || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(API_KEY);
  return a.length === b.length && timingSafeEqual(a, b);
}

app.use((req, res, next) => {
  if (!API_KEY || req.path === "/health") {
    next();
    return;
  }
  const header = req.headers.authorization;
  const given = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
  if (!keyMatches(given)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
});

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "funnel";
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/reports", (_req, res) => {
  let files: string[] = [];
  try {
    files = readdirSync(REPORT_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    res.json({ reports: [] });
    return;
  }

  const reports = files
    .map((file) => {
      try {
        const content = JSON.parse(readFileSync(path.join(REPORT_DIR, file), "utf-8"));
        return {
          file,
          timestamp: file.replace(".json", ""),
          names: content.map((r: { name?: string; startUrl?: string }) => r.name || r.startUrl || ""),
          total: content.length,
          passed: content.filter((r: { completed: boolean }) => r.completed).length,
        };
      } catch {
        return null;
      }
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  res.json({ reports });
});

// Flattened, richer view of every entry across every saved report - powers
// the dashboard's "Issues" overview page, which needs the actual failure
// reason and UI issue count per run, not just the pass/total count /reports
// gives.
app.get("/reports-detail", (_req, res) => {
  let files: string[] = [];
  try {
    files = readdirSync(REPORT_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    res.json({ entries: [] });
    return;
  }

  interface Entry {
    file: string;
    name: string;
    url: string;
    viewport: string;
    timestamp: string;
    completed: boolean;
    failure: string | null;
    uiIssueCount: number;
    gtmPresentThroughout: boolean;
    gtagPresentThroughout: boolean;
    knownLimitation: boolean;
    limitationReason: string | null;
  }

  // Distinguishes "the site/an external service has a real, confirmed
  // constraint we can't fix from our code" from "our tool actually failed" -
  // established from real debugging this project: Twilio's own anti-fraud
  // system redacts OTP codes before they ever reach us (Error 30038, not
  // something any code change here can work around), and some sites'
  // own client-side JS silently reformats/corrupts a field after we fill it
  // (we now detect and correct that, but the site may still reject the
  // result depending on what it does with the corrected value).
  function detectKnownLimitation(
    failure: string | null,
    steps: Array<{ actionWarnings?: string[] }>
  ): { knownLimitation: boolean; limitationReason: string | null } {
    if (failure && /OTP blocked at step \d+ by Twilio's content filter/i.test(failure)) {
      return {
        knownLimitation: true,
        limitationReason:
          "Twilio is redacting the OTP code before it reaches us (Error 30038) - needs Twilio Support to lift this restriction, not a code fix.",
      };
    }
    if (failure && /OTP required at step \d+ but no code arrived/i.test(failure)) {
      return {
        knownLimitation: true,
        limitationReason:
          "No OTP SMS reached our Twilio number in time - the site may not have sent it (e.g. its own \"too many OTP requests\" rate limit) or may have rejected the number.",
      };
    }
    if (failure && /Navigated off the original site/i.test(failure)) {
      return {
        knownLimitation: true,
        limitationReason: "The site itself navigated to a different domain mid-funnel.",
      };
    }
    const reformatWarning = steps
      .flatMap((s) => s.actionWarnings ?? [])
      .find((w) => /was reformatted/i.test(w));
    if (reformatWarning) {
      return {
        knownLimitation: true,
        limitationReason: `The site's own JS reformatted a field after filling it (auto-corrected, but the site may still reject the result): ${reformatWarning}`,
      };
    }
    return { knownLimitation: false, limitationReason: null };
  }

  const entries: Entry[] = [];
  for (const file of files) {
    try {
      const content = JSON.parse(readFileSync(path.join(REPORT_DIR, file), "utf-8"));
      for (const r of content) {
        const steps = Array.isArray(r.steps) ? r.steps : [];
        const uiIssueCount = steps.reduce(
          (sum: number, s: { uiIssues?: string[] }) => sum + (s.uiIssues?.length ?? 0),
          0
        );
        const { knownLimitation, limitationReason } = detectKnownLimitation(r.failure ?? null, steps);
        entries.push({
          file,
          name: r.name ?? r.startUrl,
          url: r.startUrl,
          viewport: r.viewport ?? "desktop",
          timestamp: file.replace(/\.json$/, ""),
          completed: !!r.completed,
          failure: r.failure ?? null,
          uiIssueCount,
          gtmPresentThroughout: !!r.gtmPresentThroughout,
          gtagPresentThroughout: !!r.gtagPresentThroughout,
          knownLimitation,
          limitationReason,
        });
      }
    } catch {
      // skip unreadable/malformed report file
    }
  }

  entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  res.json({ entries });
});

app.get("/reports/:file", (req, res) => {
  const { file } = req.params;
  if (!/^[\w.-]+\.json$/.test(file)) {
    res.status(400).json({ error: "Invalid report file name" });
    return;
  }
  try {
    const content = readFileSync(path.join(REPORT_DIR, file), "utf-8");
    res.setHeader("Content-Type", "application/json");
    res.send(content);
  } catch {
    res.status(404).json({ error: "Report not found" });
  }
});

app.get("/screenshot", (req, res) => {
  const requested = req.query.path;
  if (typeof requested !== "string") {
    res.status(400).json({ error: "Missing path" });
    return;
  }
  const resolved = path.resolve(requested);
  if (!resolved.startsWith(SCREENSHOT_ROOT + path.sep) && resolved !== SCREENSHOT_ROOT) {
    res.status(403).json({ error: "Path not allowed" });
    return;
  }
  try {
    const data = readFileSync(resolved);
    res.setHeader("Content-Type", "image/png");
    res.send(data);
  } catch {
    res.status(404).json({ error: "Screenshot not found" });
  }
});

interface RunStatus {
  status: "running" | "completed" | "failed";
  messages: string[];
  reportFile?: string;
  completed?: boolean;
  error?: string;
}

// In-memory only - fine for a single-instance server, and a run's live
// status doesn't need to survive a restart the way saved reports do.
const runStatuses = new Map<string, RunStatus>();

app.post("/run", (req, res) => {
  const { url, name } = req.body ?? {};
  if (!url) {
    res.status(400).json({ error: "Missing url" });
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    res.status(400).json({ error: "Invalid url" });
    return;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    res.status(400).json({ error: "url must be http or https" });
    return;
  }

  const displayName: string = name || url;
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const screenshotDir = path.join(SCREENSHOT_ROOT, `${slugify(displayName)}-${timestamp}`);
  const runId = timestamp;

  const status: RunStatus = { status: "running", messages: [] };
  runStatuses.set(runId, status);

  // Not awaited - responds with the runId immediately so the client can
  // poll for live progress instead of blocking on the whole walk (which
  // can take minutes) with no feedback.
  walkFunnel(url, {
    screenshotDir,
    onProgress: (msg) => status.messages.push(msg),
  })
    .then((result) => {
      mkdirSync(REPORT_DIR, { recursive: true });
      const reportFile = `${timestamp}.json`;
      writeFileSync(
        path.join(REPORT_DIR, reportFile),
        JSON.stringify([{ name: displayName, ...result }], null, 2)
      );
      status.status = "completed";
      status.reportFile = reportFile;
      status.completed = result.completed;
    })
    .catch((err) => {
      status.status = "failed";
      status.error = `Walk crashed: ${err}`;
      logger.error(`walk crashed for runId ${runId} (${url})`, err);
    });

  res.status(202).json({ runId });
});

app.get("/run/:runId/status", (req, res) => {
  const status = runStatuses.get(req.params.runId);
  if (!status) {
    res.status(404).json({ error: "Unknown runId" });
    return;
  }
  res.json(status);
});

interface ViewportRunStatus {
  status: "queued" | "running" | "completed" | "failed";
  messages: string[];
  reportFile?: string;
  completed?: boolean;
  error?: string;
  screenshotDir?: string;
  // Filled in when status is requested, so the dashboard can show what the
  // bot is looking at right now.
  latestScreenshot?: string;
}

function newestScreenshotIn(dir: string): string | undefined {
  try {
    let newest: { file: string; mtime: number } | undefined;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".png")) continue;
      const mtime = statSync(path.join(dir, file)).mtimeMs;
      if (!newest || mtime > newest.mtime) newest = { file, mtime };
    }
    return newest ? path.join(dir, newest.file) : undefined;
  } catch {
    return undefined; // folder not created yet
  }
}

function newViewportRunStatus(): ViewportRunStatus {
  return { status: "queued", messages: [] };
}

type Viewport = "desktop" | "mobile";

interface BatchItemStatus {
  url: string;
  name: string;
  // Which of the site's funnels to enter from this (home)page, see walkFunnel
  entryHint?: string;
  // Only the viewports chosen for this batch are present.
  runs: Partial<Record<Viewport, ViewportRunStatus>>;
}

function parseViewports(raw: unknown): Viewport[] {
  if (raw === undefined) return ["desktop", "mobile"];
  if (!Array.isArray(raw) || raw.length === 0 || raw.some((v) => v !== "desktop" && v !== "mobile")) {
    throw new Error('viewports must be a non-empty array of "desktop" and/or "mobile"');
  }
  return (["desktop", "mobile"] as Viewport[]).filter((v) => raw.includes(v));
}

interface BatchStatus {
  items: BatchItemStatus[];
  currentIndex: number;
  done: boolean;
  // Set by POST /batch/:batchId/cancel; the running walk stops at its next step
  cancelled?: boolean;
}

const MAX_BATCH_SIZE = 20;
// Rotates through TWILIO_PHONE_NUMBERS across single-lane runs (see /run-batch)
let nextBatchNumberIndex = 0;

// Test numbers held by a walk that is running right now. When desktop and mobile
// run at the same time, each keeps its own number - two walks waiting for a code on
// one number couldn't tell whose code is whose - so neither may switch to the
// number the other one is using.
const numbersInUse = new Set<string>();

// Desktop and mobile of one site at the same time (about half the time), when two
// different numbers are free; otherwise one after the other as before
const PARALLEL_DEVICES = process.env.FUNNEL_PARALLEL_DEVICES !== "false";

// ---------------------------------------------------------------------------
// SMS code usage per number per day. Twilio doesn't cap receiving, but a number
// that collects lots of verification codes risks Twilio's OTP filter (30038) and
// sites' own "too many attempts" blocks - so each number gets a daily budget.
// Kept in a small file so it survives restarts.
// ---------------------------------------------------------------------------
// Kept low: Twilio's Fraud Guard blocks a number that gets many codes, even a few a day
const OTP_DAILY_LIMIT = Number(process.env.FUNNEL_OTP_DAILY_LIMIT || 5);
const OTP_USAGE_FILE = path.join(DATA_DIR, "otp-usage.json");

const today = () => new Date().toISOString().slice(0, 10);

function readOtpUsage(): Record<string, number> {
  try {
    const saved = JSON.parse(readFileSync(OTP_USAGE_FILE, "utf-8"));
    return saved.date === today() ? saved.counts ?? {} : {};
  } catch {
    return {};
  }
}

function recordOtpUse(phoneNumber: string) {
  const counts = readOtpUsage();
  counts[phoneNumber] = (counts[phoneNumber] ?? 0) + 1;
  try {
    writeFileSync(OTP_USAGE_FILE, JSON.stringify({ date: today(), counts }, null, 2));
  } catch (err) {
    logger.error("could not save SMS code usage", err);
  }
  logger.info(`SMS code received on ${phoneNumber}: ${counts[phoneNumber]}/${OTP_DAILY_LIMIT} today`);
}

const hasOtpBudget = (phoneNumber: string) => (readOtpUsage()[phoneNumber] ?? 0) < OTP_DAILY_LIMIT;

// ---------------------------------------------------------------------------
// Which test number each website's SMS codes actually reach. A site's own SMS
// service (often its own Twilio Verify) can stop sending to one number after
// several codes in a day - seen on a real site: codes to one number went missing
// all afternoon while the other number got them straight away. A number whose code
// went missing for a site is avoided for that site for a while.
// ---------------------------------------------------------------------------
const SITE_NUMBER_BACKOFF_HOURS = Number(process.env.FUNNEL_SITE_NUMBER_BACKOFF_HOURS || 6);
const SITE_NUMBERS_FILE = path.join(DATA_DIR, "otp-site-numbers.json");
type SiteNumberLog = Record<string, Record<string, { missingAt?: string; receivedAt?: string }>>;

const siteKey = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return url;
  }
};

function readSiteNumbers(): SiteNumberLog {
  try {
    return JSON.parse(readFileSync(SITE_NUMBERS_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function recordSiteNumberOutcomes(url: string, outcomes: Record<string, "received" | "missing"> | undefined) {
  if (!outcomes || Object.keys(outcomes).length === 0) return;
  const log = readSiteNumbers();
  const site = (log[siteKey(url)] ??= {});
  const now = new Date().toISOString();
  for (const [number, outcome] of Object.entries(outcomes)) {
    site[number] = { ...site[number], [outcome === "received" ? "receivedAt" : "missingAt"]: now };
    if (outcome === "missing") logger.info(`SMS code from ${siteKey(url)} never reached ${number} - using another number for this site for ${SITE_NUMBER_BACKOFF_HOURS}h`);
  }
  try {
    writeFileSync(SITE_NUMBERS_FILE, JSON.stringify(log, null, 2));
  } catch (err) {
    logger.error("could not save which numbers each site's SMS codes reach", err);
  }
}

// The site's code went missing on this number recently, and hasn't arrived there since
function siteAvoidsNumber(url: string, number: string): boolean {
  const entry = readSiteNumbers()[siteKey(url)]?.[number];
  if (!entry?.missingAt) return false;
  if (entry.receivedAt && entry.receivedAt > entry.missingAt) return false;
  return Date.now() - new Date(entry.missingAt).getTime() < SITE_NUMBER_BACKOFF_HOURS * 3600_000;
}

// Numbers Twilio has refused to send verification codes to ("The destination phone
// number has been temporarily blocked by Twilio" - its anti-fraud block after many
// codes in a short time). Shown as a warning on the dashboard, and the number isn't
// used meanwhile - every refused send makes Twilio keep the block longer. Twilio
// says Fraud Guard blocks last from 5 minutes to 12 hours, so after 12 hours the
// number is tried again.
const BLOCKED_NUMBERS_FILE = path.join(DATA_DIR, "otp-blocked.json");
const BLOCK_SHOWN_HOURS = 12;

function readBlockedNumbers(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(BLOCKED_NUMBERS_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function writeBlockedNumbers(blocked: Record<string, string>) {
  try {
    writeFileSync(BLOCKED_NUMBERS_FILE, JSON.stringify(blocked, null, 2));
  } catch (err) {
    logger.error("could not save blocked numbers", err);
  }
}

function recordBlockedNumber(phoneNumber: string) {
  writeBlockedNumbers({ ...readBlockedNumbers(), [phoneNumber]: new Date().toISOString() });
  logger.info(`Twilio has temporarily blocked ${phoneNumber} from receiving verification codes`);
}

// A code later reached the number: the block is over
function clearBlockedNumber(phoneNumber: string) {
  const blocked = readBlockedNumbers();
  if (!blocked[phoneNumber]) return;
  delete blocked[phoneNumber];
  writeBlockedNumbers(blocked);
}

const blockedSince = (phoneNumber: string): string | null => {
  const at = readBlockedNumbers()[phoneNumber];
  return at && Date.now() - new Date(at).getTime() < BLOCK_SHOWN_HOURS * 3600_000 ? at : null;
};

app.get("/sms-usage", (_req, res) => {
  const counts = readOtpUsage();
  const numbers = (process.env.TWILIO_PHONE_NUMBERS ?? "").split(",").map((n) => n.trim()).filter(Boolean);
  res.json({
    date: today(),
    limit: OTP_DAILY_LIMIT,
    numbers: numbers.map((number) => ({ number, used: counts[number] ?? 0, blockedAt: blockedSince(number) })),
  });
});
const batchStatuses = new Map<string, BatchStatus>();

interface BatchItemInput {
  url: string;
  name: string;
  entryHint?: string;
}

function parseBatchItems(items: unknown): BatchItemInput[] {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("Missing items (array of {url, name?, entryHint?})");
  }
  if (items.length > MAX_BATCH_SIZE) {
    throw new Error(`Too many sites in one batch (max ${MAX_BATCH_SIZE})`);
  }
  const parsed: BatchItemInput[] = [];
  for (const it of items as Array<{ url?: string; name?: string; entryHint?: string }>) {
    const url = it?.url;
    if (!url) throw new Error("Each item needs a url");
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      throw new Error(`Invalid url: ${url}`);
    }
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      throw new Error(`url must be http or https: ${url}`);
    }
    const entryHint = typeof it.entryHint === "string" && it.entryHint.trim() ? it.entryHint.trim().slice(0, 500) : undefined;
    parsed.push({ url, name: it.name || url, entryHint });
  }
  return parsed;
}

async function runOneViewport(
  url: string,
  name: string,
  viewport: "desktop" | "mobile",
  status: ViewportRunStatus,
  phoneNumber?: string,
  entryHint?: string,
  shouldStop: () => boolean = () => false,
  testFinalActions = true
): Promise<void> {
  if (shouldStop()) {
    status.status = "failed";
    status.error = "Stopped by user";
    return;
  }
  status.status = "running";
  const timestamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-${viewport}`;
  const screenshotDir = path.join(SCREENSHOT_ROOT, `${slugify(name)}-${timestamp}`);
  status.screenshotDir = screenshotDir;
  try {
    // One walk, plus the bookkeeping on which numbers got their SMS codes
    const walkWith = async (number: string | undefined, dir: string) => {
      const walk = await walkFunnel(url, {
        screenshotDir: dir,
        viewport,
        phoneNumber: number,
        entryHint,
        shouldStop,
        testFinalActions,
        numberAvailable: (n) => hasOtpBudget(n) && !blockedSince(n) && !numbersInUse.has(n),
        onProgress: (msg) => status.messages.push(msg),
      });
      // Every number the site was asked to text a code to counts towards its daily
      // limit - including the second number when the walk retried there
      const otpNumbers = walk.otpNumbers?.length
        ? walk.otpNumbers
        : number && walk.steps.some((s) => /_otp\.png$/.test(s.screenshot))
          ? [number]
          : [];
      otpNumbers.forEach(recordOtpUse);
      recordSiteNumberOutcomes(url, walk.otpOutcomes);
      // The site's send-code request was refused by Twilio for this number: warn
      if (number && walk.apiCalls.some((c) => /temporarily blocked by twilio|has been temporarily blocked/i.test(c))) {
        recordBlockedNumber(number);
      }
      Object.entries(walk.otpOutcomes ?? {}).forEach(([n, outcome]) => outcome === "received" && clearBlockedNumber(n));
      return walk;
    };

    let result = await walkWith(phoneNumber, screenshotDir);

    // Failed only because no SMS code reached this number (often a Twilio block
    // the site only reports on Resend, on a code screen where the number is
    // locked): run this device's test again from the start on the other number,
    // once. That submits the form again, so it makes one more test lead. Not when
    // the walk already asked for a code on the other number itself - one failing
    // test must not put codes on both numbers twice over.
    const otherNumber = (process.env.TWILIO_PHONE_NUMBERS ?? "")
      .split(",")
      .map((n) => n.trim())
      .find((n) => n && n !== phoneNumber && hasOtpBudget(n) && !blockedSince(n) && !numbersInUse.has(n));
    const alreadyTriedOther = !!otherNumber && (result.otpNumbers ?? []).includes(otherNumber);
    if (phoneNumber && otherNumber && !alreadyTriedOther && !result.completed && /^OTP required/.test(result.failure ?? "") && !shouldStop()) {
      const note = `No SMS code reached ${phoneNumber} - testing ${viewport} again from the start on ${otherNumber}`;
      status.messages.push(note);
      logger.info(`${url}: ${note}`);
      result = await walkWith(otherNumber, `${screenshotDir}-retry`);
      if (result.completed) status.messages.push(`Passed on ${otherNumber}`);
    }

    mkdirSync(REPORT_DIR, { recursive: true });
    const reportFile = `${timestamp}.json`;
    writeFileSync(path.join(REPORT_DIR, reportFile), JSON.stringify([{ name, ...result }], null, 2));
    status.status = "completed";
    status.reportFile = reportFile;
    status.completed = result.completed;
  } catch (err) {
    status.status = "failed";
    status.error = `Walk crashed: ${err}`;
    logger.error(`walk crashed (batch item, ${viewport}) for ${url}`, err);
  }
}

app.post("/run-batch", (req, res) => {
  let parsedItems: BatchItemInput[];
  let viewports: Viewport[];
  try {
    parsedItems = parseBatchItems(req.body?.items);
    viewports = parseViewports(req.body?.viewports);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
    return;
  }
  // false = finish each walk as soon as the form is submitted (see walkFunnel)
  const testFinalActions = req.body?.testFinalActions !== false;

  // Every number has used today's SMS budget: don't start, rather than risk them
  const configuredNumbers = (process.env.TWILIO_PHONE_NUMBERS ?? "").split(",").map((n) => n.trim()).filter(Boolean);
  if (configuredNumbers.length > 0 && !configuredNumbers.some(hasOtpBudget)) {
    res.status(429).json({
      error: `All test phone numbers have received today's limit of ${OTP_DAILY_LIMIT} SMS codes each. To protect them from being blocked, funnel tests start again tomorrow (limit set by FUNNEL_OTP_DAILY_LIMIT).`,
    });
    return;
  }
  // Every number is blocked by Twilio or used up: don't start. Sending to a blocked
  // number anyway only makes Twilio keep it blocked for longer.
  if (configuredNumbers.length > 0 && !configuredNumbers.some((n) => hasOtpBudget(n) && !blockedSince(n))) {
    const freeAt = configuredNumbers
      .map((n) => blockedSince(n))
      .filter((at): at is string => !!at)
      .map((at) => new Date(at).getTime() + BLOCK_SHOWN_HOURS * 3600_000)
      .sort((a, b) => a - b)[0];
    const when = freeAt
      ? ` The first one is tried again at ${new Date(freeAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}.`
      : "";
    res.status(429).json({
      error: `No test phone number can receive SMS codes right now (blocked by Twilio or today's limit reached), so tests are paused to let the block lift.${when}`,
    });
    return;
  }

  const batchId = `${new Date().toISOString().replace(/[:.]/g, "-")}-batch`;
  const batch: BatchStatus = {
    items: parsedItems.map((it) => ({
      url: it.url,
      name: it.name,
      entryHint: it.entryHint,
      runs: Object.fromEntries(viewports.map((v) => [v, newViewportRunStatus()])),
    })),
    currentIndex: -1,
    done: false,
  };
  batchStatuses.set(batchId, batch);

  // One parallel lane per Twilio number, each lane keeping its own number
  // for every site it tests: sites alternate between lanes (1, 3, 5... on
  // the first number; 2, 4, 6... on the second), so 10 sites run as two
  // lanes of 5 in roughly half the time, and two runs waiting on an OTP at
  // the same moment can never read each other's code. Within a lane, sites
  // run one at a time, desktop first then mobile. Each viewport submits the
  // form for real, so "both" creates two real leads per site.
  const numbers = (process.env.TWILIO_PHONE_NUMBERS ?? "")
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean);
  const laneCount = Math.max(1, Math.min(numbers.length, batch.items.length));
  // One lane runs everything one after another, so no two runs ever wait on an
  // OTP at the same moment - safe to take the next number in turn for each run.
  // Without this, a one-site batch (how the uptime app sends every test) always
  // used the first number and the others were never used.
  // ...skipping any number that has used up today's SMS budget, and any number
  // this website's SMS codes have recently stopped reaching
  const numberFor = (lane: number, url: string) => {
    if (laneCount !== 1 || numbers.length <= 1) return numbers[lane];
    const start = nextBatchNumberIndex++;
    const inTurn = numbers.map((_, k) => numbers[(start + k) % numbers.length]);
    // A number Twilio has blocked is never used while the block lasts, for any site
    const free = (n: string) => hasOtpBudget(n) && !blockedSince(n);
    // (/run-batch refuses to start when no number is free, so a blocked number is
    // only ever used if it became blocked after the batch started)
    const chosen =
      inTurn.find((n) => free(n) && !siteAvoidsNumber(url, n)) ??
      inTurn.find((n) => free(n)) ??
      inTurn[0];
    if (chosen !== inTurn[0]) {
      const why = blockedSince(inTurn[0])
        ? "blocked by Twilio"
        : !hasOtpBudget(inTurn[0])
          ? "used up today's SMS codes"
          : "this site's SMS codes stopped arriving there";
      logger.info(`${siteKey(url)}: skipping ${inTurn[0]} (${why}) - using ${chosen}`);
    }
    return chosen;
  };
  (async () => {
    await Promise.all(
      Array.from({ length: laneCount }, async (_, lane) => {
        for (let i = lane; i < batch.items.length; i += laneCount) {
          batch.currentIndex = i;
          const item = batch.items[i];
          // Each device runs on a number reserved for it until its walk ends
          const runDevice = async (viewport: Viewport, number: string | undefined) => {
            if (number) numbersInUse.add(number);
            try {
              await runOneViewport(item.url, item.name, viewport, item.runs[viewport]!, number, item.entryHint, () => !!batch.cancelled, testFinalActions);
            } finally {
              if (number) numbersInUse.delete(number);
            }
          };
          const first = numberFor(lane, item.url);
          // A second free number, different from the first, for the other device
          const free = (n: string) => n !== first && hasOtpBudget(n) && !blockedSince(n);
          const second = numbers.find((n) => free(n) && !siteAvoidsNumber(item.url, n)) ?? numbers.find(free);
          if (PARALLEL_DEVICES && laneCount === 1 && viewports.length === 2 && first && second) {
            logger.info(`${siteKey(item.url)}: testing desktop (${first}) and mobile (${second}) at the same time`);
            await Promise.all([runDevice(viewports[0], first), runDevice(viewports[1], second)]);
          } else {
            for (const [k, viewport] of viewports.entries()) {
              await runDevice(viewport, k === 0 ? first : numberFor(lane, item.url));
            }
          }
        }
      })
    );
    batch.currentIndex = batch.items.length;
    batch.done = true;
  })();

  res.status(202).json({ batchId });
});

// Stop a funnel test batch: the walk running now ends at its next step (or next
// results-page button), and queued viewports never start. Anything already
// submitted stays submitted.
app.post("/batch/:batchId/cancel", (req, res) => {
  const batch = batchStatuses.get(req.params.batchId);
  if (!batch) {
    res.status(404).json({ error: "Unknown batchId" });
    return;
  }
  batch.cancelled = true;
  for (const item of batch.items) {
    for (const run of Object.values(item.runs)) {
      if (run && run.status === "queued") {
        run.status = "failed";
        run.error = "Stopped by user";
      }
    }
  }
  logger.info(`batch ${req.params.batchId} cancelled`);
  res.json({ cancelled: true });
});

app.get("/batch/:batchId/status", (req, res) => {
  const batch = batchStatuses.get(req.params.batchId);
  if (!batch) {
    res.status(404).json({ error: "Unknown batchId" });
    return;
  }
  for (const item of batch.items) {
    for (const run of Object.values(item.runs)) {
      if (run && run.status === "running" && run.screenshotDir) {
        run.latestScreenshot = newestScreenshotIn(run.screenshotDir) ?? run.latestScreenshot;
      }
    }
  }
  res.json(batch);
});

interface UiCheckViewportStatus {
  status: "queued" | "running" | "completed" | "failed";
  messages: string[];
  screenshot?: string;
  uiIssues?: string[];
  ctaCheck?: CtaCheckResult | null;
  quoteButtons?: QuoteButtonResult[];
  // UK spelling / grammar mistakes in the page text (desktop only; null on mobile)
  grammarIssues?: GrammarIssue[] | null;
  // The page whose quote buttons were checked: the homepage, or a service page
  landingUrl?: string;
  error?: string;
}

function newUiCheckViewportStatus(): UiCheckViewportStatus {
  return { status: "queued", messages: [] };
}

interface UiCheckItemStatus {
  url: string;
  name: string;
  // The funnel being tested - its service page is checked when the homepage has no quote buttons
  entryHint?: string;
  desktop: UiCheckViewportStatus;
  mobile: UiCheckViewportStatus;
}

interface UiCheckBatchStatus {
  items: UiCheckItemStatus[];
  currentIndex: number;
  done: boolean;
  cancelled?: boolean;
}

const uiCheckBatches = new Map<string, UiCheckBatchStatus>();

async function runOneUiCheck(
  url: string,
  name: string,
  viewport: "desktop" | "mobile",
  status: UiCheckViewportStatus,
  shouldStop: () => boolean = () => false,
  entryHint?: string
): Promise<void> {
  if (shouldStop()) {
    status.status = "failed";
    status.error = "Stopped by user";
    return;
  }
  status.status = "running";
  const timestamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-${viewport}`;
  const screenshotDir = path.join(SCREENSHOT_ROOT, `ui-check-${slugify(name)}-${timestamp}`);
  try {
    const result = await checkPageUi(url, viewport, screenshotDir, (msg) => status.messages.push(msg), shouldStop, entryHint);
    status.status = "completed";
    status.screenshot = result.screenshot;
    status.uiIssues = result.uiIssues;
    status.ctaCheck = result.ctaCheck;
    status.quoteButtons = result.quoteButtons;
    status.grammarIssues = result.grammarIssues;
    status.landingUrl = result.landingUrl;
  } catch (err) {
    status.status = "failed";
    // A site that can't be opened (expired SSL, unreachable, too slow) is the
    // answer itself, not a crash of the checker
    const message = err instanceof Error ? err.message : String(err);
    status.error = /^Site (security certificate problem|not reachable|too slow)/.test(message) ? message : `Check crashed: ${err}`;
    logger.error(`UI check crashed (${viewport}) for ${url}`, err);
  }
}

// Loads exactly the URL given (no funnel-walking, no form filling) and asks
// the vision model whether buttons/links on that one page look clickable -
// takes seconds per viewport instead of the minutes a full walkFunnel()
// takes, for when someone only wants a fast visual clickability check.
app.post("/check-ui-batch", (req, res) => {
  let parsedItems: BatchItemInput[];
  try {
    parsedItems = parseBatchItems(req.body?.items);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
    return;
  }

  const batchId = `${new Date().toISOString().replace(/[:.]/g, "-")}-ui-batch`;
  const batch: UiCheckBatchStatus = {
    items: parsedItems.map((it) => ({
      url: it.url,
      name: it.name,
      entryHint: it.entryHint,
      desktop: newUiCheckViewportStatus(),
      mobile: newUiCheckViewportStatus(),
    })),
    currentIndex: -1,
    done: false,
  };
  uiCheckBatches.set(batchId, batch);

  (async () => {
    for (let i = 0; i < batch.items.length; i++) {
      batch.currentIndex = i;
      const item = batch.items[i];
      const stopped = () => !!batch.cancelled;
      await runOneUiCheck(item.url, item.name, "desktop", item.desktop, stopped, item.entryHint);
      await runOneUiCheck(item.url, item.name, "mobile", item.mobile, stopped, item.entryHint);
    }
    batch.currentIndex = batch.items.length;
    batch.done = true;
  })();

  res.status(202).json({ batchId });
});

app.post("/check-ui-batch/:batchId/cancel", (req, res) => {
  const batch = uiCheckBatches.get(req.params.batchId);
  if (!batch) {
    res.status(404).json({ error: "Unknown batchId" });
    return;
  }
  batch.cancelled = true;
  for (const item of batch.items) {
    for (const run of [item.desktop, item.mobile]) {
      if (run.status === "queued") {
        run.status = "failed";
        run.error = "Stopped by user";
      }
    }
  }
  logger.info(`UI check batch ${req.params.batchId} cancelled`);
  res.json({ cancelled: true });
});

app.get("/check-ui-batch/:batchId/status", (req, res) => {
  const batch = uiCheckBatches.get(req.params.batchId);
  if (!batch) {
    res.status(404).json({ error: "Unknown batchId" });
    return;
  }
  res.json(batch);
});

app.listen(PORT, () => {
  const twilioNumberCount = (process.env.TWILIO_PHONE_NUMBERS ?? "")
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean).length;
  logger.info(`funnel-tester-backend listening on port ${PORT}`, {
    openaiConfigured: !!process.env.OPENAI_API_KEY,
    twilioConfigured: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && twilioNumberCount),
    twilioNumberCount,
    allowedOrigins: ALLOWED_ORIGINS,
    apiKeyRequired: !!API_KEY,
  });
});

// Surfaces a crash the app itself never gets a chance to log otherwise -
// e.g. a rejected promise from code that isn't awaited anywhere (walkFunnel
// runs detached from its request handler by design, so a bug outside its own
// try/catch would otherwise disappear silently instead of showing up here).
process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled promise rejection", reason);
});
process.on("uncaughtException", (err) => {
  logger.error("Uncaught exception", err);
});
