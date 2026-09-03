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

/** A row that may carry the PIN hash. Structural, so it fits every select shape. */
type MaybeWithPin = { pinCode?: string | null } & Record<string, unknown>;

/**
 * Drop `pinCode`, report only WHETHER one is set.
 *
 * `hasPin` is the fact the Team Members UI actually renders ("PIN set" /
 * "no PIN"), and it is derivable from the hash without carrying it.
 */
export function toSafeUser<T extends MaybeWithPin>(user: T): Omit<T, "pinCode"> & { hasPin: boolean } {
    const { pinCode, ...rest } = user;
    return { ...(rest as Omit<T, "pinCode">), hasPin: !!pinCode };
}

/** Null-tolerant, for the `findUnique` shapes that can miss. */
export function toSafeUserOrNull<T extends MaybeWithPin>(
    user: T | null | undefined
): (Omit<T, "pinCode"> & { hasPin: boolean }) | null {
    return user ? toSafeUser(user) : null;
}
