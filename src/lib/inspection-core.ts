export const INSPECTION_RESULTS = ["SCHEDULED", "PASSED", "FAILED", "PARTIAL"] as const;
export type InspectionResult = (typeof INSPECTION_RESULTS)[number];

type InspectionLinkDb = {
    // eslint-disable-next-line no-unused-vars
    permit: { findFirst: (_args: { where: { id: string; projectId: string }; select: { id: true } }) => Promise<{ id: string } | null> };
    // eslint-disable-next-line no-unused-vars
    scheduleTask: { findFirst: (_args: { where: { id: string; projectId: string }; select: { id: true } }) => Promise<{ id: string } | null> };
};

export function inspectionResult(value: string | undefined, fallback: InspectionResult = "SCHEDULED"): InspectionResult {
    if (value === undefined) return fallback;
    if (!(INSPECTION_RESULTS as readonly string[]).includes(value)) throw new Error("Invalid inspection result");
    return value as InspectionResult;
}

export function parseInspectionDate(value: string | undefined, label: string): Date | null | undefined {
    if (value === undefined) return undefined;
    if (!value) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${label} must use YYYY-MM-DD`);
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new Error(`${label} is invalid`);
    return parsed;
}

export function requireInspectionDate(result: InspectionResult, scheduledDate: Date | null, performedDate: Date | null) {
    if (result === "SCHEDULED" && !scheduledDate) throw new Error("Scheduled inspections require a scheduled date");
    if (result !== "SCHEDULED" && !performedDate) throw new Error(`${result} inspections require a performed date`);
}

export function defaultInspectionShare(result: InspectionResult, sharedToPortal: boolean | undefined) {
    return sharedToPortal ?? result === "PASSED";
}

export type InspectionTimelineEntry = {
    id: string;
    type: string;
    result: string;
    permitId: string | null;
    createdAt: Date;
    scheduledDate: Date | null;
    performedDate: Date | null;
};

export function inspectionTimelineDate(inspection: InspectionTimelineEntry): Date {
    return inspection.performedDate ?? inspection.scheduledDate ?? inspection.createdAt;
}

/** A portal re-inspection message needs a real later scheduled inspection. */
export function hasScheduledReinspection(
    inspection: InspectionTimelineEntry,
    inspections: readonly InspectionTimelineEntry[],
): boolean {
    if (!inspection.permitId) return false;

    return inspections.some(candidate =>
        candidate.id !== inspection.id &&
        candidate.result === "SCHEDULED" &&
        candidate.type === inspection.type &&
        candidate.permitId === inspection.permitId &&
        candidate.createdAt > inspection.createdAt,
    );
}

export function sortInspectionTimeline<T extends InspectionTimelineEntry>(inspections: readonly T[]): T[] {
    return [...inspections].sort((a, b) => {
        const dateDifference = inspectionTimelineDate(b).getTime() - inspectionTimelineDate(a).getTime();
        return dateDifference || b.createdAt.getTime() - a.createdAt.getTime();
    });
}

export async function assertInspectionLinksBelongToProject(
    db: InspectionLinkDb,
    projectId: string,
    permitId: string | null,
    scheduleTaskId: string | null,
): Promise<void> {
    if (permitId) {
        const permit = await db.permit.findFirst({ where: { id: permitId, projectId }, select: { id: true } });
        if (!permit) throw new Error("permitId does not belong to this project");
    }
    if (scheduleTaskId) {
        const task = await db.scheduleTask.findFirst({ where: { id: scheduleTaskId, projectId }, select: { id: true } });
        if (!task) throw new Error("scheduleTaskId does not belong to this project");
    }
}
