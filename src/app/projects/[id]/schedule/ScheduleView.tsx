"use client";

import { useEffect, useState } from "react";
import GanttChart from "./GanttChart";
import TableView from "./TableView";
import CalendarView from "./CalendarView";
import type { ScheduleViewProps } from "./schedule-types";

type ViewMode = "gantt" | "table" | "calendar";
type CalendarSubMode = "month" | "week";

const VIEW_KEY = "probuild:schedule:viewMode";
const SUB_KEY = "probuild:schedule:calendarSubMode";

export default function ScheduleView(props: ScheduleViewProps) {
    const [viewMode, setViewMode] = useState<ViewMode>("gantt");
    const [calendarSubMode, setCalendarSubMode] = useState<CalendarSubMode>("week");
    const [hydrated, setHydrated] = useState(false);

    useEffect(() => {
        try {
            const v = localStorage.getItem(VIEW_KEY);
            if (v === "gantt" || v === "table" || v === "calendar") setViewMode(v);
            const s = localStorage.getItem(SUB_KEY);
            if (s === "month" || s === "week") setCalendarSubMode(s);
        } catch { /* ignore */ }
        setHydrated(true);
    }, []);

    function changeViewMode(m: ViewMode) {
        setViewMode(m);
        if (hydrated) { try { localStorage.setItem(VIEW_KEY, m); } catch { /* ignore */ } }
    }
    function changeSubMode(m: CalendarSubMode) {
        setCalendarSubMode(m);
        if (hydrated) { try { localStorage.setItem(SUB_KEY, m); } catch { /* ignore */ } }
    }

    if (viewMode === "calendar") {
        return (
            <CalendarView
                projectId={props.projectId}
                initialTasks={props.initialTasks}
                viewMode={viewMode}
                onViewModeChange={changeViewMode}
                subMode={calendarSubMode}
                onSubModeChange={changeSubMode}
            />
        );
    }
    if (viewMode === "table") {
        return <TableView {...props} viewMode={viewMode} onViewModeChange={changeViewMode} />;
    }
    return <GanttChart {...props} viewMode={viewMode} onViewModeChange={changeViewMode} />;
}
