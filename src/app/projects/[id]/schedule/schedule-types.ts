export type EstimateSummary = { id: string; title: string; status: string };
export type EstimateItemSummary = { id: string; name: string; type: string; total: number; estimateId: string; parentId?: string | null; parent?: { name: string } | null; quantity?: number; budgetUnit?: string | null; linkedTaskId?: string | null; linkedTaskName?: string | null };
export type Dependency = { id: string; predecessorId: string; dependentId: string };
export type TeamMember = { id: string; name: string | null; email: string };
export type PunchItem = { id: string; name: string; completed: boolean; order: number };
export type CommentPhoto = { id: string; url: string };
export type Comment = { id: string; text: string; createdAt: string; subcontractorName?: string | null; user: { id: string; name: string | null; email: string } | null; photos?: CommentPhoto[] };
export type Assignment = { id: string; userId: string; role: "assigned" | "lead" | string; user: TeamMember };
export type Subcontractor = { id: string; companyName: string; email: string; trade: string | null };
export type SubAssignment = { id: string; subcontractorId: string; subcontractor: Subcontractor };

export type Task = {
    id: string;
    projectId?: string | null;
    name: string;
    startDate: string;
    endDate: string;
    color: string;
    progress: number;
    status: string;
    type: "task" | "milestone" | "appointment";
    assignee: string | null;
    parentId?: string | null;
    order: number;
    estimatedHours: number | null;
    doneWhen: string | null;
    blockedReason: string | null;
    scheduledTime: string | null;
    confirmationStatus: "planned" | "requested" | "confirmed" | null;
    actualHours: number;
    dependencies: Dependency[];
    dependents: Dependency[];
    assignments?: Assignment[];
    subAssignments?: SubAssignment[];
    estimateItemId?: string | null;
    estimateItem?: EstimateItemSummary | null;
    baselineStartDate?: string | null;
    baselineEndDate?: string | null;
};

export type TimeEntryDetail = {
    id: string;
    startTime: string;
    durationHours: number | null;
    user: { id: string; name: string | null; email: string };
    costCode: { id: string; code: string; name: string } | null;
};

export type ZoomLevel = "day" | "week" | "month";

export type SortKey = "manual" | "name" | "type" | "startDate" | "endDate" | "duration" | "status" | "progress" | "estimatedHours" | "actualHours";
export type SortDir = "asc" | "desc";

export type FilterState = {
    q: string;
    statuses: string[];
    type: "all" | "task" | "milestone" | "appointment";
    assignee: string | null;
    startFrom: string | null;
    startTo: string | null;
};

export type ScheduleViewProps = {
    projectId: string;
    projectName: string;
    initialTasks: Task[];
    estimates?: EstimateSummary[];
    teamMembers?: TeamMember[];
    subcontractors?: Subcontractor[];
    initialPublished: boolean;
};
