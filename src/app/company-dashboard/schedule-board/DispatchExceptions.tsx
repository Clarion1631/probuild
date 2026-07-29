"use client";

import { motion } from "framer-motion";
import type { CrewConflict, DashboardProjectRow } from "@/lib/schedule-core";
import { getDispatchExceptions } from "./dispatch-exceptions";
import { summarizeEvidenceCoverage, sumEvidenceCoverage } from "@/lib/task-evidence";

interface DispatchExceptionsProps {
    projects: DashboardProjectRow[];
    crewConflicts: CrewConflict[] | null;
    dayKey: string;
    onActivate: (taskId: string) => void;
    onProjectFocus: (projectId: string) => void;
}

export function DispatchExceptions({ projects, crewConflicts, dayKey, onActivate, onProjectFocus }: DispatchExceptionsProps) {
    const groups = getDispatchExceptions(projects, crewConflicts ?? [], dayKey);
    const pills = [
        {
            key: "unstaffed",
            label: "Unstaffed today",
            count: groups.unstaffed.length,
            tone: "border-amber-300 bg-amber-50 text-amber-800",
            title: groups.unstaffed.map(item => `${item.projectName}: ${item.taskName}`).join("\n"),
            activate: () => groups.unstaffed[0] && onActivate(groups.unstaffed[0].taskId),
        },
        {
            key: "no-lead",
            label: "No lead",
            count: groups.noLead.length,
            tone: "border-amber-300 bg-amber-50 text-amber-800",
            title: groups.noLead.map(item => `${item.projectName}: ${item.taskName}`).join("\n"),
            activate: () => groups.noLead[0] && onActivate(groups.noLead[0].taskId),
        },
        {
            key: "conflict",
            label: "Conflict",
            count: groups.conflicts.length,
            tone: "border-red-300 bg-red-50 text-red-700",
            title: groups.conflicts.map(item => item.userName).join("\n"),
            activate: () => groups.conflicts[0]?.taskIds[0] && onActivate(groups.conflicts[0].taskIds[0]),
        },
        {
            key: "blocked",
            label: "Blocked",
            count: groups.blocked.length,
            tone: "border-red-300 bg-red-50 text-red-700",
            title: groups.blocked.map(item => `${item.projectName}: ${item.taskName}${item.reason ? ` \u2014 ${item.reason}` : ""}`).join("\n"),
            activate: () => groups.blocked[0] && onActivate(groups.blocked[0].taskId),
        },
        {
            key: "crewless",
            label: "Crewless job",
            count: groups.crewless.length,
            tone: "border-amber-300 bg-amber-50 text-amber-800",
            title: groups.crewless.map(item => item.projectName).join("\n"),
            activate: () => groups.crewless[0] && onProjectFocus(groups.crewless[0].projectId),
        },
        {
            key: "needs-review",
            label: "Needs review",
            count: groups.needsReview.length,
            tone: "border-red-300 bg-red-50 text-red-700",
            title: groups.needsReview.map(item => `${item.projectName}: ${item.taskName}${item.reason ? ` — ${item.reason}` : ""}`).join("\n"),
            activate: () => groups.needsReview[0] && onActivate(groups.needsReview[0].taskId),
        },
        {
            key: "unknown-state",
            label: "No field update",
            count: groups.unknownState.length,
            tone: "border-slate-300 bg-slate-100 text-slate-700",
            title: groups.unknownState.map(item => `${item.projectName}: ${item.taskName}`).join("\n"),
            activate: () => groups.unknownState[0] && onActivate(groups.unknownState[0].taskId),
        },
        {
            key: "stale-evidence",
            label: "Going stale",
            count: groups.staleEvidence.length,
            tone: "border-amber-300 bg-amber-50 text-amber-800",
            title: groups.staleEvidence.map(item => `${item.projectName}: ${item.taskName}`).join("\n"),
            activate: () => groups.staleEvidence[0] && onActivate(groups.staleEvidence[0].taskId),
        },
    ].filter(pill => pill.count > 0);

    // Counts, deliberately not a single "% true" score: recent activity proves
    // someone worked, not that dates/crew/status are right, so a percentage
    // would read healthy while the schedule was wrong.
    const coverage = sumEvidenceCoverage(projects
        .filter(project => project.status === "In Progress")
        .map(project => summarizeEvidenceCoverage(
            project.tasks,
            new Set(project.tasks.map(task => task.parentId).filter((id): id is string => !!id)),
            dayKey,
            { unboundPunches: project.unboundPunches },
        )));
    // Render whenever there is anything to say — not just when eligible > 0.
    // Unbound punches with no eligible task is precisely the case where the
    // board would otherwise claim "Day clear" while dropping evidence.
    const showCoverage = coverage.eligible > 0 || coverage.unboundPunches > 0 || coverage.needsReview > 0;
    const coverageParts = [
        coverage.eligible > 0 ? `${coverage.confirmed} of ${coverage.eligible} active tasks confirmed` : null,
        coverage.stale > 0 ? `${coverage.stale} going stale` : null,
        coverage.unknown > 0 ? `${coverage.unknown} with no field update` : null,
        coverage.needsReview > 0 ? `${coverage.needsReview} needs review` : null,
        coverage.unboundPunches > 0 ? `${coverage.unboundPunches} unlinked punches` : null,
    ].filter((part): part is string => !!part);

    return (
        <motion.div
            data-motion-scope="exceptions-strip"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.16 }}
            className="border-b border-hui-border bg-slate-50/80 px-4 py-2.5"
            aria-label="Dispatch exceptions"
        >
            {pills.length === 0 ? (
                <p className="text-xs font-medium text-slate-500">{"Day clear \u2713"}</p>
            ) : (
                <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Exceptions</span>
                    {pills.map(pill => (
                        <button
                            key={pill.key}
                            type="button"
                            onClick={pill.activate}
                            title={pill.title}
                            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold transition hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hui-primary ${pill.tone}`}
                        >
                            <span className="inline-flex min-w-4 items-center justify-center rounded-full bg-white/80 px-1 text-[10px] font-bold">{pill.count}</span>
                            {pill.label}
                        </button>
                    ))}
                </div>
            )}
            {showCoverage && (
                <p className="mt-1.5 text-[11px] text-slate-500" aria-label="Evidence coverage">
                    {coverageParts.join(" \u00b7 ")}
                </p>
            )}
        </motion.div>
    );
}
