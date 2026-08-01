import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
// Imported from the plain core modules, NOT src/lib/actions.ts — actions.ts
// is a "use server" file that transitively imports "server-only", which is
// not resolvable outside a Next.js build context (see
// e2e/selections-templates-due-dates.spec.ts's identical comment).
import { setDecisionOrderInfo } from "../src/lib/decision-order-actions-core";
import { signClientPortalToken } from "../src/lib/client-portal-auth";
import { toCompanyDayKey } from "../src/lib/company-day";

const prisma = new PrismaClient();
const run = `selection-order-tracking-${process.pid}-${Date.now()}`;
const ids = {
    client: `${run}-client`,
    project: `${run}-project`,
    admin: `${run}-admin`,
    taskRisk: `${run}-task-risk`,
    taskShift: `${run}-task-shift`,
} as const;

// ── Relative-date helpers (Codex review round 1, nit a) — every test date
// below is computed relative to "today" instead of a hardcoded absolute
// date. A hardcoded ETA like "2026-08-20" starts failing the moment real
// time passes it: the popover's order-date input defaults to TODAY, and
// once "today" advances past a stale hardcoded ETA, "expected arrival can't
// be before the order date" starts rejecting it. ───────────────────────────
// Company-local (Pacific) "today", re-anchored to UTC midnight — MUST match
// decision-order-actions-core.ts's companyTodayAsUtcMidnight exactly. A bare
// UTC calendar day would disagree with it for roughly the first half of the
// UTC day (Pacific's previous evening), which would make orderedAt/ETA
// values computed relative to "today" spuriously trip the "date can't be
// more than a day in the future" validation depending on what time this
// suite happens to run.
function utcMidnightNow(): Date {
    return new Date(`${toCompanyDayKey(new Date())}T00:00:00.000Z`);
}
function daysFromToday(n: number): Date {
    return new Date(utcMidnightNow().getTime() + n * 24 * 60 * 60 * 1000);
}
function isoDateOnly(d: Date): string {
    return d.toISOString().slice(0, 10);
}
// Mirrors decision-due-date.ts's formatDueDateShort exactly, so assertions
// don't hardcode a month/day string that a relative date would invalidate.
function shortDateLabel(d: Date): string {
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

// A stable reference point far enough in the future that every ETA offset
// used below (D-10 .. D+4) stays comfortably past "today" regardless of
// when this suite runs, while remaining well inside the +5y sanity bound.
const RISK_TASK_START = daysFromToday(60);
const SHIFT_TASK_START = daysFromToday(60);

// Direct core-module calls run in a bare Node process, not a live Next.js
// request — the real (default) revalidate would throw ("static generation
// store missing"), same as every other Phase 3 core-module e2e spec.
const NOOP_REVALIDATE = () => {};
const clientEmail = `${run}@example.com`;

function makeDecision(name: string, status: string) {
    return prisma.decision.create({
        data: { id: `${run}-${name}`, projectId: ids.project, name, status },
    });
}

test.describe.serial("Selection order tracking + delivery risk", () => {
    test.beforeAll(async () => {
        await prisma.client.create({ data: { id: ids.client, name: "Order Tracking Client", initials: "OT", email: clientEmail } });
        await prisma.project.create({
            data: { id: ids.project, name: "Order Tracking Project", clientId: ids.client, status: "In Progress" },
        });
        await prisma.portalVisibility.create({
            data: { projectId: ids.project, isPortalEnabled: true, showSelections: true },
        });
        await prisma.user.create({
            data: { id: ids.admin, email: `${run}-admin@example.com`, name: "Order Tracking Admin", role: "ADMIN", status: "ACTIVATED" },
        });
        await prisma.scheduleTask.create({
            data: { id: ids.taskRisk, projectId: ids.project, name: "Risk Reference Task", startDate: RISK_TASK_START, endDate: daysFromToday(64) },
        });
        await prisma.scheduleTask.create({
            data: { id: ids.taskShift, projectId: ids.project, name: "Shift Reference Task", startDate: SHIFT_TASK_START, endDate: daysFromToday(64) },
        });
    });

    test.afterAll(async () => {
        await prisma.selectionProposal.deleteMany({ where: { projectId: ids.project } });
        await prisma.decision.deleteMany({ where: { projectId: ids.project } });
        await prisma.scheduleTask.deleteMany({ where: { projectId: ids.project } });
        await prisma.project.deleteMany({ where: { id: ids.project } });
        await prisma.client.deleteMany({ where: { id: ids.client } });
        await prisma.user.deleteMany({ where: { id: ids.admin } });
        await prisma.$disconnect();
    });

    // ── Case 1: full ordered -> edit ETA -> received -> clear lifecycle,
    //    plus the CAS guard against ordering an Open decision ─────────────

    test("marking a Decided decision ordered sets status + fields; editing the ETA persists; marking received retains fields; clearing returns to Decided with fields null", async () => {
        const admin = await prisma.user.findUniqueOrThrow({ where: { id: ids.admin } });
        const decision = await makeDecision("case1-lifecycle", "Decided");

        const orderedAt = daysFromToday(-30);
        const firstEta = daysFromToday(-15);
        const first = await setDecisionOrderInfo(
            decision.id,
            { kind: "ordered", orderedAt, orderedBy: "TEAM", expectedArrivalAt: firstEta, expectedOrderedAt: null },
            { getActor: async () => admin, revalidate: NOOP_REVALIDATE },
        );
        expect(first.ok).toBe(true);

        let updated = await prisma.decision.findUniqueOrThrow({ where: { id: decision.id } });
        expect(updated.status).toBe("Ordered");
        expect(updated.orderedAt?.toISOString()).toBe(orderedAt.toISOString());
        expect(updated.orderedBy).toBe("TEAM");
        expect(updated.expectedArrivalAt?.toISOString()).toBe(firstEta.toISOString());

        // Edit ETA — CAS also admits Ordered -> Ordered (re-marking to
        // edit), with expectedOrderedAt now matching the row's current
        // orderedAt (field-level CAS, issue 3).
        const revisedEta = daysFromToday(-10);
        const editResult = await setDecisionOrderInfo(
            decision.id,
            { kind: "ordered", orderedAt, orderedBy: "CLIENT", expectedArrivalAt: revisedEta, expectedOrderedAt: orderedAt },
            { getActor: async () => admin, revalidate: NOOP_REVALIDATE },
        );
        expect(editResult.ok).toBe(true);
        updated = await prisma.decision.findUniqueOrThrow({ where: { id: decision.id } });
        expect(updated.status).toBe("Ordered");
        expect(updated.orderedBy).toBe("CLIENT");
        expect(updated.expectedArrivalAt?.toISOString()).toBe(revisedEta.toISOString());

        // Mark received — order fields are KEPT for history.
        const received = await setDecisionOrderInfo(decision.id, { kind: "received" }, { getActor: async () => admin, revalidate: NOOP_REVALIDATE });
        expect(received.ok).toBe(true);
        updated = await prisma.decision.findUniqueOrThrow({ where: { id: decision.id } });
        expect(updated.status).toBe("Received");
        expect(updated.orderedAt?.toISOString()).toBe(orderedAt.toISOString());
        expect(updated.expectedArrivalAt?.toISOString()).toBe(revisedEta.toISOString());

        // Clear — undo path, CAS from Ordered/Received back to Decided, all
        // three fields nulled.
        const cleared = await setDecisionOrderInfo(decision.id, { kind: "clear" }, { getActor: async () => admin, revalidate: NOOP_REVALIDATE });
        expect(cleared.ok).toBe(true);
        updated = await prisma.decision.findUniqueOrThrow({ where: { id: decision.id } });
        expect(updated.status).toBe("Decided");
        expect(updated.orderedAt).toBeNull();
        expect(updated.orderedBy).toBeNull();
        expect(updated.expectedArrivalAt).toBeNull();
    });

    test("CAS: marking an Open decision ordered is rejected (typed result, no throw)", async () => {
        const admin = await prisma.user.findUniqueOrThrow({ where: { id: ids.admin } });
        const decision = await makeDecision("case1-open-reject", "Open");

        const result = await setDecisionOrderInfo(
            decision.id,
            { kind: "ordered", orderedAt: daysFromToday(0), orderedBy: "TEAM", expectedArrivalAt: null, expectedOrderedAt: null },
            { getActor: async () => admin, revalidate: NOOP_REVALIDATE },
        );
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.code).toBe("CAS_CONFLICT");

        const unchanged = await prisma.decision.findUniqueOrThrow({ where: { id: decision.id } });
        expect(unchanged.status).toBe("Open");
        expect(unchanged.orderedAt).toBeNull();
    });

    // ── Codex review round 1, issue 3: field-level CAS on orderedAt — a
    //    stale expectedOrderedAt must be rejected, not silently overwritten ─

    test("field-level CAS: a stale expectedOrderedAt is rejected as a conflict, not silently overwritten", async () => {
        const admin = await prisma.user.findUniqueOrThrow({ where: { id: ids.admin } });
        const decision = await makeDecision("issue3-stale-cas", "Decided");
        const orderedAt = daysFromToday(0);

        const first = await setDecisionOrderInfo(
            decision.id,
            { kind: "ordered", orderedAt, orderedBy: "TEAM", expectedArrivalAt: null, expectedOrderedAt: null },
            { getActor: async () => admin, revalidate: NOOP_REVALIDATE },
        );
        expect(first.ok).toBe(true);

        // A stale caller still believes orderedAt is null (as if it opened
        // its form before the write above landed) — its CAS must fail.
        const stale = await setDecisionOrderInfo(
            decision.id,
            { kind: "ordered", orderedAt: daysFromToday(1), orderedBy: "CLIENT", expectedArrivalAt: null, expectedOrderedAt: null },
            { getActor: async () => admin, revalidate: NOOP_REVALIDATE },
        );
        expect(stale.ok).toBe(false);
        if (!stale.ok) expect(stale.code).toBe("CAS_CONFLICT");

        const unchanged = await prisma.decision.findUniqueOrThrow({ where: { id: decision.id } });
        expect(unchanged.orderedBy).toBe("TEAM"); // the stale write did NOT win
        expect(unchanged.orderedAt?.toISOString()).toBe(orderedAt.toISOString());
    });

    // ── Case 5: validation — ETA before order date; far-future date ────────

    test("an expected arrival before the order date is rejected (typed result)", async () => {
        const admin = await prisma.user.findUniqueOrThrow({ where: { id: ids.admin } });
        const decision = await makeDecision("case5-eta-before-order", "Decided");

        const orderedAt = daysFromToday(0);
        const etaBeforeOrder = daysFromToday(-5);
        const result = await setDecisionOrderInfo(
            decision.id,
            { kind: "ordered", orderedAt, orderedBy: "TEAM", expectedArrivalAt: etaBeforeOrder, expectedOrderedAt: null },
            { getActor: async () => admin, revalidate: NOOP_REVALIDATE },
        );
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.code).toBe("VALIDATION");

        const unchanged = await prisma.decision.findUniqueOrThrow({ where: { id: decision.id } });
        expect(unchanged.status).toBe("Decided");
    });

    test("a far-future expected arrival is rejected (sanity bound, typed result)", async () => {
        const admin = await prisma.user.findUniqueOrThrow({ where: { id: ids.admin } });
        const decision = await makeDecision("case5-far-future", "Decided");

        const orderedAt = daysFromToday(0);
        const farFutureEta = daysFromToday(365 * 10); // ~10 years out — always beyond the +5y bound
        const result = await setDecisionOrderInfo(
            decision.id,
            { kind: "ordered", orderedAt, orderedBy: "TEAM", expectedArrivalAt: farFutureEta, expectedOrderedAt: null },
            { getActor: async () => admin, revalidate: NOOP_REVALIDATE },
        );
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.code).toBe("VALIDATION");

        const unchanged = await prisma.decision.findUniqueOrThrow({ where: { id: decision.id } });
        expect(unchanged.status).toBe("Decided");
    });

    // ── BLOCKER regression: deleteDecision's TOCTOU fix — a decision
    //    already marked Ordered cannot be deleted, and nothing is stranded.
    //    "Concurrent-ish": the order lands (direct core call) BEFORE the
    //    delete is attempted through the live UI/server action, exercising
    //    the real CAS guard exactly as a race would hit it. ────────────────

    test("BLOCKER regression: a decision marked Ordered cannot be deleted — the CAS rejects it and the row is left untouched", async ({ page }) => {
        const admin = await prisma.user.findUniqueOrThrow({ where: { id: ids.admin } });
        const decision = await makeDecision("blocker-delete-guard", "Decided");
        const orderedAt = daysFromToday(-5);
        const ordered = await setDecisionOrderInfo(
            decision.id,
            { kind: "ordered", orderedAt, orderedBy: "TEAM", expectedArrivalAt: null, expectedOrderedAt: null },
            { getActor: async () => admin, revalidate: NOOP_REVALIDATE },
        );
        expect(ordered.ok).toBe(true);

        const before = await prisma.decision.findUniqueOrThrow({ where: { id: decision.id } });
        expect(before.status).toBe("Ordered");

        const card = page.locator(`#decision-${decision.id}`);
        await page.goto(`/projects/${ids.project}/selections`);
        await expect(card).toBeVisible();

        await card.getByRole("button", { name: "Delete decision" }).click();
        const confirmButton = page.getByRole("button", { name: "Delete", exact: true });
        await confirmButton.click();
        // Waits for the "Deleting…" -> "Delete" label transition, i.e. the
        // async server action settled (success or failure) before asserting
        // DB state. Not asserting the toast's exact text — deleteDecision
        // still THROWS on rejection (unlike setDecisionOrderInfo), and
        // Next.js redacts thrown Server Action messages in the production
        // build this regression suite runs under, so the definitive proof
        // is the row's state, not the toast string.
        await expect(confirmButton).toBeEnabled();

        const after = await prisma.decision.findUniqueOrThrow({ where: { id: decision.id } });
        expect(after.deletedAt).toBeNull();
        expect(after.status).toBe("Ordered");
        expect(after.orderedAt?.toISOString()).toBe(orderedAt.toISOString());
        expect(after.orderedBy).toBe("TEAM");
    });

    // ── UI: the "Mark ordered" popover end to end (Decided -> Ordered ->
    //    edit ETA -> Received -> clear/undo back to Decided). Codex review
    //    round 1, nit a: exercises the order-date input and the Client
    //    radio through the UI, not just the ETA field + defaults. Issue 2:
    //    asserts the Received state renders no editable date input/Save. ──

    test("UI: Mark ordered popover marks a Decided decision Ordered (order date + Client radio via the UI); editing the ETA, marking received (read-only, no Save), and clearing all work from the popover", async ({ page }) => {
        const decision = await makeDecision("ui-order-flow", "Decided");
        const card = page.locator(`#decision-${decision.id}`);

        await page.goto(`/projects/${ids.project}/selections`);
        await expect(card).toBeVisible();

        // Decided -> Ordered, filling the order-date input explicitly and
        // selecting the Client radio (not just accepting the defaults).
        await card.getByTestId(`mark-ordered-trigger-${decision.id}`).click();
        const popover = page.getByTestId(`order-popover-${decision.id}`);
        await expect(popover).toBeVisible();
        const orderDateIso = isoDateOnly(daysFromToday(0));
        const firstEtaDate = daysFromToday(20);
        await popover.getByTestId(`order-date-input-${decision.id}`).fill(orderDateIso);
        await popover.getByTestId(`order-by-client-${decision.id}`).check();
        await popover.getByTestId(`order-eta-input-${decision.id}`).fill(isoDateOnly(firstEtaDate));
        await popover.getByTestId(`order-save-${decision.id}`).click();
        await expect(popover).not.toBeVisible();
        const statusLine = card.getByTestId(`order-status-line-${decision.id}`);
        await expect(statusLine).toContainText("Ordered");
        await expect(statusLine).toContainText("by Client");
        await expect(statusLine).toContainText(shortDateLabel(firstEtaDate));

        // Edit the ETA via the edit-order trigger (Ordered state).
        const revisedEtaDate = daysFromToday(25);
        await card.getByTestId(`edit-order-trigger-${decision.id}`).click();
        await expect(popover).toBeVisible();
        await popover.getByTestId(`order-eta-input-${decision.id}`).fill(isoDateOnly(revisedEtaDate));
        await popover.getByTestId(`order-save-${decision.id}`).click();
        await expect(popover).not.toBeVisible();
        await expect(statusLine).toContainText(shortDateLabel(revisedEtaDate));

        // Mark received (still Ordered state here — the editable form and
        // Mark-received button are both legitimately present).
        await card.getByTestId(`edit-order-trigger-${decision.id}`).click();
        await expect(popover).toBeVisible();
        await popover.getByTestId(`mark-received-${decision.id}`).click();
        await expect(popover).not.toBeVisible();
        await expect(statusLine).toContainText("Received");

        // Received state's popover: still no editable input/Save, only
        // Clear/undo.
        await card.getByTestId(`edit-order-trigger-${decision.id}`).click();
        await expect(popover).toBeVisible();
        await expect(popover.getByTestId(`order-date-input-${decision.id}`)).toHaveCount(0);
        await expect(popover.getByTestId(`order-save-${decision.id}`)).toHaveCount(0);
        await expect(popover.getByTestId(`mark-received-${decision.id}`)).toHaveCount(0);
        await popover.getByTestId(`order-clear-${decision.id}`).click();
        await expect(popover).not.toBeVisible();
        await expect(card.getByTestId(`mark-ordered-trigger-${decision.id}`)).toBeVisible();
        await expect(statusLine).toHaveCount(0);

        const finalRow = await prisma.decision.findUniqueOrThrow({ where: { id: decision.id } });
        expect(finalRow.status).toBe("Decided");
        expect(finalRow.orderedAt).toBeNull();
        expect(finalRow.orderedBy).toBeNull();
        expect(finalRow.expectedArrivalAt).toBeNull();
    });

    // ── Case 2: risk badges + banner (fixture decisions linked to
    //    ids.taskRisk, startDate RISK_TASK_START = today + 60 days) ────────

    async function markOrderedLinkedToRiskTask(name: string, expectedArrivalAt: Date) {
        const admin = await prisma.user.findUniqueOrThrow({ where: { id: ids.admin } });
        const decision = await makeDecision(name, "Decided");
        const result = await setDecisionOrderInfo(
            decision.id,
            { kind: "ordered", orderedAt: daysFromToday(0), orderedBy: "TEAM", expectedArrivalAt, expectedOrderedAt: null },
            { getActor: async () => admin, revalidate: NOOP_REVALIDATE },
        );
        expect(result.ok).toBe(true);
        await prisma.decision.update({ where: { id: decision.id }, data: { scheduleTaskId: ids.taskRisk } });
        return decision;
    }

    test("risk: ETA 2 days after the linked task's start shows a red badge with 'after' wording, and the banner lists it", async ({ page }) => {
        const decision = await markOrderedLinkedToRiskTask("case2-late", daysFromToday(62)); // D+2

        await page.goto(`/projects/${ids.project}/selections`);
        const badge = page.getByTestId(`risk-badge-${decision.id}`);
        await expect(badge).toBeVisible();
        await expect(badge).toContainText("2 days after");

        const banner = page.getByTestId("order-risk-banner");
        await expect(banner).toBeVisible();
        await expect(page.getByTestId(`order-risk-banner-item-${decision.id}`)).toBeVisible();
    });

    test("risk: ETA exactly on the linked task's start day shows the zero-day wording (Codex review round 1, issue 5)", async ({ page }) => {
        const decision = await markOrderedLinkedToRiskTask("case2-zero-day", RISK_TASK_START); // D+0

        await page.goto(`/projects/${ids.project}/selections`);
        const badge = page.getByTestId(`risk-badge-${decision.id}`);
        await expect(badge).toBeVisible();
        await expect(badge).toContainText(`arrives the day ${shortDateLabel(RISK_TASK_START)} starts`);
        await expect(badge).not.toContainText("0 days after");
    });

    test("risk: ETA 2 days before the linked task's start shows an amber tight badge", async ({ page }) => {
        const decision = await markOrderedLinkedToRiskTask("case2-tight", daysFromToday(58)); // D-2

        await page.goto(`/projects/${ids.project}/selections`);
        const badge = page.getByTestId(`risk-badge-${decision.id}`);
        await expect(badge).toBeVisible();
        await expect(badge).toContainText("2 days before");
        await expect(page.getByTestId(`order-risk-banner-item-${decision.id}`)).toBeVisible();
    });

    test("risk: ETA 10 days before the linked task's start shows no badge and no banner entry", async ({ page }) => {
        const decision = await markOrderedLinkedToRiskTask("case2-clear", daysFromToday(50)); // D-10

        await page.goto(`/projects/${ids.project}/selections`);
        await expect(page.getByTestId(`risk-badge-${decision.id}`)).toHaveCount(0);
        await expect(page.getByTestId(`order-risk-banner-item-${decision.id}`)).toHaveCount(0);
    });

    test("risk: an unlinked decision falls back to its effectiveDueDate (manual override) as the reference", async ({ page }) => {
        const admin = await prisma.user.findUniqueOrThrow({ where: { id: ids.admin } });
        const decision = await makeDecision("case2-unlinked-fallback", "Decided");
        const dueDate = daysFromToday(60);
        // Manual due-date override IS the effectiveDueDate when there's no
        // schedule link — set directly (equivalent to setDecisionDueDateOverride).
        await prisma.decision.update({ where: { id: decision.id }, data: { dueDate } });
        const result = await setDecisionOrderInfo(
            decision.id,
            { kind: "ordered", orderedAt: daysFromToday(0), orderedBy: "TEAM", expectedArrivalAt: daysFromToday(63), expectedOrderedAt: null }, // dueDate + 3
            { getActor: async () => admin, revalidate: NOOP_REVALIDATE },
        );
        expect(result.ok).toBe(true);

        await page.goto(`/projects/${ids.project}/selections`);
        const badge = page.getByTestId(`risk-badge-${decision.id}`);
        await expect(badge).toBeVisible();
        await expect(badge).toContainText("3 days after");
    });

    test("risk: marking a decision Received clears its badge and removes it from the banner", async ({ page }) => {
        const decision = await markOrderedLinkedToRiskTask("case2-then-received", daysFromToday(64)); // D+4, late

        await page.goto(`/projects/${ids.project}/selections`);
        await expect(page.getByTestId(`risk-badge-${decision.id}`)).toBeVisible();

        const admin = await prisma.user.findUniqueOrThrow({ where: { id: ids.admin } });
        const received = await setDecisionOrderInfo(decision.id, { kind: "received" }, { getActor: async () => admin, revalidate: NOOP_REVALIDATE });
        expect(received.ok).toBe(true);

        await page.goto(`/projects/${ids.project}/selections`);
        await expect(page.getByTestId(`risk-badge-${decision.id}`)).toHaveCount(0);
        await expect(page.getByTestId(`order-risk-banner-item-${decision.id}`)).toHaveCount(0);
    });

    // ── Case 3: schedule shift moves risk (derivation is live, no stale
    //    storage) ────────────────────────────────────────────────────────

    test("schedule shift: pushing the linked task's startDate later turns a red badge into no-risk on reload", async ({ page }) => {
        const admin = await prisma.user.findUniqueOrThrow({ where: { id: ids.admin } });
        const decision = await makeDecision("case3-shift", "Decided");
        const result = await setDecisionOrderInfo(
            decision.id,
            { kind: "ordered", orderedAt: daysFromToday(0), orderedBy: "TEAM", expectedArrivalAt: daysFromToday(62), expectedOrderedAt: null }, // SHIFT_TASK_START + 2
            { getActor: async () => admin, revalidate: NOOP_REVALIDATE },
        );
        expect(result.ok).toBe(true);
        await prisma.decision.update({ where: { id: decision.id }, data: { scheduleTaskId: ids.taskShift } });

        await page.goto(`/projects/${ids.project}/selections`);
        await expect(page.getByTestId(`risk-badge-${decision.id}`)).toBeVisible();

        // Push the task's startDate 30 days later, directly in the DB —
        // proves the risk is derived live on read, never cached on the
        // decision row.
        await prisma.scheduleTask.update({
            where: { id: ids.taskShift },
            data: { startDate: daysFromToday(90) },
        });

        await page.goto(`/projects/${ids.project}/selections`);
        await expect(page.getByTestId(`risk-badge-${decision.id}`)).toHaveCount(0);
    });

    // ── Case 6 (regression guard): widened Approved Items filter keeps an
    //    Ordered decision listed, not just Decided ────────────────────────

    test("Approved Items keeps an Ordered decision listed (regression guard for the widened status filter)", async ({ page }) => {
        const admin = await prisma.user.findUniqueOrThrow({ where: { id: ids.admin } });
        const decision = await makeDecision("case6-approved-items", "Decided");
        const candidate = await prisma.selectionProposal.create({
            data: { id: `${run}-case6-candidate`, projectId: ids.project, decisionId: decision.id, name: "Case 6 Chosen Faucet", status: "Chosen" },
        });
        await prisma.decision.update({ where: { id: decision.id }, data: { chosenItemId: candidate.id } });
        const result = await setDecisionOrderInfo(
            decision.id,
            { kind: "ordered", orderedAt: daysFromToday(0), orderedBy: "TEAM", expectedArrivalAt: null, expectedOrderedAt: null },
            { getActor: async () => admin, revalidate: NOOP_REVALIDATE },
        );
        expect(result.ok).toBe(true);

        await page.goto(`/projects/${ids.project}/selections`);
        await expect(page.getByTestId(`approved-item-${candidate.id}`)).toBeVisible();
    });

    // ── Case 4: portal shows the derived status, never the raw fields or
    //    risk; a portal actor cannot call setDecisionOrderInfo ─────────────

    test("portal: shows 'Ordered · arriving ~<date>' then 'Received'; the payload never carries the raw order fields or risk", async ({ browser }) => {
        const admin = await prisma.user.findUniqueOrThrow({ where: { id: ids.admin } });
        const decision = await makeDecision("case4-portal", "Decided");
        const etaDate = daysFromToday(12);
        const result = await setDecisionOrderInfo(
            decision.id,
            { kind: "ordered", orderedAt: daysFromToday(0), orderedBy: "TEAM", expectedArrivalAt: etaDate, expectedOrderedAt: null },
            { getActor: async () => admin, revalidate: NOOP_REVALIDATE },
        );
        expect(result.ok).toBe(true);

        const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
        const page = await context.newPage();
        const token = await signClientPortalToken(ids.client, clientEmail);
        await page.goto(
            `/api/portal/verify?token=${encodeURIComponent(token)}&next=${encodeURIComponent(`/portal/projects/${ids.project}/selections`)}`,
        );

        // "case4-portal" also appears as an <option> in the client's "Move
        // to" decision picker on other cards, so a bare getByText would hit
        // Playwright's strict-mode ambiguity — scope to the heading role.
        await expect(page.getByRole("heading", { name: "case4-portal" })).toBeVisible();
        // Scoped to THIS decision's card via its exact heading (a plain
        // hasText match also hits the "case4-portal" <option> inside other
        // cards' "Move to" pickers) — other decisions on this shared
        // project fixture also render order-status lines, so an unscoped
        // locator would be order-dependent and flaky.
        const card = page.locator(".hui-card").filter({ has: page.getByRole("heading", { name: "case4-portal", exact: true }) });
        const orderStatus = card.getByTestId("portal-order-status");
        await expect(orderStatus).toBeVisible();
        await expect(orderStatus).toContainText("Ordered");
        await expect(orderStatus).toContainText(shortDateLabel(etaDate));

        const portalMarkup = await page.content();
        expect(portalMarkup).not.toContain('"orderedAt"');
        expect(portalMarkup).not.toContain('"orderedBy"');
        expect(portalMarkup).not.toContain('"expectedArrivalAt"');
        expect(portalMarkup).not.toContain('"risk"');
        expect(portalMarkup).toContain("orderStatusForPortal");

        // Mark received server-side, reload — the portal line updates too.
        const received = await setDecisionOrderInfo(decision.id, { kind: "received" }, { getActor: async () => admin, revalidate: NOOP_REVALIDATE });
        expect(received.ok).toBe(true);
        await page.reload();
        await expect(card.getByTestId("portal-order-status")).toContainText("Received");

        await context.close();
    });

    test("a portal client cannot call setDecisionOrderInfo (direct authorization test, zero writes — still throws, auth is exempt from the typed-result contract)", async () => {
        const decision = await makeDecision("case4-denied", "Decided");

        await expect(
            setDecisionOrderInfo(
                decision.id,
                { kind: "ordered", orderedAt: daysFromToday(0), orderedBy: "TEAM", expectedArrivalAt: null, expectedOrderedAt: null },
                { getActor: async () => null, revalidate: NOOP_REVALIDATE },
            ),
        ).rejects.toThrow("Forbidden");

        const unchanged = await prisma.decision.findUniqueOrThrow({ where: { id: decision.id } });
        expect(unchanged.status).toBe("Decided");
        expect(unchanged.orderedAt).toBeNull();
    });
});
