export type EstimateSummary = { id: string; title: string; status: string };
export type EstimateItemSummary = { id: string; name: string; type: string; total: number; estimateId: string; parentId?: string | null; parent?: { name: string } | null };
export type Dependency = { id: string; predecessorId: string; dependentId: string };
export type TeamMember = { id: string; name: string | null; email: string };
export type PunchItem = { id: string; name: string; completed: boolean; order: number };
export type Comment = { id: string; text: string; createdAt: string; user: { id: string; name: string | null; email: string } };
export type Assignment = { id: string; userId: string; user: TeamMember };
export type Subcontractor = { id: string; companyName: string; email: string; trade: string | null };
export type SubAssignment = { id: string; subcontractorId: string; subcontractor: Subcontractor };

export type Task = {
    id: string;
    name: string;
    startDate: string;
    endDate: string;
    color: string;
    progress: number;
    status: string;
    type: "task" | "milestone";
    assignee: string | null;
    order: number;
    estimatedHours: number | null;
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

export type ZoomLevel = "day" | "week" | "month";

export type SortKey = "manual" | "name" | "type" | "startDate" | "endDate" | "duration" | "status" | "progress" | "estimatedHours" | "actualHours";
export type SortDir = "asc" | "desc";

export type FilterState = {
    q: string;
    statuses: string[];
    type: "all" | "task" | "milestone";
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
    currentUserId?: string;
    initialPublished: boolean;
};
