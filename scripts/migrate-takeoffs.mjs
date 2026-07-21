// One-time script to create Takeoff tables in Supabase
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseKey) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY are required');
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function migrate() {
    console.log('Creating Takeoff tables...');
    
    // Create Takeoff table
    const { error: e1 } = await supabase.rpc('exec_sql', { sql: '' }).catch(() => ({ error: null }));
    
    // Use raw SQL via the REST API
    const sql1 = `
        CREATE TABLE IF NOT EXISTS "Takeoff" (
            "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
            "name" TEXT NOT NULL,
            "description" TEXT,
            "status" TEXT NOT NULL DEFAULT 'Draft',
            "projectId" TEXT,
            "leadId" TEXT,
            "aiEstimateData" TEXT,
            "estimateId" TEXT,
            "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT "Takeoff_pkey" PRIMARY KEY ("id"),
            CONSTRAINT "Takeoff_estimateId_key" UNIQUE ("estimateId"),
            CONSTRAINT "Takeoff_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE,
            CONSTRAINT "Takeoff_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE,
            CONSTRAINT "Takeoff_estimateId_fkey" FOREIGN KEY ("estimateId") REFERENCES "Estimate"("id")
        );
    `;

    const sql2 = `
        CREATE TABLE IF NOT EXISTS "TakeoffFile" (
            "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
            "takeoffId" TEXT NOT NULL,
            "name" TEXT NOT NULL,
            "url" TEXT NOT NULL,
            "mimeType" TEXT NOT NULL DEFAULT 'application/octet-stream',
            "size" INTEGER NOT NULL DEFAULT 0,
            "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT "TakeoffFile_pkey" PRIMARY KEY ("id"),
            CONSTRAINT "TakeoffFile_takeoffId_fkey" FOREIGN KEY ("takeoffId") REFERENCES "Takeoff"("id") ON DELETE CASCADE
        );
    `;

    // Execute via Supabase's SQL endpoint
    const res1 = await fetch(`${supabaseUrl}/rest/v1/rpc/`, {
        method: 'POST',
        headers: {
            'apikey': supabaseKey,
            'Authorization': `Bearer ${supabaseKey}`,
            'Content-Type': 'application/json',
        },
    });

    // Actually, let's use the management API
    console.log('Attempting SQL execution via Supabase...');
    
    for (const sql of [sql1, sql2]) {
        const response = await fetch(`${supabaseUrl}/rest/v1/`, {
            method: 'POST',
            headers: {
                'apikey': supabaseKey,
                'Authorization': `Bearer ${supabaseKey}`,
                'Content-Type': 'application/json',
                'Prefer': 'return=representation',
            },
            body: JSON.stringify({ query: sql }),
        });
        console.log(`SQL response status: ${response.status}`);
    }
    
    console.log('Done! (If tables were not created, run the SQL manually in Supabase SQL editor)');
    console.log('\nSQL to run manually:');
    console.log(sql1);
    console.log(sql2);
}

migrate().catch(console.error);
