import { test as setup } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const PROJECT_ID = "cmml6vt3y000lpwrh0p9p3k12";
const TEST_CLIENT_ID = "test-client-do-not-delete";
const SENTINEL_PATH = resolve(__dirname, ".anthropic-status");

setup("seed test data + probe anthropic", async () => {
    setup.setTimeout(60_000);

    const prisma = new PrismaClient();
    try {
        await prisma.client.upsert({
            where: { id: TEST_CLIENT_ID },
            update: {},
            create: {
                id: TEST_CLIENT_ID,
                name: "Test Client — DO NOT DELETE",
                initials: "TC",
                email: "test-client@goldentouchremodeling.com",
            },
        });

        await prisma.project.upsert({
            where: { id: PROJECT_ID },
            update: {},
            create: {
                id: PROJECT_ID,
                name: "Test Project — DO NOT DELETE (used by e2e)",
                clientId: TEST_CLIENT_ID,
                status: "In Progress",
            },
        });
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
