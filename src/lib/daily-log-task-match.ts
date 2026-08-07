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
const AI_CALL_TIMEOUT_MS = 25_000; // after() shares the route's maxDuration budget — never let the AI call eat it all

// Verified against ListModels with the production key (2026-08-06); the
// previously used "gemini-3.0-flash-preview" does not exist and every call
// with it 404s.
const GEMINI_MODEL = "gemini-3.5-flash";

/**
 * Photos are fetched server-side for Gemini vision, so only URLs on our own
 * Supabase storage are eligible — anything else is an SSRF vector. (Both photo
 * write paths store Supabase URLs; foreign URLs simply aren't fetched.)
 */
function isOwnStorageUrl(value: string): boolean {
    const base = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
    if (!base) return false;
    try {
        const url = new URL(value);
        return url.protocol === "https:" && url.hostname === new URL(base).hostname;
    } catch {
        return false;
    }
}

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
    if (!isOwnStorageUrl(url)) return null;
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), PHOTO_FETCH_TIMEOUT_MS);
        const res = await fetch(url, { signal: controller.signal, redirect: "error" });
        if (!res.ok || !res.body) {
            clearTimeout(timer);
            return null;
        }
        const contentType = res.headers.get("content-type") ?? "image/jpeg";
        const declaredLength = Number(res.headers.get("content-length") ?? 0);
        if (!contentType.startsWith("image/") || declaredLength > MAX_PHOTO_BYTES) {
            clearTimeout(timer);
            controller.abort();
            return null;
        }
        // Stream with a hard byte cap — content-length is advisory.
        const reader = res.body.getReader();
        const chunks: Uint8Array[] = [];
        let received = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            received += value.byteLength;
            if (received > MAX_PHOTO_BYTES) {
                controller.abort();
                clearTimeout(timer);
                return null;
            }
            chunks.push(value);
        }
        clearTimeout(timer);
        if (received === 0) return null;
        return { inlineData: { mimeType: contentType, data: Buffer.concat(chunks).toString("base64") } };
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
                updatedAt: true,
                workPerformed: true,
                nextSteps: true,
                issues: true,
                aiSuggestedTaskId: true,
                photos: { select: { id: true, url: true, caption: true } },
            },
        });
        if (!log) return;
        // Stale-store guard: two matcher runs can race (edit + photo add each
        // schedule one); only the run that saw the CURRENT log row may store.
        // Photo mutations bump the log row's updatedAt (see addDailyLogPhotos /
        // deleteDailyLogPhoto), so updatedAt alone versions the content and the
        // store can be a single atomic conditional write.
        const contentStamp = log.updatedAt;

        const candidates = await loadSuggestableTasks(log.projectId, log.createdById);
        if (candidates.length === 0) {
            await storeMatch(log.id, null, null, contentStamp);
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
            await storeMatch(log.id, picked?.taskId ?? null, picked?.reason ?? null, contentStamp);
            return;
        }

        // doneWhen gives the model the task's completion criteria — good
        // disambiguation material ("drywall hung" vs "drywall taped").
        const doneWhens = await prisma.scheduleTask.findMany({
            where: { id: { in: candidates.map(task => task.taskId) } },
            select: { id: true, doneWhen: true },
        });
        const doneWhenById = new Map(doneWhens.map(task => [task.id, task.doneWhen]));

        // Candidates in schedule order, so "phase X is complete → the phase
        // after it is next" is inferable. Recently completed tasks are shown as
        // CONTEXT ONLY — a log declaring a phase done points at whatever
        // follows it, and without seeing completed phases the model can't make
        // that jump.
        const ordered = [...candidates].sort((a, b) => a.startDate.getTime() - b.startDate.getTime());
        const taskLines = ordered.map(task => {
            const doneWhen = doneWhenById.get(task.taskId);
            return `- id: ${task.taskId} | starts ${task.startDate.toISOString().slice(0, 10)} | ${task.costCodeLabel} | ${task.taskName}${doneWhen ? ` | done when: ${doneWhen}` : ""}`;
        }).join("\n");

        const recentlyCompleted = await prisma.scheduleTask.findMany({
            where: { projectId: log.projectId, type: "task", status: "Complete" },
            orderBy: { endDate: "desc" },
            take: 8,
            select: { name: true, endDate: true },
        });
        const completedLines = recentlyCompleted.length > 0
            ? recentlyCompleted
                .map(task => `- ${task.name} (ended ${task.endDate.toISOString().slice(0, 10)})`)
                .join("\n")
            : "(none)";

        const prompt = `You are matching a construction daily log to the schedule task the crew should charge time to.

Open tasks on this project, in schedule order (pick ONLY from these ids):
${taskLines}

Already-completed tasks (context only — never pick these):
${completedLines}

Daily log:
Work performed: ${log.workPerformed || "(none)"}
Next steps: ${log.nextSteps || "(none)"}
Issues: ${log.issues || "(none)"}
${log.photos.length > 0 ? `\n${Math.min(log.photos.length, MAX_PHOTOS)} site photo(s) attached. Use what the photos show (materials, trade, room, stage of work) as evidence.` : ""}

Pick the ONE open task the crew should charge time to next, in this priority order:
1. An explicit "next steps" statement always wins.
2. If the log declares a phase COMPLETE (text or photos) and names no next step, the crew is almost certainly moving to the phase that FOLLOWS it — pick the earliest open task after the completed work in schedule order.
3. Otherwise, the task matching the most recent work described.
If none of these clearly points at one open task, return an empty taskId — a wrong pick misfiles labor hours, so only answer when confident.

Respond ONLY with valid JSON matching the schema.`;

        const parts: Part[] = [{ text: prompt }];
        // Parallel fetch keeps worst-case photo time at ONE per-fetch timeout,
        // not four — this whole pipeline runs inside after()'s shared duration
        // budget.
        const inlines = await Promise.all(
            log.photos.slice(0, MAX_PHOTOS).map(photo => fetchPhotoInline(photo.url)),
        );
        for (const inline of inlines) {
            if (inline) parts.push(inline);
        }

        const ai = new GoogleGenAI({ apiKey });
        // Bounds the await, not the SDK's underlying request (it has no abort
        // hook) — the orphaned promise resolves into nothing.
        let aiTimer: ReturnType<typeof setTimeout> | undefined;
        let response;
        try {
            response = await Promise.race([
                ai.models.generateContent({
                    model: GEMINI_MODEL,
                    contents: { parts },
                    config: {
                        responseMimeType: "application/json",
                        responseSchema: matchResponseSchema as any,
                        temperature: 0.1,
                    },
                }),
                new Promise<never>((_, reject) => {
                    aiTimer = setTimeout(() => reject(new Error("AI call timed out")), AI_CALL_TIMEOUT_MS);
                }),
            ]);
        } finally {
            clearTimeout(aiTimer);
        }
        if (!response.text) throw new Error("empty AI response");
        const parsed = JSON.parse(response.text) as { taskId?: string; reason?: string };

        const pickedId = typeof parsed.taskId === "string" ? parsed.taskId.trim() : "";
        if (!pickedId) {
            // The model ran and declined — that's a successful no-match: clear.
            await storeMatch(log.id, null, null, contentStamp);
            return;
        }
        const valid = candidates.find(task => task.taskId === pickedId);
        if (!valid) {
            // Hallucinated id — treat as no confident match rather than storing garbage.
            await storeMatch(log.id, null, null, contentStamp);
            return;
        }
        const reason = typeof parsed.reason === "string" && parsed.reason.trim()
            ? parsed.reason.trim().slice(0, 500)
            : null;
        await storeMatch(log.id, valid.taskId, reason, contentStamp);
    } catch (error) {
        // Transient failure: preserve whatever is stored.
        console.error("[daily-log-task-match] failed", { dailyLogId, error });
    }
}

async function storeMatch(
    dailyLogId: string,
    taskId: string | null,
    reason: string | null,
    contentStamp: Date,
): Promise<void> {
    // Atomic compare-and-write: the row must still carry the updatedAt this run
    // read, or the write is silently skipped — the mutation that changed the
    // log scheduled a fresh run that owns the store. (updateMany allows non-id
    // filters; count 0 simply means we lost the race.)
    await prisma.dailyLog.updateMany({
        where: { id: dailyLogId, updatedAt: contentStamp },
        data: { aiSuggestedTaskId: taskId, aiSuggestionReason: taskId ? reason : null },
    });
}
