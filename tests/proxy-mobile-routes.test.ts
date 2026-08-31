/**
 * Pins the proxy's Bearer allowlist for the crew app's time-entry routes.
 *
 * 2026-08-30: the skip-lunch request failed from app.goldentouchremodeling.com with
 * "Couldn't send" because /api/time-entries/[id]/meal-skip was NOT on the allowlist —
 * the proxy answered the Bearer POST with a 307 to /login. Same for [id]/logistics.
 * These tests make sure both sub-routes stay allowlisted and that the allowlist does
 * not silently widen to arbitrary descendants.
 *
 * src/proxy.ts imports @/lib/staff-status (prisma) statically, so this file sets the
 * env prisma/next-auth expect before the dynamic import; nothing here hits a database.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NEXTAUTH_SECRET ??= "test-secret";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";

// Dynamic import (no top-level await — tsx transpiles this file as CJS).
const loadProxy = () => import("../src/proxy");

test("time-entry routes the crew app calls with a Bearer token are allowlisted", async () => {
    const { isMobileAuthenticatedRoute } = await loadProxy();
    for (const path of [
        "/api/time-entries",
        "/api/time-entries/",
        "/api/time-entries/abc123",
        "/api/time-entries/abc123/",
        "/api/time-entries/abc123/meal-skip",
        "/api/time-entries/abc123/meal-skip/",
        "/api/time-entries/abc123/logistics",
    ]) {
        assert.equal(isMobileAuthenticatedRoute(path), true, path);
    }
});

test("the allowlist does not widen to other time-entry descendants", async () => {
    const { isMobileAuthenticatedRoute } = await loadProxy();
    for (const path of [
        "/api/time-entries/abc123/other",
        "/api/time-entries/abc123/meal-skip/extra",
        "/api/time-entries/abc123/logistics/extra",
        "/api/time-entries/abc123/meal-skipx",
        "/api/time-entriesx",
        "/api/manager/time-entries",
    ]) {
        assert.equal(isMobileAuthenticatedRoute(path), false, path);
    }
});
