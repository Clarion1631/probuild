// Canonical project lifecycle statuses, in pipeline order.
// Pre-sale work lives on the Lead — a project is only created once the job is
// won. New projects are born "Waiting to Start" (pre-work pipeline stage; a
// startDate on the project makes it "Scheduled" on the company dashboard),
// then move forward only:
//   0. Waiting to Start → 1. In Progress → 2. Substantial Completion → 3. Closed Complete / 4. Closed Lost
export interface ProjectStatusDef {
    value: string;
    label: string;
    color: string; // badge classes, "bg-x-100 text-x-700" pattern
    dot: string;
    rawColor: string;
    isActive: boolean;
}

export const PROJECT_STATUSES: ProjectStatusDef[] = [
    { value: "Waiting to Start", label: "Waiting to Start", color: "bg-blue-100 text-blue-700", dot: "bg-blue-500", rawColor: "#3b82f6", isActive: true },
    { value: "In Progress", label: "In Progress", color: "bg-green-100 text-green-700", dot: "bg-green-500", rawColor: "#22c55e", isActive: true },
    { value: "Substantial Completion", label: "Substantial Completion", color: "bg-amber-100 text-amber-700", dot: "bg-amber-500", rawColor: "#f59e0b", isActive: true },
    { value: "Closed Complete", label: "Closed Complete", color: "bg-slate-100 text-slate-700", dot: "bg-slate-500", rawColor: "#64748b", isActive: true },
    { value: "Closed Lost", label: "Closed Lost", color: "bg-rose-100 text-rose-700", dot: "bg-rose-500", rawColor: "#f43f5e", isActive: true },
];

export const PROJECT_STATUS_VALUES = PROJECT_STATUSES.map(s => s.value);

// The one status that means "crew are on this job right now". Named so the
// rules that key off it (mobile project list, safety-meeting phase) reference
// a constant instead of retyping the string. See src/lib/project-phases.ts.
export const PROJECT_STATUS_IN_PROGRESS = "In Progress";

// Jobs still being worked — the default view on /projects and the scope for
// "active project" queries (variance, SMS routing, AI summaries).
export const OPEN_PROJECT_STATUSES = ["Waiting to Start", "In Progress", "Substantial Completion"];

// Legacy values that may still arrive from older clients (e.g. the mobile app's
// status picker). Map them onto the canonical set instead of rejecting them.
export const LEGACY_PROJECT_STATUS_MAP: Record<string, string> = {
    "Open": "In Progress",
    "Active": "In Progress",
    "Paid Ready to Start": "Waiting to Start",
    "Paid, Ready to Start": "Waiting to Start",
    "Done": "Closed Complete",
    "Closed": "Closed Complete",
    "Completed": "Closed Complete",
};

export function canonicalProjectStatus(status: string): string | null {
    if (PROJECT_STATUS_VALUES.includes(status)) return status;
    return LEGACY_PROJECT_STATUS_MAP[status] ?? null;
}

// Lifecycle position for sorting; unknown/legacy values sort last.
export function projectStatusRank(status: string | null | undefined): number {
    const i = PROJECT_STATUS_VALUES.indexOf(status || "");
    return i === -1 ? PROJECT_STATUS_VALUES.length : i;
}

// Which jobs the mobile crew app may see at all (src/app/api/mobile/me/route.ts
// assignedProjects — the crew's project dropdown).
//
// Owner rule (2026-08): the crew picker shows ONLY jobs that are actually being
// worked, i.e. status === "In Progress". The previous filter was
// `status: { not: "Closed" }`, which was both wrong-valued (no canonical status
// is literally "Closed" — they are "Closed Complete"/"Closed Lost", so it
// excluded nothing) and far too broad.
//
// Logistics jobs (shop, travel, admin time) are the deliberate exception: they
// carry no estimate and are frequently parked at a non-In-Progress status, but
// crew must still be able to book shop/travel time. They keep the old,
// permissive predicate rather than being silently dropped.
// Built as a function, not a frozen `as const` object: Prisma's generated
// `ProjectWhereInput` takes a MUTABLE `OR` array, and a readonly tuple is not
// assignable to it. Returning a fresh object per call also keeps two call sites
// from sharing (and accidentally mutating) one literal.
export function mobileVisibleProjectWhere() {
    return {
        OR: [
            { status: PROJECT_STATUS_IN_PROGRESS },
            { isLogistics: true, status: { not: "Closed" } },
        ],
    };
}
