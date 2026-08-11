"use client";

import { useState, useTransition, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
    updateProjectCode,
    updateProjectType,
    updateProjectStartDateAction,
    updateProjectEndDateAction,
    updateProjectTags,
} from "@/lib/actions";

const PROJECT_TYPES = ["Kitchen Remodel", "Bath Remodel", "Addition", "ADU", "Whole Home", "Deck", "Repair", "Other"];

function formatDate(d: string | null) {
    if (!d) return null;
    return new Date(d).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

function toDateInputValue(d: string | null) {
    if (!d) return "";
    return new Date(d).toISOString().split("T")[0];
}

function Row({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="py-2 flex items-center justify-between gap-3">
            <span className="text-xs text-slate-400 shrink-0">{label}</span>
            <div className="min-w-0 text-right">{children}</div>
        </div>
    );
}

interface JobInfoCardProps {
    projectId: string;
    code: string | null;
    type: string | null;
    startDate: string | null;
    endDate: string | null;
    tags: string | null;
    location: string | null;
    permitCount: number;
    permitSummary: string;
}

export default function JobInfoCard({
    projectId,
    code,
    type,
    startDate,
    endDate,
    tags,
    location,
    permitCount,
    permitSummary,
}: JobInfoCardProps) {
    const [editing, setEditing] = useState(false);
    const [codeValue, setCodeValue] = useState(code || "");
    const [typeValue, setTypeValue] = useState(type || "");
    const [startDateValue, setStartDateValue] = useState(toDateInputValue(startDate));
    const [endDateValue, setEndDateValue] = useState(toDateInputValue(endDate));
    const [tagsValue, setTagsValue] = useState(tags || "");
    const [isPending, startTransition] = useTransition();
    const router = useRouter();

    const tagList = (tags || "").split(",").map(t => t.trim()).filter(Boolean);

    const resetForm = () => {
        setCodeValue(code || "");
        setTypeValue(type || "");
        setStartDateValue(toDateInputValue(startDate));
        setEndDateValue(toDateInputValue(endDate));
        setTagsValue(tags || "");
    };

    const handleCancel = () => {
        resetForm();
        setEditing(false);
    };

    const handleSave = () => {
        startTransition(async () => {
            try {
                const ops: Promise<any>[] = [];

                const trimmedCode = codeValue.trim();
                if (trimmedCode !== (code || "")) ops.push(updateProjectCode(projectId, trimmedCode));

                const trimmedType = typeValue.trim();
                if (trimmedType !== (type || "")) ops.push(updateProjectType(projectId, trimmedType));

                const normalizedStart = toDateInputValue(startDate);
                if (startDateValue !== normalizedStart) ops.push(updateProjectStartDateAction(projectId, startDateValue || null, false));

                const normalizedEnd = toDateInputValue(endDate);
                if (endDateValue !== normalizedEnd) ops.push(updateProjectEndDateAction(projectId, endDateValue || null));

                const trimmedTags = tagsValue.trim();
                if (trimmedTags !== (tags || "")) ops.push(updateProjectTags(projectId, trimmedTags));

                if (ops.length > 0) {
                    await Promise.all(ops);
                    toast.success("Job info updated");
                    router.refresh();
                }
                setEditing(false);
            } catch (err: any) {
                toast.error(err.message || "Failed to update job info");
            }
        });
    };

    return (
        <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
                <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wider">Job Info</h3>
                {editing ? (
                    <div className="flex items-center gap-3">
                        <button onClick={handleCancel} disabled={isPending} className="text-[11px] font-semibold text-slate-400 hover:text-slate-600 transition">
                            Cancel
                        </button>
                        <button onClick={handleSave} disabled={isPending} className="text-[11px] font-semibold text-indigo-600 hover:text-indigo-800 transition">
                            {isPending ? "Saving..." : "Save"}
                        </button>
                    </div>
                ) : (
                    <button onClick={() => setEditing(true)} className="text-[11px] font-semibold text-indigo-600 hover:text-indigo-800 transition">
                        Edit
                    </button>
                )}
            </div>

            {editing ? (
                <div className="px-4 py-3 space-y-3">
                    <div>
                        <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Job Code</label>
                        <input
                            value={codeValue}
                            onChange={e => setCodeValue(e.target.value)}
                            disabled={isPending}
                            placeholder="e.g. JOB-1042"
                            className="hui-input mt-1 text-xs"
                        />
                    </div>
                    <div>
                        <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Type</label>
                        <input
                            value={typeValue}
                            onChange={e => setTypeValue(e.target.value)}
                            disabled={isPending}
                            list="job-info-type-options"
                            placeholder="e.g. Kitchen Remodel"
                            className="hui-input mt-1 text-xs"
                        />
                        <datalist id="job-info-type-options">
                            {PROJECT_TYPES.map(t => <option key={t} value={t} />)}
                        </datalist>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                        <div>
                            <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Start Date</label>
                            <input
                                type="date"
                                value={startDateValue}
                                onChange={e => setStartDateValue(e.target.value)}
                                disabled={isPending}
                                className="hui-input mt-1 text-xs"
                            />
                        </div>
                        <div>
                            <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">End Date</label>
                            <input
                                type="date"
                                value={endDateValue}
                                onChange={e => setEndDateValue(e.target.value)}
                                disabled={isPending}
                                className="hui-input mt-1 text-xs"
                            />
                        </div>
                    </div>
                    <div>
                        <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Address</label>
                        <p className="text-xs text-slate-500 mt-1">{location || "—"}</p>
                        <p className="text-[10px] text-slate-400 mt-0.5">Edit in the page header</p>
                    </div>
                    <div>
                        <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Tags</label>
                        <input
                            value={tagsValue}
                            onChange={e => setTagsValue(e.target.value)}
                            disabled={isPending}
                            placeholder="Comma-separated, e.g. Priority, Coastal"
                            className="hui-input mt-1 text-xs"
                        />
                    </div>
                </div>
            ) : (
                <div className="px-4 py-1 divide-y divide-slate-100">
                    <Row label="Job Code">
                        <span className="font-mono text-xs text-hui-textMain">{code || "—"}</span>
                    </Row>
                    <Row label="Type">
                        <span className="text-xs text-hui-textMain">{type || "—"}</span>
                    </Row>
                    <Row label="Start Date">
                        <span className="text-xs text-hui-textMain">{formatDate(startDate) || "—"}</span>
                    </Row>
                    <Row label="End Date">
                        <span className="text-xs text-hui-textMain">{formatDate(endDate) || "—"}</span>
                    </Row>
                    <Row label="Address">
                        <span className="text-xs text-hui-textMain">{location || "—"}</span>
                    </Row>
                    <Row label="Tags">
                        {tagList.length > 0 ? (
                            <div className="flex gap-1 flex-wrap justify-end">
                                {tagList.map((tag, i) => (
                                    <span key={i} className="px-2 py-0.5 text-[10px] font-medium bg-slate-100 text-slate-600 border border-slate-200 rounded-full">
                                        {tag}
                                    </span>
                                ))}
                            </div>
                        ) : (
                            <span className="text-xs text-slate-400">—</span>
                        )}
                    </Row>
                    <Row label="Permits">
                        <Link href={`/projects/${projectId}/permits`} className="text-xs text-indigo-600 font-medium hover:text-indigo-800 transition">
                            {permitCount === 0 ? "None yet" : permitSummary}
                        </Link>
                    </Row>
                </div>
            )}
        </div>
    );
}
