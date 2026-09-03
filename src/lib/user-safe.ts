/**
 * The one place a User row is made safe to send to a browser or the mobile app.
 *
 * `User.pinCode` is a bcrypt hash of the time-clock PIN. It must never leave the
 * server — `/api/users` GET already replaced it with a boolean, but the POST,
 * `/api/users/[id]` GET and PUT handlers returned the raw row. Every handler that
 * returns a User now goes through this helper, so there is exactly one shape.
 */
export function toSafeUser<T extends { pinCode?: string | null }>(user: T): Omit<T, "pinCode"> & { hasPin: boolean } {
    const { pinCode, ...rest } = user;
    return { ...rest, hasPin: !!pinCode };
}
