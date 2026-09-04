// Serializing a User row to a client.
//
// `User.pinCode` is a BCRYPT HASH of the crew app's login PIN. Several routes
// returned a full Prisma User row — POST /api/users answered 201 with one, and
// GET/PUT /api/users/[id] returned one — so a password-equivalent hash was in
// the response body of ordinary admin screens. GET /api/users already stripped
// it and reported `hasPin` instead; this is that same rule, in one place, so
// the next route cannot be the one that forgets.
//
// The hash is never returned to ANYONE. "Only admins can see it" is not a
// reason to ship a credential to a browser, a log, or a proxy cache.
//
// ONE IMPLEMENTATION. This branch and main (#459) closed the same hole at the
// same time, under two filenames. `src/lib/user-safe.ts` is the survivor and
// this module RE-EXPORTS it rather than keeping a second stripper: two helpers
// that both claim to be "the one place" is how they come to disagree about a
// field, and a divergence here ships a credential.

export { toSafeUser } from "./user-safe";
import { toSafeUser } from "./user-safe";

/**
 * Null-tolerant, for the `findUnique` shapes that can miss.
 *
 * The only thing this module still adds. `toSafeUser` itself is main's.
 */
export function toSafeUserOrNull<T extends { pinCode?: string | null }>(
    user: T | null | undefined
): (Omit<T, "pinCode"> & { hasPin: boolean }) | null {
    return user ? toSafeUser(user) : null;
}
