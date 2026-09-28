/**
 * Front Desk v1 §3.2 — every TwiML response the bridge number's Voice URL
 * returns, plus the sanitization that keeps caller-supplied text (name,
 * project, city — ultimately model output) from ever landing unescaped in
 * XML. `escapeXmlText`/`escapeXmlAttr` run on every value this module puts
 * into a document; nothing here string-concatenates a raw field.
 */
import { FRONT_DESK_SCREEN_TEXT_MAX_LEN, FRONT_DESK_TRANSFER_RING_TIMEOUT_S, FRONT_DESK_TRANSFER_SCREEN_GATHER_TIMEOUT_S } from "./constants";

/** Text-node escaping: `&`, `<`, `>`. */
export function escapeXmlText(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Attribute-value escaping: text escaping plus `"`. URLs built into `action`/`url` attributes go through this — `&` in a query string becomes `&amp;`. */
export function escapeXmlAttr(value: string): string {
    return escapeXmlText(value).replace(/"/g, "&quot;");
}

/**
 * §3.2 "screen": caller-supplied text (ultimately the model's own words) cut
 * to `[A-Za-z0-9 .,'-]` and a fixed length, so it can never inject TwiML or
 * odd speech into the `<Say>` Richard hears.
 */
export function sanitizeScreenText(value: string, maxLen: number = FRONT_DESK_SCREEN_TEXT_MAX_LEN): string {
    return value.replace(/[^A-Za-z0-9 .,'-]/g, "").slice(0, maxLen);
}

export function xmlResponse(body: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`;
}

/** `<Response><Reject/></Response>` — every guard failure in §3.2. */
export function rejectTwiml(): string {
    return xmlResponse("<Reject/>");
}

export function hangupTwiml(): string {
    return xmlResponse("<Hangup/>");
}

/**
 * §3.2 step "inbound": the `<Dial>`/`<Number>` pair. `baseUrl` has no
 * trailing slash; `transferId` and every URL go through `escapeXmlAttr`.
 */
export function inboundDialTwiml(params: { baseUrl: string; bridgeE164: string; richardE164: string; transferId: string }): string {
    const { baseUrl, bridgeE164, richardE164, transferId } = params;
    const actionUrl = `${baseUrl}/api/front-desk/bridge-twiml?step=action&t=${encodeURIComponent(transferId)}`;
    const screenUrl = `${baseUrl}/api/front-desk/bridge-twiml?step=screen&t=${encodeURIComponent(transferId)}`;
    return xmlResponse(
        `<Dial answerOnBridge="true" timeout="${FRONT_DESK_TRANSFER_RING_TIMEOUT_S}" callerId="${escapeXmlAttr(bridgeE164)}" method="POST" action="${escapeXmlAttr(actionUrl)}">`
        + `<Number method="POST" url="${escapeXmlAttr(screenUrl)}">${escapeXmlText(richardE164)}</Number>`
        + `</Dial>`,
    );
}

/**
 * §3.2 "screen": the press-1 challenge Richard hears. `actionOnEmptyResult="false"`
 * means silence falls through to the trailing `<Hangup/>` rather than
 * re-POSTing with empty Digits.
 */
export function screenGatherTwiml(params: { baseUrl: string; transferId: string; isTest: boolean; callerFirstName: string; project: string; city: string; spanish: boolean }): string {
    const { baseUrl, transferId, isTest, callerFirstName, project, city, spanish } = params;
    const actionUrl = `${baseUrl}/api/front-desk/bridge-twiml?step=screen-result&t=${encodeURIComponent(transferId)}`;
    const testPrefix = isTest ? "Test call. " : "";
    const spanishNote = spanish ? " Spanish speaker." : "";
    const say = `${testPrefix}Golden Touch front desk: ${sanitizeScreenText(callerFirstName)}, ${sanitizeScreenText(project)} in ${sanitizeScreenText(city)}.${spanishNote} This call is recorded. Press 1 to take it.`;
    return xmlResponse(
        `<Gather numDigits="1" timeout="${FRONT_DESK_TRANSFER_SCREEN_GATHER_TIMEOUT_S}" actionOnEmptyResult="false" method="POST" action="${escapeXmlAttr(actionUrl)}">`
        + `<Say>${escapeXmlText(say)}</Say>`
        + `</Gather>`
        + `<Hangup/>`,
    );
}

/** §3.2 "screen-result", accepted: no `<Hangup/>` — the document ends without one, so the legs bridge. */
export function screenAcceptedTwiml(): string {
    return xmlResponse("<Say>Connecting.</Say>");
}

/** §3.2 "screen-result", anything else: hangs up Richard's leg only. */
export function screenRejectedTwiml(): string {
    return hangupTwiml();
}

/** §3.2 "action", CONNECTED or MISSED with the miss line off. */
export function actionHangupTwiml(): string {
    return hangupTwiml();
}

/** §3.2 "action", MISSED with `FRONT_DESK_MISS_LINE=ON` (P§3 test #1 result B). */
export function actionMissLineTwiml(): string {
    return xmlResponse(
        "<Say>Richard couldn't pick up. He has your details and will call you back shortly. You can also book at goldentouchremodeling.com.</Say><Hangup/>",
    );
}
