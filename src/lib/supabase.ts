import { createClient } from "@supabase/supabase-js";

// Extract Supabase project URL from the DATABASE_URL
// Format: postgresql://postgres.PROJECT_REF:PASSWORD@aws-0-REGION.pooler.supabase.com:5432/postgres
function getSupabaseConfig() {
    const dbUrl = process.env.DATABASE_URL || "";
    // Extract the project ref from the user part: postgres.PROJECT_REF
    const match = dbUrl.match(/postgres\.([^:]+):/);
    const projectRef = match?.[1] || "";

    const supabaseUrl = process.env.SUPABASE_URL || `https://${projectRef}.supabase.co`;
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || "";

    return { supabaseUrl, supabaseKey };
}

const { supabaseUrl, supabaseKey } = getSupabaseConfig();

export const supabase = supabaseKey
    ? createClient(supabaseUrl, supabaseKey)
    : null;

export const STORAGE_BUCKET = "project-files";
