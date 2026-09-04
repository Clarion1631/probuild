/**
 * "The object is gone" vs "storage hiccuped" — the distinction that decides
 * whether a receipt is parked for a human and its dedup key RELEASED, or simply
 * retried.
 *
 * The expensive direction is the safe-looking one: Supabase returns 400 for a
 * malformed request, a bad JWT, an expired service key and assorted config
 * faults. Reading those as not-found would empty the queue into review on a key
 * rotation and unlock every strong key on the way out.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isNotFoundError } from "../src/lib/secure-storage";

test("an affirmative 404 is not-found", () => {
    assert.equal(isNotFoundError({ status: 404, message: "Not Found" }), true);
    assert.equal(isNotFoundError({ statusCode: "404", message: "anything" }), true);
    assert.equal(isNotFoundError({ statusCode: 404 }), true);
});

test("an explicit not-found ERROR CODE is not-found", () => {
    for (const code of ["NoSuchKey", "not_found", "NOT FOUND", "object_not_found", "EntityNotFound"]) {
        assert.equal(isNotFoundError({ error: code }), true, code);
    }
});

test("the exact not-found MESSAGE is not-found", () => {
    assert.equal(isNotFoundError({ message: "Object not found" }), true);
    assert.equal(isNotFoundError({ message: "The resource was not found" }), true);
});

test("400 is NOT evidence of absence, whatever it says", () => {
    // This is the regression. Every one of these used to be read as "gone".
    for (const error of [
        { status: 400, message: "Invalid JWT" },
        { status: 400, message: "invalid signature" },
        { status: 400, message: "Bucket not found" },
        { status: 400 },
    ]) {
        assert.equal(isNotFoundError(error), false, JSON.stringify(error));
    }
});

test("auth, rate-limit, server and network faults are all transient", () => {
    for (const error of [
        { status: 401, message: "Unauthorized" },
        { status: 403, message: "forbidden" },
        { status: 429, message: "Too Many Requests" },
        { status: 500, message: "Internal Error" },
        { status: 503, message: "Service Unavailable" },
        { message: "fetch failed" },
        { message: "socket hang up" },
    ]) {
        assert.equal(isNotFoundError(error), false, JSON.stringify(error));
    }
});

test("a message that merely CONTAINS 'not found' is not enough", () => {
    // Substring matching is how a config error ("bucket not found for this
    // project", "tenant not found") gets mistaken for a missing object.
    assert.equal(isNotFoundError({ message: "bucket not found for this project" }), false);
    assert.equal(isNotFoundError({ message: "tenant not found" }), false);
    assert.equal(isNotFoundError(null), false);
});
