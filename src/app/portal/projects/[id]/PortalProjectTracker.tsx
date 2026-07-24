"use client";

import type { CSSProperties } from "react";
import Link from "next/link";
import { motion, MotionConfig } from "framer-motion";
import {
    ArrowUpRight,
    CalendarDays,
    Check,
    Clock3,
    HardHat,
    Wrench,
} from "lucide-react";

import type {
    PortalDayVisitors,
    PortalProjectTrackerPayload,
} from "@/lib/portal-tracker";

type TrackerStyle = CSSProperties & {
    "--project-accent": string;
};

function parseDateOnly(date: string): Date {
    return new Date(`${date}T12:00:00.000Z`);
}

function formatTaskDate(date: string): string {
    return parseDateOnly(date).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
    });
}

function dayLabel(date: string): { weekday: string; date: string } {
    const value = parseDateOnly(date);
    return {
        weekday: value.toLocaleDateString("en-US", { weekday: "short" }),
        date: value.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
    };
}

function hasVisitors(day: PortalDayVisitors): boolean {
    return day.crew.length > 0
        || day.subcontractors.length > 0
        || day.appointments.length > 0;
}

export default function PortalProjectTracker({
    projectId,
    projectName,
    data,
}: {
    projectId: string;
    projectName: string;
    data: PortalProjectTrackerPayload;
}) {
    const currentIndex = data.stages.findIndex(stage => stage.state === "current");
    const visibleDays = data.whoIsComing.filter(hasVisitors);

    return (
        <MotionConfig reducedMotion="user">
            <motion.section
                aria-labelledby="project-route-heading"
                style={{ "--project-accent": data.projectColor } as TrackerStyle}
                initial={{ opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.46, ease: [0.22, 1, 0.36, 1] }}
                className="relative isolate overflow-hidden rounded-[1.75rem] border border-slate-200 bg-white shadow-[0_24px_70px_-46px_rgba(15,23,42,0.5)]"
            >
                <div
                    aria-hidden="true"
                    className="absolute inset-x-0 top-0 h-32 opacity-90"
                    style={{
                        background:
                            "linear-gradient(135deg, color-mix(in srgb, var(--project-accent) 18%, white), white 64%)",
                    }}
                />
                <div
                    aria-hidden="true"
                    className="absolute inset-x-0 top-0 h-32 opacity-25"
                    style={{
                        backgroundImage:
                            "linear-gradient(90deg, color-mix(in srgb, var(--project-accent) 22%, transparent) 1px, transparent 1px), linear-gradient(color-mix(in srgb, var(--project-accent) 18%, transparent) 1px, transparent 1px)",
                        backgroundSize: "24px 24px",
                        maskImage: "linear-gradient(to bottom, black, transparent)",
                    }}
                />

                <div className="relative px-4 pb-5 pt-5 sm:px-6 sm:pb-6 sm:pt-6 lg:px-8">
                    <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0">
                            <p
                                className="mb-2 text-[0.68rem] font-extrabold uppercase tracking-[0.22em]"
                                style={{ color: "var(--project-accent)" }}
                            >
                                Your project route
                            </p>
                            <h2
                                id="project-route-heading"
                                className="text-balance text-xl font-bold tracking-[-0.025em] text-slate-950 sm:text-2xl"
                            >
                                See what&apos;s done, what&apos;s moving, and what comes next.
                            </h2>
                            <p className="mt-1.5 max-w-2xl text-sm leading-6 text-slate-600">
                                A simple view of {projectName}&apos;s major construction stages.
                            </p>
                        </div>

                        <div
                            className="relative flex h-16 w-16 shrink-0 rotate-2 flex-col items-center justify-center rounded-2xl border-2 bg-white/85 shadow-sm backdrop-blur sm:h-[4.5rem] sm:w-[4.5rem]"
                            style={{ borderColor: "var(--project-accent)" }}
                            aria-label={`${data.overallPct}% complete`}
                        >
                            <span className="text-xl font-black leading-none text-slate-950 sm:text-2xl">
                                {data.overallPct}%
                            </span>
                            <span className="mt-1 text-[0.55rem] font-extrabold uppercase tracking-[0.14em] text-slate-500">
                                complete
                            </span>
                        </div>
                    </div>

                    <div
                        className="-mx-4 mt-6 overflow-x-auto px-4 pb-2 pt-2 [scrollbar-width:thin] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--project-accent)] focus-visible:ring-offset-2 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8"
                        tabIndex={0}
                        aria-label="Project stages. Scroll horizontally to see every stage."
                    >
                        <ol className="flex min-w-max snap-x snap-mandatory">
                            {data.stages.map((stage, index) => {
                                const isComplete = stage.state === "complete";
                                const isCurrent = stage.state === "current";
                                const connectorPct = isComplete
                                    ? 100
                                    : isCurrent
                                        ? stage.pct
                                        : 0;

                                return (
                                    <li
                                        key={stage.label}
                                        className="relative w-[7.6rem] snap-center px-2 text-center sm:w-[8.6rem]"
                                    >
                                        {index < data.stages.length - 1 && (
                                            <div
                                                aria-hidden="true"
                                                className="absolute left-1/2 top-[1.38rem] h-1 w-full overflow-hidden rounded-full bg-slate-200"
                                            >
                                                <motion.div
                                                    className="h-full origin-left rounded-full"
                                                    initial={{ scaleX: 0 }}
                                                    animate={{ scaleX: connectorPct / 100 }}
                                                    transition={{
                                                        duration: 0.72,
                                                        delay: 0.08 + index * 0.05,
                                                        ease: [0.22, 1, 0.36, 1],
                                                    }}
                                                    style={{
                                                        backgroundColor: "var(--project-accent)",
                                                        boxShadow:
                                                            "0 0 14px color-mix(in srgb, var(--project-accent) 50%, transparent)",
                                                    }}
                                                />
                                            </div>
                                        )}

                                        <motion.div
                                            initial={{ scale: 0.88, opacity: 0 }}
                                            animate={{ scale: 1, opacity: 1 }}
                                            transition={{
                                                duration: 0.32,
                                                delay: 0.04 + index * 0.045,
                                            }}
                                            className="relative z-10 mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border-2 bg-white"
                                            style={{
                                                borderColor: isComplete || isCurrent
                                                    ? "var(--project-accent)"
                                                    : "#cbd5e1",
                                                backgroundColor: isComplete || isCurrent
                                                    ? "var(--project-accent)"
                                                    : "#ffffff",
                                                color: isComplete || isCurrent ? "#ffffff" : "#64748b",
                                                boxShadow: isCurrent
                                                    ? "0 0 0 7px color-mix(in srgb, var(--project-accent) 16%, transparent), 0 10px 24px -12px var(--project-accent)"
                                                    : "0 3px 10px -7px rgba(15, 23, 42, .45)",
                                            }}
                                            aria-current={isCurrent ? "step" : undefined}
                                            aria-label={`${stage.label}: ${stage.state}, ${stage.pct}%`}
                                        >
                                            {isComplete ? (
                                                <Check className="h-5 w-5" strokeWidth={3} aria-hidden="true" />
                                            ) : isCurrent ? (
                                                <HardHat className="h-5 w-5" strokeWidth={2.25} aria-hidden="true" />
                                            ) : (
                                                <span className="text-xs font-black">{index + 1}</span>
                                            )}
                                        </motion.div>

                                        <p
                                            className={`mt-3 text-[0.72rem] font-bold leading-4 ${
                                                isCurrent ? "text-slate-950" : "text-slate-600"
                                            }`}
                                        >
                                            {stage.label}
                                        </p>
                                        <p
                                            className="mt-1 text-[0.62rem] font-bold uppercase tracking-[0.12em]"
                                            style={{ color: isCurrent ? "var(--project-accent)" : "#94a3b8" }}
                                        >
                                            {isCurrent
                                                ? `${stage.pct}% now`
                                                : isComplete
                                                    ? "Done"
                                                    : index === currentIndex + 1
                                                        ? "Next"
                                                        : "Upcoming"}
                                        </p>
                                    </li>
                                );
                            })}
                        </ol>
                    </div>
                </div>
            </motion.section>

            <div className="mt-4 grid gap-4 lg:grid-cols-[0.9fr_1.35fr]">
                <motion.section
                    aria-labelledby="whats-next-heading"
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.38, delay: 0.12 }}
                    className="hui-card overflow-hidden p-0"
                >
                    <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-4 sm:px-5">
                        <div>
                            <p className="text-[0.65rem] font-extrabold uppercase tracking-[0.18em] text-slate-400">
                                On deck
                            </p>
                            <h3 id="whats-next-heading" className="mt-0.5 font-bold text-slate-950">
                                What&apos;s next
                            </h3>
                        </div>
                        <Link
                            href={`/portal/projects/${projectId}/schedule`}
                            className="inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2.5 text-xs font-bold text-slate-600 transition hover:bg-slate-50 hover:text-slate-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--project-accent)]"
                        >
                            Full schedule
                            <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
                        </Link>
                    </div>

                    {data.whatsNext.length > 0 ? (
                        <ol className="divide-y divide-slate-100">
                            {data.whatsNext.map((task, index) => (
                                <li key={`${task.name}-${task.startDate}`} className="flex gap-3 px-4 py-4 sm:px-5">
                                    <span
                                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-xs font-black text-white"
                                        style={{ backgroundColor: "var(--project-accent)" }}
                                        aria-hidden="true"
                                    >
                                        {index + 1}
                                    </span>
                                    <div className="min-w-0">
                                        <p className="text-sm font-semibold leading-5 text-slate-900">{task.name}</p>
                                        <p className="mt-1 flex items-center gap-1.5 text-xs text-slate-500">
                                            <CalendarDays className="h-3.5 w-3.5" aria-hidden="true" />
                                            Starts {formatTaskDate(task.startDate)}
                                        </p>
                                    </div>
                                </li>
                            ))}
                        </ol>
                    ) : (
                        <div className="px-5 py-7 text-sm leading-6 text-slate-500">
                            No new task is queued yet. Your project team will add the next step here.
                        </div>
                    )}
                </motion.section>

                <motion.section
                    aria-labelledby="coming-heading"
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.38, delay: 0.17 }}
                    className="hui-card overflow-hidden p-0"
                >
                    <div className="border-b border-slate-100 px-4 py-4 sm:px-5">
                        <p className="text-[0.65rem] font-extrabold uppercase tracking-[0.18em] text-slate-400">
                            Next 7 days
                        </p>
                        <h3 id="coming-heading" className="mt-0.5 font-bold text-slate-950">
                            Who&apos;s coming this week
                        </h3>
                    </div>

                    {visibleDays.length > 0 ? (
                        <div className="divide-y divide-slate-100">
                            {visibleDays.map(day => {
                                const label = dayLabel(day.date);
                                return (
                                    <div
                                        key={day.date}
                                        className="grid grid-cols-[3.4rem_1fr] gap-3 px-4 py-3.5 sm:grid-cols-[4.4rem_1fr] sm:px-5"
                                    >
                                        <div className="border-r border-slate-100 pr-3">
                                            <p className="text-xs font-black uppercase tracking-wide text-slate-800">
                                                {label.weekday}
                                            </p>
                                            <p className="mt-0.5 text-[0.68rem] text-slate-500">{label.date}</p>
                                        </div>
                                        <div className="flex min-w-0 flex-wrap gap-2">
                                            {day.crew.map(name => (
                                                <span
                                                    key={`crew-${day.date}-${name}`}
                                                    className="inline-flex min-h-8 items-center gap-1.5 rounded-full bg-slate-900 px-3 py-1 text-xs font-semibold text-white"
                                                >
                                                    <HardHat className="h-3.5 w-3.5" aria-hidden="true" />
                                                    {name}
                                                </span>
                                            ))}
                                            {day.subcontractors.map(company => (
                                                <span
                                                    key={`sub-${day.date}-${company}`}
                                                    className="inline-flex min-h-8 items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-700"
                                                >
                                                    <Wrench
                                                        className="h-3.5 w-3.5"
                                                        style={{ color: "var(--project-accent)" }}
                                                        aria-hidden="true"
                                                    />
                                                    {company}
                                                </span>
                                            ))}
                                            {day.appointments.map(appointment => (
                                                <span
                                                    key={`appointment-${day.date}-${appointment.name}-${appointment.scheduledTime}`}
                                                    className="inline-flex min-h-8 flex-wrap items-center gap-1.5 rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-xs font-semibold text-blue-900"
                                                >
                                                    <Clock3 className="h-3.5 w-3.5" aria-hidden="true" />
                                                    {appointment.scheduledTime || "Time to come"} · {appointment.name}
                                                    {appointment.confirmationStatus === "pending confirmation" && (
                                                        <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[0.62rem] font-bold text-amber-800">
                                                            pending confirmation
                                                        </span>
                                                    )}
                                                </span>
                                            ))}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    ) : (
                        <div className="px-5 py-7 text-sm leading-6 text-slate-500">
                            No crew visits or appointments are scheduled for the next seven days.
                        </div>
                    )}
                </motion.section>
            </div>
        </MotionConfig>
    );
}
