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
