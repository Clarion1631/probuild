import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { extractJsonObject } from "@/lib/ai-json";

export const maxDuration = 60;

const MIN_LOOKBACK_DAYS = 1;
const MAX_LOOKBACK_DAYS = 365;
const MAX_SUGGESTIONS = 15;
const CONFIDENCE_LEVELS = ["high", "medium", "low"] as const;

// Define the expected output schema for the AI response
const responseSchema = {
    type: "OBJECT",
    properties: {
        suggestions: {
            type: "ARRAY",
            description: "Potential change orders detected in the daily logs. Empty array if none qualify.",
            items: {
                type: "OBJECT",
                properties: {
                    title: {
                        type: "STRING",
                        description: "Short change order title (under 80 characters)."
                    },
                    description: {
                        type: "STRING",
                        description: "1-3 sentences summarizing what the client requested and why it is outside the original scope."
                    },
                    sourceLogDates: {
                        type: "ARRAY",
                        items: { type: "STRING" },
                        description: "ISO dates (YYYY-MM-DD) of the daily log entries that mention this scope change."
                    },
                    confidence: {
                        type: "STRING",
                        enum: ["high", "medium", "low"],
                        description: "high if the log explicitly attributes the request to the client, medium if implied, low if it's a guess."
                    }
                },
                required: ["title", "description", "sourceLogDates", "confidence"]
            }
        }
    },
    required: ["suggestions"]
};

export async function POST(req: NextRequest) {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        const body = await req.json();
        const { projectId, lookbackDays: rawLookbackDays } = body as {
            projectId?: string;
            lookbackDays?: number;
        };

        if (!projectId) {
            return NextResponse.json({ error: "projectId is required" }, { status: 400 });
        }

        const lookbackDays = Math.min(
            MAX_LOOKBACK_DAYS,
            Math.max(MIN_LOOKBACK_DAYS, Number.isFinite(rawLookbackDays) ? Number(rawLookbackDays) : 30)
        );

        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
            return NextResponse.json({ error: "GEMINI_API_KEY not configured" }, { status: 500 });
        }

        const project = await prisma.project.findUnique({
            where: { id: projectId },
            select: { id: true, name: true, type: true },
        });
        if (!project) {
            return NextResponse.json({ error: "Project not found" }, { status: 404 });
        }

        // Resolve the estimate a suggested draft CO would attach to — every
        // ChangeOrder requires an estimateId (schema constraint), so pick the
        // project's Approved estimate, falling back to the most recent one.
        const estimates = await prisma.estimate.findMany({
            where: { projectId, archivedAt: null },
            select: { id: true, code: true, status: true },
            orderBy: { createdAt: "desc" },
        });
        const targetEstimate = estimates.find(e => e.status === "Approved") || estimates[0] || null;

        const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
        const dailyLogs = await prisma.dailyLog.findMany({
            where: { projectId, date: { gte: since } },
            orderBy: { date: "asc" },
            select: {
                date: true,
                workPerformed: true,
                materialsDelivered: true,
                issues: true,
                crewOnSite: true,
            },
        });

        if (dailyLogs.length === 0) {
            return NextResponse.json({
                suggestions: [],
                targetEstimateId: targetEstimate?.id ?? null,
                targetEstimateCode: targetEstimate?.code ?? null,
                logCount: 0,
                lookbackDays,
            });
        }

        const existingChangeOrders = await prisma.changeOrder.findMany({
            where: { projectId },
            select: { title: true },
        });

        const logSummary = dailyLogs.map(log => {
            const date = new Date(log.date).toISOString().split("T")[0];
            let entry = `[${date}] Work: ${log.workPerformed}`;
            if (log.materialsDelivered) entry += ` | Materials: ${log.materialsDelivered}`;
            if (log.issues) entry += ` | Issues: ${log.issues}`;
            if (log.crewOnSite) entry += ` | Crew: ${log.crewOnSite}`;
            return entry;
        }).join("\n");

        const existingTitlesBlock = existingChangeOrders.length > 0
            ? `\nEXISTING CHANGE ORDERS ON THIS PROJECT (do not suggest anything already covered by these titles):\n${existingChangeOrders.map(co => `- ${co.title}`).join("\n")}\n`
            : "";

        const ai = new GoogleGenAI({ apiKey });

        const prompt = `You are an expert construction project manager reviewing daily field logs for potential CLIENT-REQUESTED SCOPE CHANGES that should become formal change orders.

Project: ${project.name} (${project.type || "Remodel"})
Daily log entries from the last ${lookbackDays} days (${dailyLogs.length} total):

${logSummary}
${existingTitlesBlock}
Look specifically for moments where the CLIENT asked for something different from the original scope — for example "client asked to move the outlet", "owner wants different tile", "customer requested an extra window", "homeowner changed their mind about the paint color". Do NOT flag routine progress notes, weather delays, material deliveries, or internal crew decisions that were not driven by a client request.

For each qualifying scope change, return a suggestion with:
- title: a short (under 80 character) change order title
- description: 1-3 sentences summarizing what the client requested and why it's outside the original scope
- sourceLogDates: the ISO date(s) (YYYY-MM-DD) of the daily log entries that mention it
- confidence: "high" if the log explicitly attributes the request to the client, "medium" if it's implied, "low" if it's a guess

Skip anything already covered by an existing change order title listed above. If nothing qualifies, return an empty suggestions array — do not invent scope changes that aren't clearly supported by the logs.

Respond ONLY with valid JSON matching the schema provided.`;

        const response = await ai.models.generateContent({
            model: "gemini-3.0-flash-preview",
            contents: { parts: [{ text: prompt }] },
            config: {
                responseMimeType: "application/json",
                responseSchema: responseSchema as any,
                temperature: 0.2,
            }
        });

        if (!response.text) {
            throw new Error("No response from AI");
        }

        const parsed = extractJsonObject<{ suggestions: any[] }>(response.text);
        if (!parsed) {
            throw new Error("Could not parse AI response");
        }

        const suggestions = (Array.isArray(parsed.suggestions) ? parsed.suggestions : [])
            .slice(0, MAX_SUGGESTIONS)
            .map(s => ({
                title: String(s?.title ?? "").trim().slice(0, 200),
                description: String(s?.description ?? "").trim().slice(0, 2000),
                sourceLogDates: Array.isArray(s?.sourceLogDates)
                    ? s.sourceLogDates.filter((d: unknown) => typeof d === "string").slice(0, 30)
                    : [],
                confidence: CONFIDENCE_LEVELS.includes(s?.confidence) ? s.confidence : "low",
            }))
            .filter(s => s.title.length > 0);

        return NextResponse.json({
            suggestions,
            targetEstimateId: targetEstimate?.id ?? null,
            targetEstimateCode: targetEstimate?.code ?? null,
            logCount: dailyLogs.length,
            lookbackDays,
        });

    } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : "Unknown error";
        console.error("AI Change Order Detect Error:", msg);
        return NextResponse.json({ error: "Failed to detect change orders" }, { status: 500 });
    }
}
