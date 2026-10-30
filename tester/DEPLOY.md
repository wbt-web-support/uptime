# Running the funnel tester on Railway

The tester drives a real Chrome for several minutes per test, so it needs an
always-on server (Railway), not Vercel. The website (Vercel) talks to it over HTTP.

It lives in the uptime repo (`tester/`), so Railway deploys it from GitHub.

## 1. Create the service (once)

- Railway → **New Project → Deploy from GitHub repo** → `wbt-web-support/uptime`
- Service **Settings → Root Directory**: `tester` (Railway then builds `tester/Dockerfile`)
- **Settings → Source → Branch**: `main`, so every push to main updates the tester too

In the Railway dashboard for the service:

- **Settings → Networking → Generate Domain** - note the address, e.g.
  `https://funnel-tester-production.up.railway.app`
- **Volumes → New Volume**, mount path `/data` - keeps reports, screenshots and the
  SMS-code counters across deploys
- **Resources**: at least 2 GB RAM (two Chrome windows run during a test)

## 2. Environment variables (Railway → Variables)

| Variable | Value |
|---|---|
| `OPENAI_API_KEY` | same as in `.env.local` |
| `OPENAI_MODEL` | same as in `.env.local` |
| `TWILIO_ACCOUNT_SID` | same as in `.env.local` |
| `TWILIO_AUTH_TOKEN` | same as in `.env.local` |
| `TWILIO_PHONE_NUMBERS` | same as in `.env.local` |
| `DATA_DIR` | `/data` |
| `FUNNEL_TESTER_API_KEY` | a new long random string (also goes on Vercel, below) |
| `ALLOWED_ORIGINS` | the website's address, e.g. `https://uptime.example.com` |

Leave `WBT_HEADLESS` unset (headless is the default; a server has no screen).
Railway sets `PORT` itself.

## 3. Point the website at it (Vercel → Settings → Environment Variables)

| Variable | Value |
|---|---|
| `FUNNEL_TESTER_URL` | the Railway address from step 1 |
| `FUNNEL_TESTER_API_KEY` | the same random string as on Railway |

Redeploy the website after adding them.

## 4. Check it

- `https://<railway address>/health` answers `{"ok":true}`
- On the website, run one funnel test and watch its live progress

## Updating the tester later

Push to `main`: Railway rebuilds and restarts it. Wait until no test is running
first - a restart stops the test in progress.
