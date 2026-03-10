import { createClient, SupabaseClient } from "@supabase/supabase-js";

export const STORAGE_BUCKET = "project-files";

// Lazy-initialize Supabase client so env vars are read at runtime, not build time
let _supabase: SupabaseClient | null = null;
let _initialized = false;

export function getSupabase(): SupabaseClient | null {
    if (_initialized) return _supabase;
    _initialized = true;

    const supabaseUrl = process.env.SUPABASE_URL || "";
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY || "";

    console.log("[Supabase] Init:", { hasUrl: !!supabaseUrl, hasKey: !!supabaseKey, urlPrefix: supabaseUrl.substring(0, 30) });

    if (supabaseUrl && supabaseKey) {
        _supabase = createClient(supabaseUrl, supabaseKey);
    }

    return _supabase;
}

// Backward compat alias
export const supabase = null as SupabaseClient | null; // not used anymore - use getSupabase()
