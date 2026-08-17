/**
 * Project hard-delete is deliberately shell-only. The Project row lock is the
 * serialization boundary for every direct FK child; the fresh evidence query
 * must run after that lock and before the cascade.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, beforeEach, test } from "node:test";
import Module from "node:module";

const state = {
    shellEvidence: false,
    projectDeleted: false,
};
const transactionOps: string[] = [];

function resetFixture() {
    state.shellEvidence = false;
    state.projectDeleted = false;
    transactionOps.length = 0;
}

const tx = {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = strings.join("?");
        if (!/FROM "Project"/i.test(sql)) throw new Error(`Unexpected row lock: ${sql}`);
        transactionOps.push(`project.lock:${String(values[0])}`);
        return [{ id: values[0] }];
    },
    project: {
        findFirst: async () => {
            transactionOps.push("project.evidence-read");
            return state.shellEvidence ? { id: "project-race" } : null;
        },
        deleteMany: async () => {
            transactionOps.push("project.deleteMany");
            state.projectDeleted = true;
            return { count: 1 };
        },
    },
};

const fakePrisma = {
    $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
    changeOrderAutomationJob: { count: async () => 0 },
};

class FakeParentDeleteBlockedError extends Error {}

let deleteProjects: (projectIds: string[]) => Promise<
    { success: true; deleted: number } | { success: false; error: string }
>;

before(async () => {
    const originalRequire = Module.prototype.require;
    (Module.prototype as unknown as { require: (id: string) => unknown }).require = function (
        this: NodeModule,
        id: string,
    ) {
        if (id === "./prisma") return { prisma: fakePrisma };
        if (id === "next/cache") {
            // eslint-disable-next-line prefer-rest-params
            const actual = originalRequire.apply(this, arguments as unknown as [string]) as Record<string, unknown>;
            return { ...actual, revalidatePath: () => undefined, revalidateTag: () => undefined };
        }
        if (id === "./permissions") {
            // eslint-disable-next-line prefer-rest-params
            const actual = originalRequire.apply(this, arguments as unknown as [string]) as Record<string, unknown>;
            return {
                ...actual,
                currentStaffUserOrNull: async () => ({ id: "admin-1", role: "ADMIN" }),
            };
        }
        if (id === "./change-order-automation-jobs") {
            return {
                ChangeOrderParentDeleteBlockedError: FakeParentDeleteBlockedError,
                prepareChangeOrderReviewJobsForMutation: async () => 0,
                prepareChangeOrdersForParentDelete: async () => ({ changeOrders: 0, removedJobs: 0 }),
            };
        }
        // eslint-disable-next-line prefer-rest-params
        return originalRequire.apply(this, arguments as unknown as [string]);
    } as typeof Module.prototype.require;

    try {
        const loaded = await import("../src/lib/actions");
        const exports = (loaded as any).deleteProjects ? loaded : (loaded as any).default;
        deleteProjects = exports.deleteProjects;
    } finally {
        Module.prototype.require = originalRequire;
    }

    assert.equal(typeof deleteProjects, "function");
});

beforeEach(resetFixture);

test("deleteProjects refuses a project shell that already owns business or audit evidence", async () => {
    state.shellEvidence = true;

    const result = await deleteProjects(["project-race"]);

    assert.deepEqual(result, {
        success: false,
        error: "Project financial or legal history must be archived, not hard-deleted",
    });
    assert.equal(state.projectDeleted, false);
    assert.deepEqual(transactionOps, [
        "project.lock:project-race",
        "project.evidence-read",
    ]);
});

test("deleteProjects deletes only an evidence-free shell after its locked re-read", async () => {
    const result = await deleteProjects(["project-race"]);

    assert.deepEqual(result, { success: true, deleted: 1 });
    assert.equal(state.projectDeleted, true);
    assert.deepEqual(transactionOps, [
        "project.lock:project-race",
        "project.evidence-read",
        "project.deleteMany",
    ]);
});

test("the shell-only query covers every business, customer, provider, file, and audit relation", () => {
    const source = readFileSync(new URL("../src/lib/actions.ts", import.meta.url), "utf8");
    const start = source.indexOf("export async function deleteProjects(");
    const end = source.indexOf("export async function updateCompanyProjectStatuses", start);
    const action = source.slice(start, end);

    for (const field of [
        "qbProjectId", "qbSyncedAt", "googleChatSpaceId", "chatWebhookUrl",
        "clientNextSteps", "clientNextStepsAt",
    ]) {
        assert.match(action, new RegExp(`\\b${field}:\\s*\\{\\s*not:\\s*null\\s*\\}`), `${field} must block hard-delete`);
    }
    for (const relation of [
        "estimates", "invoices", "budgets", "timeEntries", "roomDesigns", "contracts",
        "scheduleTasks", "files", "folders", "subcontractorAccess", "takeoffs",
        "messageThreads", "clientMessages", "changeOrders", "purchaseOrders",
        "selectionBoards", "dailyLogs", "moodBoards", "retainers", "bidPackages",
        "teamMessages", "activityLogs", "productFavorites", "selectionProposals",
        "decisions", "permits",
    ]) {
        assert.match(action, new RegExp(`\\b${relation}:\\s*\\{\\s*some:\\s*\\{\\}\\s*\\}`), `${relation} must block hard-delete`);
    }
});
