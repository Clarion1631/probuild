/**
 * Speed-to-Lead v1a (PB-leads-001) — shared constants and env-var reads.
 *
 * v1a sends nothing to customers (docs/plans/SPEED-TO-LEAD-V1A.md). Every
 * send/template/approval/follow-up/reconcile/cap/allowlist/footer/calendly/
 * phone constant from the full-build v1 file is gone — those all describe
 * outbound code that does not exist on this branch. What is left is intake,
 * triage, the two alert channels (ntfy + Chat), and tracking.
 */

// ── Intake timing ────────────────────────────────────────────────────────

/** A WEB_EMAIL_FALLBACK row waits this long past the email's receive time before the cron may promote it (unless it has no submissionId at all — then it is due immediately). */
export const FALLBACK_DUE_DELAY_MS = 10 * 60 * 1000;

/** Cross-channel dedupe: a fallback and a webhook for the same normalized email within this window collapse to one Lead. */
export const CROSS_CHANNEL_DEDUPE_WINDOW_MS = 15 * 60 * 1000;

/** A repeat Voice call from the same number within this window of an open lead links to it instead of creating a new one. */
export const VOICE_REPEAT_CALL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Triage REAL: minimum seconds between page render and form submit. */
export const MIN_RENDER_TO_SUBMIT_SECONDS = 3;
/** Triage REAL: minimum letters (a-z, case-insensitive) required in the description. */
export const MIN_DESCRIPTION_LETTERS = 10;

/** Webhook signing: accepted clock skew for `timestamp.body` HMAC verification. */
export const WEBHOOK_SKEW_MS = 5 * 60 * 1000;

/** Every individual Gmail API call (poll) gets an explicit deadline — an unbounded call could otherwise consume the whole cron invocation's time budget with no result. */
export const GMAIL_REQUEST_TIMEOUT_MS = 10 * 1000;

/** Intake: the signed webhook body is rejected over this size, before HMAC verification even runs. */
export const INTAKE_MAX_BODY_BYTES = 32 * 1024;

/** Intake writes run as explicit interactive transactions with a bounded timeout — a timeout maps to a 503 (the site retries) rather than an unhandled 500, and intake stays idempotent either way (the exactly-once externalId insert is never partially applied). */
export const INTAKE_TX_TIMEOUT_MS = 5_000;
export const INTAKE_TX_MAX_WAIT_MS = 5_000;

// ── Modes (v1a meaning — see docs/plans/SPEED-TO-LEAD-V1A.md "Modes") ──────

export type SpeedToLeadMode = "OFF" | "TEST" | "LIVE";

/** Any unrecognized value reads as OFF — never fail open. */
export function speedToLeadMode(env: NodeJS.ProcessEnv = process.env): SpeedToLeadMode {
    const raw = (env.SPEED_TO_LEAD_MODE ?? "").trim().toUpperCase();
    return raw === "TEST" || raw === "LIVE" ? raw : "OFF";
}

/** LIVE only ever posts team Chat cards in production — everywhere else LIVE behaves like TEST. */
export function isProduction(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.VERCEL_ENV === "production";
}

/** True once team Chat cards should be sent for a real (non-test) lead: LIVE, on production. */
export function chatCardsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return speedToLeadMode(env) === "LIVE" && isProduction(env);
}

/** The single approver's email — every Justin-only gate compares against this. */
export function approverEmail(env: NodeJS.ProcessEnv = process.env): string {
    return (env.SPEED_TO_LEAD_APPROVER_EMAIL ?? "").trim().toLowerCase();
}

export function isApprover(sessionEmail: string | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
    const expected = approverEmail(env);
    if (!expected || !sessionEmail) return false;
    return sessionEmail.trim().toLowerCase() === expected;
}

// ── Fixed content ───────────────────────────────────────────────────────

/** The read-only lead inbox v1a polls and the identity every alert/OAuth check compares against. Replaces v1's send-capable `DISPATCH_FROM_ADDRESS`. */
export const LEAD_INBOX_ADDRESS = "gtrsupport@goldentouchremodeling.com";

// ── Triage: service area (spec Triage — "a service-area city or zip, or none given") ─
// Golden Touch Remodeling is based in Vancouver, WA. This default list is a
// starting point, not authoritative business data — override with
// SPEED_TO_LEAD_SERVICE_AREA_CITIES / _ZIP_PREFIXES (comma-separated) without a
// redeploy. A wrong classification here only routes a REAL-otherwise lead to
// REVIEW, never a hard rejection.
const DEFAULT_SERVICE_AREA_CITIES = [
    "vancouver", "camas", "battle ground", "ridgefield", "washougal",
    "la center", "yacolt", "brush prairie", "hazel dell", "felida",
    "portland", "gresham", "troutdale", "fairview", "beaverton",
];
const DEFAULT_SERVICE_AREA_ZIP_PREFIXES = ["986", "970", "972", "971"];

export function serviceAreaCities(env: NodeJS.ProcessEnv = process.env): string[] {
    const raw = env.SPEED_TO_LEAD_SERVICE_AREA_CITIES;
    if (!raw) return DEFAULT_SERVICE_AREA_CITIES;
    return raw.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
}

export function serviceAreaZipPrefixes(env: NodeJS.ProcessEnv = process.env): string[] {
    const raw = env.SPEED_TO_LEAD_SERVICE_AREA_ZIP_PREFIXES;
    if (!raw) return DEFAULT_SERVICE_AREA_ZIP_PREFIXES;
    return raw.split(",").map(s => s.trim()).filter(Boolean);
}

// ── Alerts (new in v1a — docs/plans/SPEED-TO-LEAD-V1A.md "(2) Alert design") ─

/** ntfy: priority sent for a plain, no-spam-signal lead. */
export const NTFY_PRIORITY_DEFAULT = "4";
/** ntfy: priority sent for a REVIEW lead carrying any spam signal — still delivered, never a Chat card. */
export const NTFY_PRIORITY_SPAM_SIGNAL = "2";

/** Alert retry backoff, in minutes, applied in order after an `unknown` outcome. */
export const ALERT_BACKOFF_MINUTES = [1, 2, 4, 8, 16, 30] as const;
/** A `SENDING` row older than this with no provider answer is reclaimable by the next cron run. */
export const ALERT_SENDING_STALE_MS = 2 * 60 * 1000;
/** An alert is DEAD after this many attempts, or SKIPPED if never attempted and the lead is this old. */
export const ALERT_MAX_ATTEMPTS = 12;
export const ALERT_MAX_LEAD_AGE_MS = 6 * 60 * 60 * 1000;

/** Every outbound alert HTTP call (ntfy, Chat) gets a clamped timeout. */
export const ALERT_POST_TIMEOUT_MS = 10_000;

/** Digest: sent once at this local hour, America/Los_Angeles (spec: the business's own local morning). */
export const DIGEST_HOUR_LOCAL = 9;
/** Digest: lists open feature-owned leads received within this window. */
export const DIGEST_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;
/** A digest day-claim row older than this with no "sent" marker is reclaimable by the next tick — a crash between claiming and releasing (or a failed release itself) would otherwise strand the claim for the rest of that local day. Comfortably above any real run's duration (bounded by ALERT_POST_TIMEOUT_MS plus a few DB round trips) and comfortably below the digest hour's own width. */
export const DIGEST_CLAIM_STALE_MS = 5 * 60 * 1000;
