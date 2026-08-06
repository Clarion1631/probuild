import { GoogleGenAI, type Part } from "@google/genai";
import { prisma } from "@/lib/prisma";
import { loadSuggestableTasks, keywordMatchTasks } from "@/lib/time-suggestion";

// Stage A of the daily-log accuracy pipeline: when a daily log is written (or
// its photos change), match the log's TEXT AND PHOTOS against the project's
// open schedule tasks and pin the pick on the log
// (DailyLog.aiSuggestedTaskId/aiSuggestionReason). Clock-in (Stage B,
// time-suggestion.ts) reads that stored pick — no AI runs at clock-in.
//
// Lifecycle contract:
//   - a SUCCESSFUL run that finds no match CLEARS any stored suggestion
//     (the log changed; the old pick no longer has evidence behind it)
//   - a TRANSIENT failure (AI/transport error) PRESERVES what's stored
//   - nothing here ever throws into a log write — this is best-effort
//     enrichment beside the write, never a gate on it.

const MAX_PHOTOS = 4;
const PHOTO_FETCH_TIMEOUT_MS = 5_000;
const MAX_PHOTO_BYTES = 4 * 1024 * 1024;

/** Set DAILY_LOG_MATCH_AI_MOCK=1 to force the deterministic keyword path (CI). */
function aiMocked(): boolean {
    return process.env.DAILY_LOG_MATCH_AI_MOCK === "1";
}

const matchResponseSchema = {
    type: "OBJECT",
    properties: {
        taskId: {
            type: "STRING",
            description: "The id of the single task this log's work/next-steps most clearly points to. Empty string if no task is a clear match.",
        },
        reason: {
            type: "STRING",
            description: "One short sentence of evidence, citing what in the text or photos supports the pick. Empty string if no match.",
        },
    },
    required: ["taskId", "reason"],
};

async function fetchPhotoInline(url: string): Promise<Part | null> {
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), PHOTO_FETCH_TIMEOUT_MS);
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timer);
        if (!res.ok) return null;
        const contentType = res.headers.get("content-type") ?? "image/jpeg";
        if (!contentType.startsWith("image/")) return null;
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.byteLength === 0 || buf.byteLength > MAX_PHOTO_BYTES) return null;
        return { inlineData: { mimeType: contentType, data: buf.toString("base64") } };
    } catch {
        return null;
    }
}

/**
 * Recompute the AI task match for a daily log. Call after any log mutation
 * (create, edit, photo add/remove). Never throws.
 */
export async function runDailyLogTaskMatch(dailyLogId: string): Promise<void> {
    try {
        const log = await prisma.dailyLog.findUnique({
            where: { id: dailyLogId },
            select: {
                id: true,
                projectId: true,
                createdById: true,
                workPerformed: true,
                nextSteps: true,
                issues: true,
                aiSuggestedTaskId: true,
                photos: { select: { url: true, caption: true } },
            },
        });
        if (!log) return;

        const candidates = await loadSuggestableTasks(log.projectId, log.createdById);
        if (candidates.length === 0) {
            await storeMatch(log.id, null, null);
            return;
        }

        const keywordFallback = () => {
            const match = keywordMatchTasks(
                {
                    nextSteps: log.nextSteps,
                    workPerformed: log.workPerformed,
                    photoCaptions: log.photos.map(photo => photo.caption ?? "").filter(Boolean),
                },
                candidates.map(task => ({
                    taskId: task.taskId,
                    taskName: task.taskName,
                    costCodeCode: task.costCodeCode,
                    costCodeName: task.costCodeName,
                })),
            );
            return match
                ? { taskId: match.taskId, reason: "Keyword match against the log text" }
                : null;
        };

        const apiKey = process.env.GEMINI_API_KEY;
        if (aiMocked() || !apiKey) {
            const picked = keywordFallback();
            await storeMatch(log.id, picked?.taskId ?? null, picked?.reason ?? null);
            return;
        }

        // doneWhen gives the model the task's completion criteria — good
        // disambiguation material ("drywall hung" vs "drywall taped").
        const doneWhens = await prisma.scheduleTask.findMany({
            where: { id: { in: candidates.map(task => task.taskId) } },
            select: { id: true, doneWhen: true },
        });
        const doneWhenById = new Map(doneWhens.map(task => [task.id, task.doneWhen]));

        const taskLines = candidates.map(task => {
            const doneWhen = doneWhenById.get(task.taskId);
            return `- id: ${task.taskId} | ${task.costCodeLabel} | ${task.taskName}${doneWhen ? ` | done when: ${doneWhen}` : ""}`;
        }).join("\n");

        const prompt = `You are matching a construction daily log to the schedule task the crew should charge time to.

Open tasks on this project:
${taskLines}

Daily log:
Work performed: ${log.workPerformed || "(none)"}
Next steps: ${log.nextSteps || "(none)"}
Issues: ${log.issues || "(none)"}
${log.photos.length > 0 ? `\n${Math.min(log.photos.length, MAX_PHOTOS)} site photo(s) attached. Use what the photos show (materials, trade, room, stage of work) as evidence.` : ""}

Pick the ONE task that "next steps" (preferred) or the most recent work points to. If the log doesn't clearly point at one task, return an empty taskId — a wrong pick misfiles labor hours, so only answer when confident.

Respond ONLY with valid JSON matching the schema.`;

        const parts: Part[] = [{ text: prompt }];
        for (const photo of log.photos.slice(0, MAX_PHOTOS)) {
            const inline = await fetchPhotoInline(photo.url);
            if (inline) parts.push(inline);
        }

        const ai = new GoogleGenAI({ apiKey });
        const response = await ai.models.generateContent({
            model: "gemini-3.0-flash-preview",
            contents: { parts },
            config: {
                responseMimeType: "application/json",
                responseSchema: matchResponseSchema as any,
                temperature: 0.1,
            },
        });
        if (!response.text) throw new Error("empty AI response");
        const parsed = JSON.parse(response.text) as { taskId?: string; reason?: string };

        const pickedId = typeof parsed.taskId === "string" ? parsed.taskId.trim() : "";
        if (!pickedId) {
            // The model ran and declined — that's a successful no-match: clear.
            await storeMatch(log.id, null, null);
            return;
        }
        const valid = candidates.find(task => task.taskId === pickedId);
        if (!valid) {
            // Hallucinated id — treat as no confident match rather than storing garbage.
            await storeMatch(log.id, null, null);
            return;
        }
        const reason = typeof parsed.reason === "string" && parsed.reason.trim()
            ? parsed.reason.trim().slice(0, 500)
            : null;
        await storeMatch(log.id, valid.taskId, reason);
    } catch (error) {
        // Transient failure: preserve whatever is stored.
        console.error("[daily-log-task-match] failed", { dailyLogId, error });
    }
}

async function storeMatch(dailyLogId: string, taskId: string | null, reason: string | null): Promise<void> {
    await prisma.dailyLog.update({
        where: { id: dailyLogId },
        data: { aiSuggestedTaskId: taskId, aiSuggestionReason: taskId ? reason : null },
    });
}
