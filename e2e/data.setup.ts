import { test as setup } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { assertNotProdDatabase } from "../src/lib/db-guard";

const PROJECT_ID = "cmml6vt3y000lpwrh0p9p3k12";
const TEST_CLIENT_ID = "test-client-do-not-delete";
const SENTINEL_PATH = resolve(__dirname, ".anthropic-status");

setup("seed test data + probe anthropic", async () => {
    setup.setTimeout(60_000);

    console.log("[data.setup] DATABASE_URL set:", !!process.env.DATABASE_URL);
    console.log("[data.setup] DATABASE_URL host:", (process.env.DATABASE_URL || "").match(/@([^:/?]+)/)?.[1] ?? "(none)");

    // e2e must run against a dedicated test/branch database, never prod. Fail loudly if
    // DATABASE_URL points at production (CI should set TEST_DATABASE_URL). See src/lib/db-guard.ts.
    assertNotProdDatabase("e2e/data.setup.ts");

    const prisma = new PrismaClient();
    try {
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
