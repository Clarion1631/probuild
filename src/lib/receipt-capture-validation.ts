// The capture-time facts a front door has to normalise, in ONE place.
//
// The phase gate itself lives in receipt-intake/late-fields.ts (`authorizePhase`),
// which every door — inline POST /api/receipts/intake, POST .../start, and
// POST .../[id]/finalize — calls after it has authorized the project.
//
// What is left here is the one capture fact with no gate of its own:
// `installedAtCustomer` decides whether a receipt is claimed on a state excise
// return, so "the caller did not say" has to survive as NULL rather than
// collapsing to false.
/**
 * Accept a boolean from either a JSON body (a real boolean) or a multipart form
 * (where everything is a string). Anything else — including a missing key — is
 * "the caller did not say", which is NOT the same as "no" and is stored as
 * NULL. Nothing defaults it: an unanswered receipt must never be claimed.
 */
export function optionalBool(value: unknown): boolean | null {
    if (typeof value === "boolean") return value;
    if (value === "true") return true;
    if (value === "false") return false;
    return null;
}


/**
 * WHO supplied a captured phase.
 *
 * A signed-in person picking a phase on their phone is an ANSWER. A
 * shared-secret forwarder resolving one from a Drive folder name or a mail rule
 * is a GUESS that happens to arrive at capture time, and it has no more
 * standing than the suggester's. Booking copies the distinction onto the
 * Expense, where "capture" is untouchable and a machine's phase stays
 * correctable by the backfill and the QBO suggester.
 *
 * Recorded at the door, because that is the only place the caller's identity is
 * still in hand.
 */
export function captureActorSource(via: "session" | "secret"): "user" | "machine" {
    return via === "session" ? "user" : "machine";
}
