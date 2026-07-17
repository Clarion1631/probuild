import { test as setup } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const PROJECT_ID = "cmml6vt3y000lpwrh0p9p3k12";
const ESTIMATE_ID = "cmml6vtx7001dpwrh8n65xzy6";
const TEST_CLIENT_ID = "test-client-do-not-delete";
const ADMIN_EMAIL = "jadkins@goldentouchremodeling.com";
const DEV_ADMIN_EMAIL = "gtrsupport@goldentouchremodeling.com";
const SENTINEL_PATH = resolve(__dirname, ".anthropic-status");

// Substrings that identify the LIVE database. The e2e suite creates leads,
// estimates, and invoices — it must never do that against production data.
// See docs/TESTING.md (the Henderson-lead incident, June 2026).
const PROD_DB_MARKERS = ["supabase.co", "supabase.com", "ghzdbzdnwjxazvmcefbh"];

function resolveDatabaseUrl(): string {
    if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
    // Plain Playwright processes don't load .env — mirror what the dev server
    // (and Prisma Client) will resolve so the guard checks the real target.
    const envPath = resolve(__dirname, "..", ".env");
    if (existsSync(envPath)) {
        const line = readFileSync(envPath, "utf8")
            .split(/\r?\n/)
            .find((l) => /^\s*DATABASE_URL\s*=/.test(l));
        if (line) return line.split("=").slice(1).join("=").trim().replace(/^["']|["']$/g, "");
    }
    return "";
}

setup("guard prod DB + seed test data + probe anthropic", async () => {
    setup.setTimeout(60_000);

    const dbUrl = resolveDatabaseUrl();
    const dbHost = dbUrl.match(/@([^:/?]+)/)?.[1] ?? "(none)";
    console.log("[data.setup] DATABASE_URL host:", dbHost);

    if (PROD_DB_MARKERS.some((m) => dbUrl.includes(m)) && process.env.ALLOW_PROD_E2E !== "1") {
        throw new Error(
            `[data.setup] REFUSING TO RUN: DATABASE_URL points at the live database (${dbHost}).\n` +
                `E2E tests create leads/estimates/invoices and must run against a disposable DB.\n` +
                `Options:\n` +
                `  - CI: already uses a throwaway Postgres service container (see .github/workflows/ci.yml)\n` +
                `  - Local: docker run --rm -d -p 5433:5432 -e POSTGRES_PASSWORD=probuild postgres:16\n` +
                `           then DATABASE_URL=postgresql://postgres:probuild@localhost:5433/postgres npx prisma db push\n` +
                `           and run Playwright with that same DATABASE_URL.\n` +
                `  - Override (discouraged; teardown will clean up): set ALLOW_PROD_E2E=1\n` +
                `See docs/TESTING.md.`
        );
    }

    const prisma = new PrismaClient();
    try {
        // Admin user — required by the PLAYWRIGHT_TEST_SECRET credentials
        // provider (auth.setup.ts logs in as this email).
        const admin = await prisma.user.upsert({
            where: { email: ADMIN_EMAIL },
            update: {},
            create: {
                email: ADMIN_EMAIL,
                name: "Justin Adkins",
                role: "ADMIN",
                status: "ACTIVATED",
            },
        });
        console.log("[data.setup] admin user upserted:", { id: admin.id, email: admin.email });

        // Development mode intentionally falls back to this known ADMIN.
        // Keep it database-backed so permission and status guards exercise the
        // same path as real staff while the local UI remains usable pre-login.
        await prisma.user.upsert({
            where: { email: DEV_ADMIN_EMAIL },
            update: { role: "ADMIN", status: "ACTIVATED" },
            create: {
                email: DEV_ADMIN_EMAIL,
                name: "GTR Support",
                role: "ADMIN",
                status: "ACTIVATED",
            },
        });

        const client = await prisma.client.upsert({
            where: { id: TEST_CLIENT_ID },
            update: {},
            create: {
                id: TEST_CLIENT_ID,
                name: "Test Client — DO NOT DELETE",
                initials: "TC",
                email: "test-client@goldentouchremodeling.com",
            },
        });
        console.log("[data.setup] client upserted:", { id: client.id, name: client.name });

        const project = await prisma.project.upsert({
            where: { id: PROJECT_ID },
            update: {},
            create: {
                id: PROJECT_ID,
                name: "Test Project — DO NOT DELETE (used by e2e)",
                clientId: TEST_CLIENT_ID,
                status: "In Progress",
            },
        });
        console.log("[data.setup] project upserted:", { id: project.id, name: project.name, clientId: project.clientId });

        // Baseline estimate — several specs navigate to this ID as a fallback.
        const estimate = await prisma.estimate.upsert({
            where: { id: ESTIMATE_ID },
            update: {},
            create: {
                id: ESTIMATE_ID,
                title: "E2E Baseline Estimate — DO NOT DELETE",
                code: "EST-E2E",
                status: "Sent",
                projectId: PROJECT_ID,
                totalAmount: 0,
                balanceDue: 0,
            },
        });
        console.log("[data.setup] estimate upserted:", { id: estimate.id, title: estimate.title });

        const verify = await prisma.project.findUnique({ where: { id: PROJECT_ID }, select: { id: true, name: true } });
        console.log("[data.setup] verify project exists:", verify);
    } catch (e) {
        console.error("[data.setup] DB upsert failed:", (e as Error).message);
        throw e;
    } finally {
        await prisma.$disconnect();
    }

    const key = process.env.ANTHROPIC_API_KEY;
    let status: "ok" | "invalid" = "invalid";
    if (key) {
        try {
            const res = await fetch("https://api.anthropic.com/v1/messages", {
                method: "POST",
                headers: {
                    "x-api-key": key,
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json",
                },
                body: JSON.stringify({
                    model: "claude-haiku-4-5-20251001",
                    max_tokens: 1,
                    messages: [{ role: "user", content: "hi" }],
                }),
            });
            if (res.ok) status = "ok";
        } catch {
            status = "invalid";
        }
    }

    mkdirSync(dirname(SENTINEL_PATH), { recursive: true });
    writeFileSync(SENTINEL_PATH, status, "utf8");
});
