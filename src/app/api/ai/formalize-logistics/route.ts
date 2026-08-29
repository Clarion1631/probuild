import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { prisma } from "@/lib/prisma";
import { PROJECT_STATUS_IN_PROGRESS } from "@/lib/project-status";
import { createRateLimiter } from "@/app/api/ai/polish-notes/route";
import {
    buildFormalizePrompt,
    FormalizeOutputSchema,
    jobAliases,
    MAX_DUMP_LENGTH,
    sanitizeFormalizeOutput,
    type JobOption,
} from "@/lib/logistics-formalize";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// "Clean this up" for a Logistics clock-in dump (plan 02): returns the
// formalized note, a category, and — when the dump names a job — the job it
// was really for, so the entry can be re-costed off overhead. Never applies
// anything: the worker confirms on the phone (PATCH /api/time-entries/[id]/
// logistics), a manager can re-route later (/manager/logistics).
//
// Model per plan 02: claude-sonnet-5 (short, cheap, JSON-schema-enforced,
// tool-less). The dump is fenced as untrusted data — see
// src/lib/logistics-formalize.ts for the injection posture.

const checkRateLimit = createRateLimiter();

export async function POST(req: Request) {
    const { authenticateMobileOrSession } = await import("@/lib/mobile-auth");
    const auth = await authenticateMobileOrSession(req);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

    let body: unknown;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    const rawDump = (body as { dump?: unknown } | null)?.dump;
    const dump = typeof rawDump === "string" ? rawDump.trim() : "";
    if (!dump) return NextResponse.json({ error: "dump is required" }, { status: 400 });
    if (dump.length > MAX_DUMP_LENGTH) {
        return NextResponse.json({ error: `dump must be ${MAX_DUMP_LENGTH} characters or fewer` }, { status: 400 });
    }
    if (!checkRateLimit(auth.user.id)) {
        return NextResponse.json({ error: "Too many requests — try again later" }, { status: 429 });
    }
    if (!process.env.ANTHROPIC_API_KEY) {
        return NextResponse.json({ error: "ANTHROPIC_API_KEY not configured" }, { status: 500 });
    }

    // The jobs a run could be FOR: every In Progress, non-logistics project.
    const projects = await prisma.project.findMany({
        where: { status: PROJECT_STATUS_IN_PROGRESS, isLogistics: false },
        select: { id: true, name: true, client: { select: { name: true } } },
        orderBy: { name: "asc" },
    });
    const jobs: JobOption[] = projects.map((project) => ({ id: project.id, name: project.name, aliases: jobAliases(project) }));

    try {
        // Bounded well inside maxDuration (30s): one retry, 20s each way at most.
        const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 20_000, maxRetries: 1 });
        const response = await client.messages.parse({
            model: "claude-sonnet-5",
            // Sonnet 5 thinks adaptively by default and that counts against
            // max_tokens: a multi-job dump exhausted 1024 and parsed as null in
            // testing. Formatting a paragraph is a low-effort task.
            max_tokens: 4096,
            messages: [
                {
                    role: "user",
                    content: buildFormalizePrompt({
                        dump,
                        jobs,
                        today: new Date().toLocaleDateString("en-US", { timeZone: "America/Los_Angeles" }),
                    }),
                },
            ],
            output_config: { format: zodOutputFormat(FormalizeOutputSchema), effort: "low" },
        });
        if (!response.parsed_output) {
            return NextResponse.json({ error: "Could not clean this up right now — you can still submit your own words" }, { status: 502 });
        }
        const result = sanitizeFormalizeOutput(response.parsed_output, jobs);
        return NextResponse.json({ original: dump, ...result, jobs: jobs.map(({ id, name }) => ({ id, name })) });
    } catch (error: unknown) {
        console.error("AI formalize-logistics error:", error instanceof Error ? error.message : error);
        return NextResponse.json({ error: "Could not clean this up right now — you can still submit your own words" }, { status: 502 });
    }
}
