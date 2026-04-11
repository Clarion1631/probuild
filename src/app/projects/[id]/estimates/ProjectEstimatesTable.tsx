"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import StatusBadge from "@/components/StatusBadge";
import CopyToProjectButton, { CopyToProjectModal } from "@/components/CopyToProjectButton";
import DeleteEstimateButton from "@/components/DeleteEstimateButton";
import BulkActionBar, { DeleteIcon, CopyIcon, MoveIcon } from "@/components/BulkActionBar";
import { formatCurrency } from "@/lib/utils";
import { deleteEstimates, duplicateEstimates, duplicateEstimate } from "@/lib/actions";
import { toast } from "sonner";

type Project = { id: string; name: string };
type Estimate = {
    id: string;
    title: string;
    status: string;
    totalAmount: any;
    createdAt: string | Date;
};

export default function ProjectEstimatesTable({
    projectId,
    estimates,
    allProjects,
}: {
    projectId: string;
    estimates: Estimate[];
    allProjects: Project[];
}) {
    const router = useRouter();
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const [isBulking, setIsBulking] = useState(false);
    const [showBulkCopyModal, setShowBulkCopyModal] = useState(false);

    const allSelected = estimates.length > 0 && estimates.every((e) => selectedIds.includes(e.id));

    async function handleBulkDelete() {
        if (selectedIds.length === 0) return;
        if (!confirm(`Delete ${selectedIds.length} estimate${selectedIds.length === 1 ? "" : "s"}?`)) return;
        setIsBulking(true);
        try {
            const res = await deleteEstimates(selectedIds);
            setSelectedIds([]);
            if (res.skipped.length > 0) {
                toast.success(`Deleted ${res.deleted} · ${res.skipped.length} skipped (${res.skipped[0].reason})`);
            } else {
                toast.success(`Deleted ${res.deleted} estimate${res.deleted === 1 ? "" : "s"}`);
            }
            router.refresh();
        } catch (e: any) {
            toast.error(e?.message || "Failed to delete estimates");
        } finally {
            setIsBulking(false);
        }
    }

    async function handleBulkDuplicate() {
        if (selectedIds.length === 0) return;
        setIsBulking(true);
        try {
            const res = await duplicateEstimates(selectedIds);
            setSelectedIds([]);
            if (res.skipped.length > 0) {
                toast.success(`Duplicated ${res.createdIds.length} · ${res.skipped.length} skipped`);
            } else {
                toast.success(`Duplicated ${res.createdIds.length} estimate${res.createdIds.length === 1 ? "" : "s"}`);
            }
            router.refresh();
        } catch (e: any) {
            toast.error(e?.message || "Failed to duplicate estimates");
        } finally {
            setIsBulking(false);
        }
    }

    async function handleSingleDuplicate(estimateId: string) {
        try {
            const res = await duplicateEstimate(estimateId);
            toast.success("Estimate duplicated");
            router.push(`/projects/${projectId}/estimates/${res.id}`);
        } catch (e: any) {
            toast.error(e?.message || "Failed to duplicate estimate");
        }
    }

    return (
        <>
            {/* Bulk action bar — shown when any row is selected */}
            {selectedIds.length > 0 && (
                <div className="mb-4 flex justify-end">
                    <BulkActionBar
                        count={selectedIds.length}
                        onClear={() => setSelectedIds([])}
                        actions={[
                            {
                                label: "Duplicate",
                                icon: CopyIcon,
                                onClick: handleBulkDuplicate,
                                disabled: isBulking,
                            },
                            {
                                label: "Copy to project…",
                                icon: MoveIcon,
                                onClick: () => setShowBulkCopyModal(true),
                                disabled: isBulking,
                            },
                            {
                                label: "Delete",
                                icon: DeleteIcon,
                                onClick: handleBulkDelete,
                                variant: "danger",
                                disabled: isBulking,
                            },
                        ]}
                    />
                </div>
            )}

            {/* Estimates Table */}
            <div className="bg-white rounded-xl shadow-sm border border-slate-200/80 overflow-hidden">
                <table className="w-full text-sm text-left">
                    <thead>
                        <tr className="bg-gradient-to-r from-slate-50 to-slate-100/50 border-b border-slate-200">
                            <th className="px-4 py-3.5 w-10 text-center">
                                <input
                                    type="checkbox"
                                    className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                                    checked={allSelected}
                                    onChange={(e) => {
                                        if (e.target.checked) setSelectedIds(estimates.map((est) => est.id));
                                        else setSelectedIds([]);
                                    }}
                                />
                            </th>
                            <th className="px-6 py-3.5 font-semibold text-xs text-slate-500 uppercase tracking-wider">Estimate Name</th>
                            <th className="px-6 py-3.5 font-semibold text-xs text-slate-500 uppercase tracking-wider">Status</th>
                            <th className="px-6 py-3.5 font-semibold text-xs text-slate-500 uppercase tracking-wider text-right">Total Amount</th>
                            <th className="px-6 py-3.5 font-semibold text-xs text-slate-500 uppercase tracking-wider text-right">Date</th>
                            <th className="w-24"></th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                        {estimates.length === 0 && (
                            <tr>
                                <td colSpan={6} className="px-6 py-16 text-center">
                                    <div className="flex flex-col items-center gap-3">
                                        <div className="w-14 h-14 bg-gradient-to-br from-indigo-100 to-purple-100 rounded-2xl flex items-center justify-center">
                                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" /></svg>
                                        </div>
                                        <p className="text-sm font-medium text-slate-500">No estimates yet</p>
                                        <p className="text-xs text-slate-400 max-w-xs">Create your first estimate to start tracking project costs and send proposals to clients.</p>
                                    </div>
                                </td>
                            </tr>
                        )}
                        {estimates.map((est) => {
                            const isSelected = selectedIds.includes(est.id);
                            return (
                                <tr
                                    key={est.id}
                                    className={`hover:bg-slate-50/80 transition group ${isSelected ? "bg-indigo-50/30" : ""}`}
                                >
                                    <td className="px-4 py-4 text-center">
                                        <input
                                            type="checkbox"
                                            className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                                            checked={isSelected}
                                            onChange={(e) => {
                                                if (e.target.checked) setSelectedIds([...selectedIds, est.id]);
                                                else setSelectedIds(selectedIds.filter((id) => id !== est.id));
                                            }}
                                        />
                                    </td>
                                    <td className="px-6 py-4">
                                        <Link href={`/projects/${projectId}/estimates/${est.id}`} className="font-medium text-hui-textMain hover:text-hui-primary transition-colors flex items-center gap-2">
                                            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-50 to-indigo-50 flex items-center justify-center shrink-0 border border-indigo-100/50">
                                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><path d="M14 2v6h6" /></svg>
                                            </div>
                                            {est.title}
                                        </Link>
                                    </td>
                                    <td className="px-6 py-4"><StatusBadge status={est.status as any} /></td>
                                    <td className="px-6 py-4 text-right font-semibold text-slate-700">{formatCurrency(Number(est.totalAmount || 0))}</td>
                                    <td className="px-6 py-4 text-right text-slate-400 text-xs">{new Date(est.createdAt).toLocaleDateString()}</td>
                                    <td className="px-4 py-4">
                                        <div className="flex items-center gap-1 justify-end">
                                            <button
                                                type="button"
                                                title="Duplicate estimate (same project)"
                                                onClick={() => handleSingleDuplicate(est.id)}
                                                className="text-slate-300 hover:text-slate-600 hover:bg-slate-100 rounded p-1.5 transition opacity-0 group-hover:opacity-100"
                                            >
                                                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
                                            </button>
                                            <CopyToProjectButton
                                                estimateId={est.id}
                                                estimateTitle={est.title}
                                                currentProjectId={projectId}
                                                allProjects={allProjects}
                                            />
                                            <DeleteEstimateButton
                                                estimateId={est.id}
                                                estimateTitle={est.title}
                                                status={est.status}
                                            />
                                            <Link href={`/projects/${projectId}/estimates/${est.id}`} className="text-slate-300 hover:text-slate-600 opacity-0 group-hover:opacity-100 transition">
                                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 5l7 7-7 7" /></svg>
                                            </Link>
                                        </div>
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>

            <CopyToProjectModal
                mode="bulk"
                open={showBulkCopyModal}
                onClose={() => setShowBulkCopyModal(false)}
                estimateIds={selectedIds}
                currentProjectId={projectId}
                allProjects={allProjects}
                onDone={() => setSelectedIds([])}
            />
        </>
    );
}
