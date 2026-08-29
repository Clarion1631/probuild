// Additive Build B migration for the computed Project projection fields.
// Safe to re-run while the old build is live: both columns are nullable and
// every ALTER is guarded with IF NOT EXISTS.
//
// Run manually before deploying a build that selects these fields:
//   node scripts/apply-project-projection-schema.mjs
//
// Do not replace this with prisma db push / migrate dev; see CLAUDE.md.
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export const statements = [
    `ALTER TABLE "Project"
       ADD COLUMN IF NOT EXISTS "projectedEndDate" TIMESTAMP(3),
       ADD COLUMN IF NOT EXISTS "projectedEndComputedAt" TIMESTAMP(3)`,
];

function resolveDatabaseUrl() {
    if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
    for (const file of [".env.local", ".env"]) {
        if (!fs.existsSync(file)) continue;
        const match = fs.readFileSync(file, "utf8").match(/^DATABASE_URL\s*=\s*"?([^"\n]+)"?/m);
        if (match) return match[1];
    }
    throw new Error("DATABASE_URL not found in process.env, .env.local, or .env");
}

export async function applyProjectProjectionSchema(prisma) {
    for (const sql of statements) {
        await prisma.$executeRawUnsafe(sql);
    }
}

async function main() {
    const prisma = new PrismaClient({ datasources: { db: { url: resolveDatabaseUrl() } } });
    try {
        await applyProjectProjectionSchema(prisma);
        console.log(`Done. ${statements.length} statement applied.`);
    } finally {
        await prisma.$disconnect();
    }
}

const isMainModule = Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === process.argv[1];
if (isMainModule) {
    main().catch(error => {
        console.error("Migration failed:", error);
        process.exitCode = 1;
    });
}
