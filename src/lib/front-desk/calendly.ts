/**
 * Front Desk v1 — Calendly HTTP client and Richard's token config (§2.1,
 * §2.2, §2.3, §2.4). Every call carries its own timeout; nothing here throws
 * on a normal HTTP failure — callers get a typed outcome instead (§2.2
 * step 5's table is exactly this module's `CreateInviteeOutcome`).
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { decryptObject } from "@/lib/crypto";
import { FRONT_DESK_CALENDLY_AVAILABILITY_TIMEOUT_MS, FRONT_DESK_CALENDLY_POST_TIMEOUT_MS, FRONT_DESK_CALENDLY_TOKEN_CHECK_TIMEOUT_MS, FRONT_DESK_PACIFIC_TZ } from "./constants";

type Db = PrismaClient | Prisma.TransactionClient;

export const CALENDLY_API_BASE = "https://api.calendly.com";

export interface FrontDeskCalendlyConfig {
    token: string;
    userUri: string;
    eventTypeUri: string;
}

/**
 * §2.1 gate: `FRONT_DESK_BOOKING=ON`, the token decrypts, and the right
 * event URI (live or the secret test copy) is set. A decrypt failure — an
 * unset token, or `NEXTAUTH_SECRET` rotated (§2.4 "Key rotation") — reads as
 * "not configured", never a thrown error.
 */
export async function loadFrontDeskCalendlyConfig(db: Db, opts: { isTest: boolean }): Promise<FrontDeskCalendlyConfig | null> {
    const settings = await db.companySettings.findUnique({
        where: { id: "singleton" },
        select: {
            frontDeskCalendlyTokenEnc: true,
            frontDeskCalendlyUserUri: true,
            frontDeskCalendlyEventTypeUri: true,
            frontDeskCalendlyTestEventTypeUri: true,
        },
    });
    if (!settings?.frontDeskCalendlyTokenEnc || !settings.frontDeskCalendlyUserUri) return null;
    const eventTypeUri = opts.isTest ? settings.frontDeskCalendlyTestEventTypeUri : settings.frontDeskCalendlyEventTypeUri;
    if (!eventTypeUri) return null;

    let token: unknown;
    try {
        token = decryptObject(settings.frontDeskCalendlyTokenEnc)?.token;
    } catch {
        return null;
    }
    if (typeof token !== "string" || !token) return null;

    return { token, userUri: settings.frontDeskCalendlyUserUri, eventTypeUri };
}

// ── Low-level HTTP ───────────────────────────────────────────────────────

export type CalendlyGetResult<T> =
    | { kind: "ok"; data: T }
    | { kind: "http"; status: number }
    | { kind: "timeout" }
    | { kind: "network" };

