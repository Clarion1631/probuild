"use client";

import { useEffect, useState } from "react";
import PortalGanttChart from "./PortalGanttChart";
import PortalCalendarView from "./PortalCalendarView";

type Dependency = { id: string; predecessorId: string; dependentId: string };
type Assignment = { id: string; userId: string; firstName: string };
type SubAssignment = { id: string; companyName: string };
type Comment = { id: string; text: string; createdAt: string; authorName: string };

export type PortalTask = {
    id: string;
    name: string;
    startDate: string;
    endDate: string;
    color: string;
    progress: number;
    status: string;
    type: "task" | "milestone";
    order: number;
    dependencies: Dependency[];
    assignments?: Assignment[];
    subAssignments?: SubAssignment[];
    comments?: Comment[];
};

export type PortalViewMode = "calendar" | "gantt";
export type PortalCalendarSubMode = "month" | "week";

const VIEW_KEY = "probuild:portal:schedule:viewMode";
const SUB_KEY = "probuild:portal:schedule:calendarSubMode";

interface Props {
    projectId: string;
    initialTasks: PortalTask[];
    subcontractorId: string | null;
}

export default function PortalScheduleView({ projectId, initialTasks, subcontractorId }: Props) {
    const [viewMode, setViewMode] = useState<PortalViewMode>("calendar");
    const [calendarSubMode, setCalendarSubMode] = useState<PortalCalendarSubMode>("month");
    const [hydrated, setHydrated] = useState(false);
    const [tasks, setTasks] = useState<PortalTask[]>(initialTasks);

    useEffect(() => { setTasks(initialTasks); }, [initialTasks]);

    useEffect(() => {
        try {
            const v = localStorage.getItem(VIEW_KEY);
            if (v === "calendar" || v === "gantt") setViewMode(v);
            const s = localStorage.getItem(SUB_KEY);
            if (s === "month" || s === "week") setCalendarSubMode(s);
        } catch { /* ignore */ }
        setHydrated(true);
    }, []);

    function changeViewMode(m: PortalViewMode) {
        setViewMode(m);
        if (hydrated) { try { localStorage.setItem(VIEW_KEY, m); } catch { /* ignore */ } }
    }
    function changeSubMode(m: PortalCalendarSubMode) {
        setCalendarSubMode(m);
        if (hydrated) { try { localStorage.setItem(SUB_KEY, m); } catch { /* ignore */ } }
    }

    if (viewMode === "calendar") {
        return (
            <PortalCalendarView
                projectId={projectId}
                tasks={tasks}
                setTasks={setTasks}
                subcontractorId={subcontractorId}
                viewMode={viewMode}
                onViewModeChange={changeViewMode}
                subMode={calendarSubMode}
                onSubModeChange={changeSubMode}
            />
        );
    }

    return (
        <PortalGanttChart
            tasks={tasks}
            setTasks={setTasks}
            subcontractorId={subcontractorId}
            viewMode={viewMode}
            onViewModeChange={changeViewMode}
        />
    );
}
