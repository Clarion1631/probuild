"use client";

import { useEffect, useState } from "react";
import GanttChart from "./GanttChart";
import TableView from "./TableView";
import type { ScheduleViewProps, Task } from "./schedule-types";

export default function ScheduleView({ initialTasks, ...rest }: ScheduleViewProps) {
    const [viewMode, setViewMode] = useState<"gantt" | "table">("gantt");
    const [tasks, setTasks] = useState<Task[]>(initialTasks);

    // Re-sync when the server passes new initialTasks (router.refresh / page revisit).
    useEffect(() => { setTasks(initialTasks); }, [initialTasks]);

    const shared = { ...rest, tasks, setTasks, viewMode, onViewModeChange: setViewMode };
    return viewMode === "gantt" ? <GanttChart {...shared} /> : <TableView {...shared} />;
}
