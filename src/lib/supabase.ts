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