async function calendlyGet<T>(token: string, path: string, timeoutMs: number): Promise<CalendlyGetResult<T>> {
    let res: Response;
    try {
        res = await fetch(`${CALENDLY_API_BASE}${path}`, {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch (err) {
        if (err instanceof Error && err.name === "TimeoutError") return { kind: "timeout" };
        return { kind: "network" };
    }
    if (!res.ok) return { kind: "http", status: res.status };
    try {
        const data = (await res.json()) as T;
        return { kind: "ok", data };
    } catch {
        return { kind: "network" };
    }
}

// ── §2.1 availability ────────────────────────────────────────────────────

export interface CalendlyAvailableTime {
    status: string;
    invitee_remaining: number;
    scheduling_url?: string;
    start_time: string;
}

export async function getAvailableTimes(
    token: string,
    eventTypeUri: string,
    startIso: string,
    endIso: string,
): Promise<CalendlyGetResult<{ collection: CalendlyAvailableTime[] }>> {
    const qs = new URLSearchParams({ event_type: eventTypeUri, start_time: startIso, end_time: endIso });
    return calendlyGet(token, `/event_type_available_times?${qs.toString()}`, FRONT_DESK_CALENDLY_AVAILABILITY_TIMEOUT_MS);
}

// ── §2.2 step 4/5: create invitee ────────────────────────────────────────

export interface CreateInviteeParams {
    eventTypeUri: string;
    startTimeIso: string;
    name: string;
    email: string;
    phoneE164: string;
    /** `tracking.utm_content` — the FrontDeskBooking row id, so the reconciler can match it back (§2.3). */
    trackingContent: string;
}

export type CreateInviteeOutcome =
    | { kind: "created"; inviteeUri: string; eventUri: string; cancelUrl: string; rescheduleUrl: string }
    | { kind: "rejected"; status: 400 | 404 }
    | { kind: "auth" }
    | { kind: "plan" }
    | { kind: "rate_limited" }
    /** timeout, network error, or 5xx — §2.2's table maps every one of these to UNCERTAIN. */
    | { kind: "uncertain" };

/**
 * §2.2 step 4: never sends `text_reminder_number`, `event_guests` or
 * `questions_and_answers` (P§4) — the body below is the complete, fixed
 * shape, not assembled from caller-supplied extras.
 */
export async function createInvitee(token: string, params: CreateInviteeParams): Promise<CreateInviteeOutcome> {
    const body = {
        event_type: params.eventTypeUri,
        start_time: params.startTimeIso,
        invitee: { name: params.name, email: params.email, timezone: FRONT_DESK_PACIFIC_TZ },
        location: { kind: "outbound_call", location: params.phoneE164 },
        tracking: { utm_source: "gtr-front-desk", utm_content: params.trackingContent },
    };

    let res: Response;
    try {
        res = await fetch(`${CALENDLY_API_BASE}/invitees`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(FRONT_DESK_CALENDLY_POST_TIMEOUT_MS),
        });
    } catch {
        return { kind: "uncertain" };
    }

    if (res.status === 201) {
        try {
            const json = (await res.json()) as { resource?: { uri?: string }; event?: string; cancel_url?: string; reschedule_url?: string };
            const inviteeUri = json.resource?.uri;
            if (!inviteeUri) return { kind: "uncertain" };
            return {
                kind: "created",
                inviteeUri,
                eventUri: json.event ?? "",
                cancelUrl: json.cancel_url ?? "",
                rescheduleUrl: json.reschedule_url ?? "",
            };
        } catch {
            return { kind: "uncertain" };
        }
    }
    if (res.status === 400 || res.status === 404) return { kind: "rejected", status: res.status };
    if (res.status === 401) return { kind: "auth" };
    if (res.status === 403) return { kind: "plan" };
    if (res.status === 429) return { kind: "rate_limited" };
    // Every other status (5xx, or an unexpected 2xx/3xx/4xx) is treated as UNCERTAIN — the safe side per §2.2's table.
    return { kind: "uncertain" };
}

// ── §2.4 token verification ──────────────────────────────────────────────

export interface CalendlyUsersMe {
    resource: { uri: string; current_organization: string; scheduling_url?: string };
}
export interface CalendlyOrganization {
    resource: { uri: string; plan?: string; stage?: string };
}
export interface CalendlyEventType {
    uri: string;
    name: string;
    duration: number;
    active: boolean;
    scheduling_url: string;
    locations?: { kind?: string }[];
}

export async function getUsersMe(token: string): Promise<CalendlyGetResult<CalendlyUsersMe>> {
    return calendlyGet(token, "/users/me", FRONT_DESK_CALENDLY_TOKEN_CHECK_TIMEOUT_MS);
}

export async function getOrganization(token: string, organizationUri: string): Promise<CalendlyGetResult<CalendlyOrganization>> {
    const path = organizationUri.replace(CALENDLY_API_BASE, "");
    return calendlyGet(token, path, FRONT_DESK_CALENDLY_TOKEN_CHECK_TIMEOUT_MS);
}

export async function getEventTypes(token: string, userUri: string): Promise<CalendlyGetResult<{ collection: CalendlyEventType[] }>> {
    const qs = new URLSearchParams({ user: userUri, active: "true" });
    return calendlyGet(token, `/event_types?${qs.toString()}`, FRONT_DESK_CALENDLY_TOKEN_CHECK_TIMEOUT_MS);
}

// ── §2.3 reconciler reads ────────────────────────────────────────────────

export interface CalendlyScheduledEvent {
    uri: string;
}
export interface CalendlyScheduledEventInvitee {
    tracking?: { utm_content?: string };
}

export async function listScheduledEvents(
    token: string,
    userUri: string,
    minStartIso: string,
    maxStartIso: string,
): Promise<CalendlyGetResult<{ collection: CalendlyScheduledEvent[] }>> {
    const qs = new URLSearchParams({ user: userUri, min_start_time: minStartIso, max_start_time: maxStartIso, status: "active" });
    return calendlyGet(token, `/scheduled_events?${qs.toString()}`, FRONT_DESK_CALENDLY_AVAILABILITY_TIMEOUT_MS);
}

export async function listScheduledEventInvitees(
    token: string,
    scheduledEventUri: string,
): Promise<CalendlyGetResult<{ collection: CalendlyScheduledEventInvitee[] }>> {
    const uuid = scheduledEventUri.split("/").pop() ?? "";
    return calendlyGet(token, `/scheduled_events/${uuid}/invitees`, FRONT_DESK_CALENDLY_AVAILABILITY_TIMEOUT_MS);
}
