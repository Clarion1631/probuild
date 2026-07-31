// Deterministic mock `complete` dependency for decision-schedule-link-core.ts,
// used ONLY in tests (SELECTION_AI_MOCK=1) — see the production guard in
// decision-schedule-link-dependencies.ts. Never calls a real AI. Parses the
// exact <decisions>/<tasks> JSON blocks the core's buildPrompt() emits and
// matches a decision to a task by case-insensitive substring on
// name/scheduleHint against the task name; otherwise null. Mirrors
// selection-ai-sort-mock.ts's structure exactly.
const DECISIONS_BLOCK = /<decisions>\s*([\s\S]*)\s*<\/decisions>/;
const TASKS_BLOCK = /<tasks>\s*([\s\S]*)\s*<\/tasks>/;

type MockDecision = { id: string; name: string; scheduleHint: string | null };
type MockTask = { id: string; name: string };

const DEFAULT_LEAD_TIME_DAYS = 7;

export async function mockDecisionScheduleLinkComplete(prompt: string): Promise<string> {
    const decisionsMatch = prompt.match(DECISIONS_BLOCK);
    const tasksMatch = prompt.match(TASKS_BLOCK);
    const decisions: MockDecision[] = decisionsMatch ? JSON.parse(decisionsMatch[1]) : [];
    const tasks: MockTask[] = tasksMatch ? JSON.parse(tasksMatch[1]) : [];

    const suggestions = decisions.map(({ id, name, scheduleHint }) => {
        const needle = (scheduleHint || name).toLowerCase();
        const match = tasks.find(
            (t) => needle.includes(t.name.toLowerCase()) || t.name.toLowerCase().includes(needle),
        );
        return {
            decisionId: id,
            scheduleTaskId: match?.id ?? null,
            leadTimeDays: match ? DEFAULT_LEAD_TIME_DAYS : 0,
            confidence: match ? "high" : "low",
            reason: match ? `Name/hint keyword matches task "${match.name}"` : "No clear keyword match",
        };
    });

    return JSON.stringify({ suggestions });
}
