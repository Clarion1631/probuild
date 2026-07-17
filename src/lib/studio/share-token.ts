// Server-only helper for generating share tokens. Kept in its own file so
// the client bundle can import `share-url.ts` (buildShareUrl, isValidShareToken)
// without dragging `node:crypto` into the browser build.

import "server-only";
import { randomBytes } from "node:crypto";

/**
 * Generate a fresh share token. 128 bits of entropy expressed as 32 lower-case
 * hex chars — URL-safe, no padding, no `=`.
 */
export function generateShareToken(): string {
    return randomBytes(16).toString("hex");
}
