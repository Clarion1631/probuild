"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { toast } from "sonner";
import { createScheduleTask, getScheduleCrewMembers } from "@/lib/actions";
import { CrewChecklist, type CrewOption } from "@/app/company-dashboard/schedule-board/CrewPickers";
import { addDays, formatDate, parseUTCDate, todayUTC } from "@/app/projects/[id]/schedule/schedule-utils";

type TaskCreationDialogProps = {
    open: boolean;
    onClose: () => void;
    defaultProjectId?: string;
    lockProject?: boolean;
    defaultStartDate?: string;
    defaultCrewIds?: string[];
    projects: { id: string; name: string; color: string }[];
};

type CreationType = "task" | "milestone" | "appointment";

export default function TaskCreationDialog({
    open,
    onClose,
    defaultProjectId,
    lockProject = false,
    defaultStartDate,
    defaultCrewIds,
    projects,
}: TaskCreationDialogProps) {
    const router = useRouter();
    const initializedOpenRef = useRef(false);
    const [isPending, startTransition] = useTransition();
    const [name, setName] = useState("");
    const [projectId, setProjectId] = useState(defaultProjectId ?? projects[0]?.id ?? "");
    const [type, setType] = useState<CreationType>("task");
    const [startDate, setStartDate] = useState("");
    const [endDate, setEndDate] = useState("");
    const [scheduledTime, setScheduledTime] = useState("");
    const [confirmationStatus, setConfirmationStatus] = useState<"planned" | "requested" | "confirmed">("planned");
    const [crewIds, setCrewIds] = useState<string[]>(defaultCrewIds ?? []);
    const [leadUserId, setLeadUserId] = useState<string | null>(null);
    const [doneWhen, setDoneWhen] = useState("");
    const [estimatedHours, setEstimatedHours] = useState("");
    const [note, setNote] = useState("");
    const [crewOptions, setCrewOptions] = useState<CrewOption[]>([]);

    const selectedProject = projects.find(project => project.id === projectId);
    const defaultCrewKey = (defaultCrewIds ?? []).join(",");
    const defaultCrewValues = useMemo(() => defaultCrewKey ? defaultCrewKey.split(",") : [], [defaultCrewKey]);
    useEffect(() => {
        if (!open) {
            initializedOpenRef.current = false;
            return;
        }
        if (initializedOpenRef.current) return;
        initializedOpenRef.current = true;
        const initialStart = defaultStartDate ?? formatDate(todayUTC());
        setName("");
        setProjectId(defaultProjectId && projects.some(project => project.id === defaultProjectId) ? defaultProjectId : (projects[0]?.id ?? ""));
        setType("task");
        setStartDate(initialStart);
        setEndDate(formatDate(addDays(parseUTCDate(initialStart), 1)));
        setScheduledTime("");
        setConfirmationStatus("planned");
        setCrewIds([...new Set(defaultCrewValues)]);
        setLeadUserId(null);
        setDoneWhen("");
        setEstimatedHours("");
        setNote("");
    }, [open, defaultProjectId, defaultStartDate, defaultCrewValues, projects]);

    useEffect(() => {
        if (!open || projectId || !projects[0]) return;
        setProjectId(projects[0].id);
    }, [open, projectId, projects]);

    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        setCrewOptions([]);
        getScheduleCrewMembers()
            .then(members => {
                if (cancelled) return;
                setCrewOptions(members.map(member => ({ id: member.id, label: member.name || member.email })));
            })
            .catch(error => {
                if (!cancelled) toast.error(error instanceof Error ? error.message : "Could not load field crew");
            });
        return () => { cancelled = true; };
    }, [open]);

    function toggleCrew(userId: string) {
        setCrewIds(current => {
            if (current.includes(userId)) {
                if (leadUserId === userId) setLeadUserId(null);
                return current.filter(id => id !== userId);
            }
            return [...current, userId];
        });
    }

    function submit() {
        const cleanName = name.trim();
        if (!cleanName) { toast.error("Task name is required"); return; }
        if (!projectId) { toast.error("Choose a project"); return; }
        if (!startDate || (type !== "milestone" && !endDate)) { toast.error("Start and end dates are required"); return; }
        if (type !== "milestone" && endDate <= startDate) { toast.error("End date must be after the start date"); return; }
        const hours = estimatedHours.trim() ? Number(estimatedHours) : null;
        if (hours != null && (!Number.isFinite(hours) || hours < 0)) { toast.error("Estimated hours must be zero or greater"); return; }

        startTransition(async () => {
            try {
                await createScheduleTask(projectId, {
                    name: cleanName,
                    startDate,
                    endDate: type === "milestone" ? startDate : endDate,
                    color: selectedProject?.color,
                    type,
                    crewIds,
                    leadUserId,
                    estimatedHours: hours,
                    doneWhen: doneWhen.trim() || null,
                    note: note.trim(),
                    scheduledTime: type === "appointment" ? (scheduledTime || null) : null,
                    confirmationStatus: type === "appointment" ? confirmationStatus : null,
                });
                toast.success(type === "appointment" ? "Appointment created" : type === "milestone" ? "Milestone created" : "Task created");
                onClose();
                router.refresh();
            } catch (error) {
                toast.error(error instanceof Error ? error.message : "Could not create task");
            }
        });
    }

    return (
        <Dialog.Root open={open} onOpenChange={nextOpen => { if (!nextOpen && !isPending) onClose(); }}>
            <Dialog.Portal>
                <Dialog.Overlay asChild>
                    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.16 }} className="fixed inset-0 z-[190] bg-slate-950/45 backdrop-blur-[1px]" />
                </Dialog.Overlay>
                <Dialog.Content asChild>
                <motion.div
                    data-motion-scope="dialog-enter"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: 0.18 }}
                    className="fixed left-1/2 top-1/2 z-[200] flex max-h-[calc(100dvh-2rem)] w-[calc(100vw-1.5rem)] max-w-2xl -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-hui-border bg-white shadow-2xl outline-none sm:w-full"
                >
                    <div className="flex items-start justify-between border-b border-hui-border bg-slate-50 px-5 py-4">
                        <div>
                            <Dialog.Title className="text-base font-bold text-hui-textMain">Create schedule item</Dialog.Title>
                            <Dialog.Description className="mt-0.5 text-xs text-hui-textMuted">Add the scope, timing, and field owner in one pass.</Dialog.Description>
                        </div>
                        <Dialog.Close asChild>
                            <button type="button" disabled={isPending} aria-label="Close task creation" className="rounded-md p-1.5 text-slate-400 transition hover:bg-slate-200 hover:text-slate-700 disabled:opacity-50">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
                            </button>
                        </Dialog.Close>
                    </div>

                    <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5">
                        <div>
                            <label className="text-xs font-semibold uppercase tracking-wider text-hui-textMuted" htmlFor="create-task-name">Name</label>
                            <input id="create-task-name" value={name} onChange={event => setName(event.target.value)} className="hui-input mt-1.5 w-full text-sm" placeholder="e.g. Electrical rough-in walkthrough" autoFocus />
                        </div>

                        <div className="grid gap-4 sm:grid-cols-2">
                            <div>
                                <label className="text-xs font-semibold uppercase tracking-wider text-hui-textMuted" htmlFor="create-task-project">Project</label>
                                <div className="relative mt-1.5">
                                    <span className="absolute left-3 top-1/2 h-2.5 w-2.5 -translate-y-1/2 rounded-full border border-black/10" style={{ backgroundColor: selectedProject?.color ?? "#94a3b8" }} />
                                    <select id="create-task-project" value={projectId} onChange={event => setProjectId(event.target.value)} disabled={lockProject} className="hui-input w-full pl-8 text-sm disabled:bg-slate-100 disabled:text-slate-500">
                                        {projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
                                    </select>
                                </div>
                            </div>
                            <div>
                                <label className="text-xs font-semibold uppercase tracking-wider text-hui-textMuted" htmlFor="create-task-type">Type</label>
                                <select id="create-task-type" value={type} onChange={event => setType(event.target.value as CreationType)} className="hui-input mt-1.5 w-full text-sm">
                                    <option value="task">Task</option>
                                    <option value="milestone">Milestone</option>
                                    <option value="appointment">Appointment</option>
                                </select>
                            </div>
                        </div>

                        <div className={`grid gap-4 ${type === "milestone" ? "grid-cols-1" : "sm:grid-cols-2"}`}>
                            <div><label className="text-xs font-semibold uppercase tracking-wider text-hui-textMuted" htmlFor="create-task-start">{type === "milestone" ? "Date" : "Start"}</label><input id="create-task-start" type="date" value={startDate} onChange={event => setStartDate(event.target.value)} className="hui-input mt-1.5 w-full text-sm" /></div>
                            {type !== "milestone" && <div><label className="text-xs font-semibold uppercase tracking-wider text-hui-textMuted" htmlFor="create-task-end">End</label><input id="create-task-end" type="date" value={endDate} min={startDate} onChange={event => setEndDate(event.target.value)} className="hui-input mt-1.5 w-full text-sm" /></div>}
                        </div>

                        {type === "appointment" && (
                            <div className="grid gap-4 rounded-lg border border-indigo-100 bg-indigo-50/60 p-4 sm:grid-cols-2">
                                <div><label className="text-xs font-semibold uppercase tracking-wider text-indigo-700" htmlFor="create-task-time">Time (Los Angeles)</label><input id="create-task-time" type="time" value={scheduledTime} onChange={event => setScheduledTime(event.target.value)} className="hui-input mt-1.5 w-full bg-white text-sm" /></div>
                                <div><label className="text-xs font-semibold uppercase tracking-wider text-indigo-700" htmlFor="create-task-confirmation">Confirmation</label><select id="create-task-confirmation" value={confirmationStatus} onChange={event => setConfirmationStatus(event.target.value as typeof confirmationStatus)} className="hui-input mt-1.5 w-full bg-white text-sm"><option value="planned">Planned</option><option value="requested">Requested</option><option value="confirmed">Confirmed</option></select></div>
                            </div>
                        )}

                        <div>
                            <label className="text-xs font-semibold uppercase tracking-wider text-hui-textMuted" htmlFor="create-task-done-when">Done when</label>
                            <input id="create-task-done-when" value={doneWhen} onChange={event => setDoneWhen(event.target.value)} className="hui-input mt-1.5 w-full text-sm" placeholder="A clear field-verifiable result" />
                        </div>

                        <div className="rounded-lg border border-hui-border bg-slate-50/60 p-4">
                            <CrewChecklist legend={`Field crew — ${crewIds.length} assigned`} options={crewOptions} selected={crewIds} onToggle={toggleCrew} leadUserId={leadUserId} onLeadChange={setLeadUserId} />
                            <p className="mt-2 text-xs text-slate-400">Select crew, then use the star to name one lead.</p>
                        </div>

                        <details className="group rounded-lg border border-hui-border">
                            <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-xs font-semibold uppercase tracking-wider text-hui-textMuted [&::-webkit-details-marker]:hidden">
                                <svg className="h-3.5 w-3.5 transition-transform group-open:rotate-90" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m9 18 6-6-6-6" /></svg>
                                Details
                            </summary>
                            <div className="grid gap-4 border-t border-hui-border px-4 py-4 sm:grid-cols-2">
                                <div><label className="text-xs font-semibold uppercase tracking-wider text-hui-textMuted" htmlFor="create-task-hours">Estimated hours</label><input id="create-task-hours" type="number" min="0" step="0.25" value={estimatedHours} onChange={event => setEstimatedHours(event.target.value)} className="hui-input mt-1.5 w-full text-sm" placeholder="e.g. 8" /></div>
                                <div><label className="text-xs font-semibold uppercase tracking-wider text-hui-textMuted" htmlFor="create-task-note">First note</label><textarea id="create-task-note" rows={3} value={note} onChange={event => setNote(event.target.value)} className="hui-input mt-1.5 w-full resize-y text-sm" placeholder="Handoff context for the field" /></div>
                            </div>
                        </details>
                    </div>

                    <div className="flex flex-col-reverse gap-2 border-t border-hui-border bg-slate-50 px-5 py-4 sm:flex-row sm:justify-end">
                        <Dialog.Close asChild><button type="button" disabled={isPending} className="hui-btn hui-btn-secondary text-sm">Cancel</button></Dialog.Close>
                        <button type="button" onClick={submit} disabled={isPending || projects.length === 0} className="hui-btn hui-btn-green text-sm">{isPending ? "Creating…" : "Create item"}</button>
                    </div>
                </motion.div>
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    );
}
