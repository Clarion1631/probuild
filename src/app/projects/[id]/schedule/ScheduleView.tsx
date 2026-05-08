"use client";

import { useState } from "react";
import GanttChart from "./GanttChart";
import TableView from "./TableView";
import type { ScheduleViewProps } from "./schedule-types";

export default function ScheduleView(props: ScheduleViewProps) {
    const [viewMode, setViewMode] = useState<"gantt" | "table">("gantt");

    return viewMode === "gantt" ? (
        <GanttChart {...props} viewMode={viewMode} onViewModeChange={setViewMode} />
    ) : (
        <TableView {...props} viewMode={viewMode} onViewModeChange={setViewMode} />
    );
}
