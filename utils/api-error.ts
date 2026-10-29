// Turns whatever an API call threw into one line a person can act on. Without it a
// database outage showed as "Internal server error" (Supabase's Cloudflare answers
// 522 with an object that has a "title" and "detail" but no "message") or, in the
// browser console, as "Error fetching data: {}".
export function apiErrorMessage(error: unknown): string {
  if (typeof error === "string" && error.trim()) return error;
  const e = (error ?? {}) as Record<string, any>;
  const status = Number(e.status ?? e.error_code);

  // Cloudflare in front of Supabase couldn't reach the database (520-530)
  if (e.cloudflare_error === true || (status >= 520 && status <= 530) || /supabase\.co/i.test(String(e.zone ?? ""))) {
    const what = typeof e.title === "string" ? `: ${e.title.replace(/^Error \d+:\s*/, "")}` : "";
    return `The database (Supabase) isn't answering right now (error ${status || "5xx"}${what}). Nothing was changed - wait a minute or two and try again.`;
  }

  const text = [e.message, e.details, e.detail, e.cause?.code, e.cause?.message].filter((v) => typeof v === "string").join(" ");
  if (/fetch failed|failed to fetch|load failed|network ?error|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR/i.test(text)) {
    return "Couldn't connect to the database or server - the network request failed. Check the internet connection, wait a minute and try again.";
  }

  if (typeof e.message === "string" && e.message.trim()) return e.message;
  if (typeof e.title === "string" && e.title.trim()) return e.title;
  return "Something went wrong on the server and it gave no details. Try again; if it keeps happening, the full error is in the app's terminal.";
}
