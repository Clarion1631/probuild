"use client";
import { useState, useTransition } from "react";
import { createBidPackage, deleteBidPackage } from "@/lib/actions";
import { toast } from "sonner";
import Link from "next/link";

interface BidPackage {
    id: string;
    title: string;
    description: string | null;
    dueDate: Date | null;
    status: string;
    totalBudget: number | null;
    scopes: { id: string }[];
    invitations: { id: string; status: string; bidAmount: number | null }[];
}

interface Props {
    projectId: string;
    projectName: string;
    initialPackages: BidPackage[];
}

const STATUS_COLORS: Record<string, string> = {
    Draft: "bg-gray-100 text-gray-600",
    Open: "bg-blue-100 text-blue-700",
    Awarded: "bg-green-100 text-green-700",
    Closed: "bg-amber-100 text-amber-700",
};

export default function BidPackagesClient({ projectId, projectName, initialPackages }: Props) {
    const [packages, setPackages] = useState<BidPackage[]>(initialPackages);
    const [showAdd, setShowAdd] = useState(false);
    const [title, setTitle] = useState("");
    const [description, setDescription] = useState("");
    const [dueDate, setDueDate] = useState("");
    const [isPending, startTransition] = useTransition();

    function handleCreate() {
        if (!title.trim()) return;
        startTransition(async () => {
            try {
                const pkg = await createBidPackage(projectId, {
                    title,
                    description: description || undefined,
                    dueDate: dueDate ? new Date(dueDate) : null,
                });
                setPackages(prev => [{ ...pkg, scopes: [], invitations: [] } as BidPackage, ...prev]);
                setShowAdd(false);
                setTitle("");
                setDescription("");
                setDueDate("");
                toast.success("Bid package created");
            } catch {
                toast.error("Failed to create bid package");
            }
        });
    }

    function handleDelete(id: string) {
        if (!confirm("Delete this bid package?")) return;
        startTransition(async () => {
            try {
                await deleteBidPackage(id, projectId);
                setPackages(prev => prev.filter(p => p.id !== id));
                toast.success("Bid package deleted");
            } catch {
                toast.error("Failed to delete");
            }
        });
    }

    const fmt = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0 });

    return (
        <div className="max-w-4xl mx-auto py-8 px-6 space-y-6">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold text-hui-textMain">Bid Packages</h1>
                    <p className="text-sm text-hui-textMuted mt-1">Send scopes to subcontractors and collect bids.</p>
                </div>
                <button onClick={() => setShowAdd(true)} className="hui-btn hui-btn-primary text-sm">+ New Bid Package</button>
            </div>

            {showAdd && (
                <div className="hui-card p-4 space-y-3">
                    <h3 className="text-sm font-semibold text-hui-textMain">New Bid Package</h3>
                    <input
                        placeholder="Package title *"
                        value={title}
                        onChange={e => setTitle(e.target.value)}
                        className="hui-input w-full"
                    />
                    <textarea
                        placeholder="Description (optional)"
                        value={description}
                        onChange={e => setDescription(e.target.value)}
                        rows={2}
                        className="hui-input w-full resize-none"
                    />
                    <div>
                        <label className="block text-xs text-hui-textMuted mb-1">Due Date (optional)</label>
                        <input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} className="hui-input w-full" />
                    </div>
                    <div className="flex gap-2 justify-end">
                        <button onClick={() => setShowAdd(false)} className="hui-btn hui-btn-secondary text-sm">Cancel</button>
                        <button onClick={handleCreate} disabled={isPending || !title.trim()} className="hui-btn hui-btn-primary text-sm disabled:opacity-50">
                            {isPending ? "Creating…" : "Create"}
                        </button>
                    </div>
                </div>
            )}

            {packages.length === 0 ? (
                <div className="hui-card p-12 text-center">
                    <div className="w-12 h-12 bg-hui-primary/10 rounded-full flex items-center justify-center mx-auto mb-4">
                        <svg className="w-6 h-6 text-hui-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                        </svg>
                    </div>
                    <p className="font-semibold text-hui-textMain mb-2">No Bid Packages Yet</p>
                    <p className="text-sm text-hui-textMuted">Create a bid package to invite subcontractors and collect competitive bids.</p>
                </div>
            ) : (
                <div className="space-y-3">
                    {packages.map(pkg => {
                        const submitted = pkg.invitations.filter(i => i.status === "Submitted").length;
                        const lowestBid = pkg.invitations
                            .filter(i => i.bidAmount != null)
                            .reduce((min, i) => (i.bidAmount! < min ? i.bidAmount! : min), Infinity);
                        return (
                            <div key={pkg.id} className="hui-card p-5 hover:shadow-md transition-shadow">
                                <div className="flex items-start justify-between gap-4">
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-3 mb-1">
                                            <Link href={`/projects/${projectId}/bid-packages/${pkg.id}/edit`} className="font-semibold text-hui-textMain hover:text-hui-primary transition">
                                                {pkg.title}
                                            </Link>
                                            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[pkg.status] ?? "bg-gray-100 text-gray-600"}`}>
                                                {pkg.status}
                                            </span>
                                        </div>
                                        {pkg.description && <p className="text-sm text-hui-textMuted mb-2">{pkg.description}</p>}
                                        <div className="flex items-center gap-4 text-xs text-hui-textMuted">
                                            <span>{pkg.scopes.length} scope{pkg.scopes.length !== 1 ? "s" : ""}</span>
                                            <span>{pkg.invitations.length} invited</span>
                                            {submitted > 0 && <span className="text-green-600 font-medium">{submitted} submitted</span>}
                                            {lowestBid !== Infinity && <span>Lowest: {fmt(lowestBid)}</span>}
                                            {pkg.dueDate && <span>Due {new Date(pkg.dueDate).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>}
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-2 shrink-0">
                                        <Link href={`/projects/${projectId}/bid-packages/${pkg.id}/edit`} className="hui-btn hui-btn-secondary text-xs py-1.5 px-3">Edit</Link>
                                        <button onClick={() => handleDelete(pkg.id)} className="text-xs text-red-500 hover:underline">Delete</button>
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
