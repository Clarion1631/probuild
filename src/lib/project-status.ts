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
