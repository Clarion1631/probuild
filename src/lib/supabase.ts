import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { createStorageMockClient } from "./supabase-storage-mock";

export const STORAGE_BUCKET = "project-files";

// Lazy-initialize Supabase client so env vars are read at runtime, not build time
let _supabase: SupabaseClient | null = null;
let _initialized = false;

/**
 * True only in a test environment: the explicit opt-in flag, off Vercel, AND
 * the Playwright test-auth secret present. The third condition exists because
 * this mock is more dangerous than SELECTION_AI_MOCK if it ever engaged in a
 * real deployment — uploads would "succeed" into process memory and the data
 * would be silently lost — so the gate requires an independent marker that
 * only test environments set (the same secret that enables the e2e
 * credentials login in src/lib/auth.ts). e2e specs must use this exact
 * predicate (not re-derive it) so skip conditions can't drift from runtime.
 */
export function isE2eStorageMockEnabled(): boolean {
    return (
        process.env.E2E_STORAGE_MOCK === "1" &&
        !process.env.VERCEL &&
        !!process.env.PLAYWRIGHT_TEST_SECRET
    );
}

/**
 * A client whose every request carries an AbortSignal.
 *
 * `getSupabase()` returns a process-wide singleton, and storage-js exposes no
 * per-call signal — `download`/`upload`/`remove`/`list`/`createSignedUploadUrl`
 * take no request options at all. So a caller that needs to bound a storage
 * call gets its OWN client, built over a fetch that injects the signal. The
 * construction is config only (no network, no auth round trip), which is what
 * makes per-call cheap enough to be the rule rather than an optimisation.
 *
 * The e2e mock is returned unchanged: it never touches the network, so there
 * is nothing to abort and building a real client would defeat the gate.
 */
export function getSupabaseWithSignal(signal: AbortSignal): SupabaseClient | null {
    if (isE2eStorageMockEnabled()) return getSupabase();

    const supabaseUrl = process.env.SUPABASE_URL || "";
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY || "";
    if (!supabaseUrl || !supabaseKey) return null;

    return createClient(supabaseUrl, supabaseKey, {
        global: {
            fetch: (input: RequestInfo | URL, init?: RequestInit) =>
                fetch(input, { ...init, signal }),
        },
    });
}

export function getSupabase(): SupabaseClient | null {
    if (_initialized) return _supabase;
    _initialized = true;

    // Hermetic in-memory storage for e2e (CI's Playwright job) — see
    // supabase-storage-mock.ts and the gate's own doc comment above.
    if (isE2eStorageMockEnabled()) {
        _supabase = createStorageMockClient();
        return _supabase;
    }

    const supabaseUrl = process.env.SUPABASE_URL || "";
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY || "";

    if (supabaseUrl && supabaseKey) {
        _supabase = createClient(supabaseUrl, supabaseKey);
    }

    return _supabase;
}

// Backward compat alias
export const supabase = null as SupabaseClient | null; // not used anymore - use getSupabase()
