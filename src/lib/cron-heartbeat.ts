/**
 * External heartbeat pings for money-touching cron jobs (Healthchecks.io-style
 * dead man's switch): `/start` when a run begins, a plain ping when it finishes
 * cleanly, `/fail` when it errors. Each job reads its own
 * `HC_PING_URL_<JOB_KEY>` — unset is a no-op, so this is opt-in per job and
 * costs nothing where it is not configured.
 *
 * Never throws and never hangs a cron: every request carries its own timeout,
 * and a network failure or non-2xx response is swallowed (logged, not thrown)
 * — a monitoring ping must never be the reason a money cron fails or its
 * response changes.
 */

const PING_TIMEOUT_MS = 5_000;
/** Keep the /fail body short regardless of what the caller passes in. */
const MAX_DETAIL_LENGTH = 500;

export type HeartbeatPhase = "start" | "success" | "fail";

function pingUrl(jobKey: string, phase: HeartbeatPhase): string | undefined {
    const base = process.env[`HC_PING_URL_${jobKey}`];
    if (!base || !base.trim()) return undefined;
    const trimmed = base.trim();
    if (phase === "start") return `${trimmed}/start`;
    if (phase === "fail") return `${trimmed}/fail`;
    return trimmed;
}

/**
 * Ping the heartbeat URL for `jobKey`. Callers await this (the timeout below
 * is what bounds that await, so nothing is left as a dangling promise Vercel
 * could kill mid-flight).
 *
 * `detail` is sent as the request body on a `"fail"` ping only, and callers
 * must pass something already safe to leave the app — a short reason code or
 * `error.name`, never a raw message, stack, or request payload that could
 * carry secrets or PII. This function truncates it further as a backstop, not
 * as the redaction step.
 */
export async function pingCronHeartbeat(
    jobKey: string,
    phase: HeartbeatPhase,
    detail?: string,
): Promise<void> {
    const url = pingUrl(jobKey, phase);
    if (!url) return;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            method: "POST",
            body: phase === "fail" && detail ? detail.slice(0, MAX_DETAIL_LENGTH) : undefined,
            signal: controller.signal,
        });
        if (!res.ok) {
            console.error("[cron-heartbeat] ping responded with an error status", {
                jobKey,
                phase,
                status: res.status,
            });
        }
    } catch (error) {
        console.error("[cron-heartbeat] ping failed", {
            jobKey,
            phase,
            error: error instanceof Error ? error.name : "UnknownError",
        });
    } finally {
        clearTimeout(timer);
    }
}
