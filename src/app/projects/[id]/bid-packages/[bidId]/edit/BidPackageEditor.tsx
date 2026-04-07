"use client";
import { useState, useTransition } from "react";
import Link from "next/link";
import {
    updateBidPackage, addBidScope, deleteBidScope,
    inviteSubToBid, recordBidResponse, awardBid,
} from "@/lib/actions";
import { toast } from "sonner";

interface BidScope {
    id: string;
    name: string;
    description: string | null;
    budgetAmount: number | null;
    order: number;
}

interface BidInvitation {
    id: string;
    email: string;
    subcontractorId: string | null;
    status: string;
    bidAmount: number | null;
    notes: string | null;
    sentAt: Date | null;
    respondedAt: Date | null;
}

interface BidPackage {
    id: string;
    title: string;
    description: string | null;
    dueDate: Date | null;
    status: string;
    totalBudget: number | null;
    project: { id: string; name: string };
    scopes: BidScope[];
    invitations: BidInvitation[];
}

interface Subcontractor {
    id: string;
    companyName: string;
    email: string;
    trade: string | null;
}

interface Props {
    pkg: BidPackage;
    projectId: string;
    subcontractors: Subcontractor[];
}

const STATUS_OPTIONS = ["Draft", "Open", "Awarded", "Closed"];
const INV_STATUS_OPTIONS = ["Invited", "Viewed", "Submitted", "Declined", "Awarded"];

const STATUS_COLORS: Record<string, string> = {
    Draft: "bg-gray-100 text-gray-600",
    Open: "bg-blue-100 text-blue-700",
    Awarded: "bg-green-100 text-green-700",
    Closed: "bg-amber-100 text-amber-700",
};

const INV_COLORS: Record<string, string> = {
    Invited: "bg-blue-100 text-blue-700",
    Viewed: "bg-yellow-100 text-yellow-700",
    Submitted: "bg-green-100 text-green-700",
    Declined: "bg-red-100 text-red-600",
    Awarded: "bg-emerald-100 text-emerald-700",
};

export default function BidPackageEditor({ pkg: initialPkg, projectId, subcontractors }: Props) {
    const [pkg, setPkg] = useState<BidPackage>(initialPkg);
    const [isPending, startTransition] = useTransition();

    // Scope form
    const [showAddScope, setShowAddScope] = useState(false);
    const [scopeName, setScopeName] = useState("");
    const [scopeDesc, setScopeDesc] = useState("");
    const [scopeBudget, setScopeBudget] = useState("");

    // Invite form
    const [showInvite, setShowInvite] = useState(false);
    const [inviteEmail, setInviteEmail] = useState("");
    const [inviteSubId, setInviteSubId] = useState("");

    // Details edit
    const [editDetails, setEditDetails] = useState(false);
    const [detailTitle, setDetailTitle] = useState(pkg.title);
    const [detailDesc, setDetailDesc] = useState(pkg.description ?? "");
    const [detailDue, setDetailDue] = useState(pkg.dueDate ? new Date(pkg.dueDate).toISOString().split("T")[0] : "");
    const [detailStatus, setDetailStatus] = useState(pkg.status);

    const fmt = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0 });

    function handleSaveDetails() {
        startTransition(async () => {
            try {
                await updateBidPackage(pkg.id, projectId, {
                    title: detailTitle,
                    description: detailDesc || undefined,
                    dueDate: detailDue ? new Date(detailDue) : null,
                    status: detailStatus,
                });
                setPkg(p => ({ ...p, title: detailTitle, description: detailDesc || null, dueDate: detailDue ? new Date(detailDue) : null, status: detailStatus }));
                setEditDetails(false);
                toast.success("Package updated");
            } catch {
                toast.error("Failed to update");
            }
        });
    }

    function handleAddScope() {
        if (!scopeName.trim()) return;
        startTransition(async () => {
            try {
                const scope = await addBidScope(pkg.id, projectId, {
                    name: scopeName,
                    description: scopeDesc || undefined,
                    budgetAmount: scopeBudget ? parseFloat(scopeBudget) : null,
                });
                setPkg(p => ({ ...p, scopes: [...p.scopes, scope as BidScope] }));
                setScopeName("");
                setScopeDesc("");
                setScopeBudget("");
                setShowAddScope(false);
                toast.success("Scope added");
            } catch {
                toast.error("Failed to add scope");
            }
        });
    }

    function handleDeleteScope(scopeId: string) {
        if (!confirm("Remove this scope?")) return;
        startTransition(async () => {
            try {
                await deleteBidScope(scopeId, pkg.id, projectId);
                setPkg(p => ({ ...p, scopes: p.scopes.filter(s => s.id !== scopeId) }));
                toast.success("Scope removed");
            } catch {
                toast.error("Failed to remove scope");
            }
        });
    }

    function handleInvite() {
        const email = inviteEmail.trim() || subcontractors.find(s => s.id === inviteSubId)?.email || "";
        if (!email) return;
        startTransition(async () => {
            try {
                const inv = await inviteSubToBid(pkg.id, projectId, { email, subcontractorId: inviteSubId || undefined });
                setPkg(p => ({ ...p, invitations: [...p.invitations, inv as BidInvitation] }));
                setInviteEmail("");
                setInviteSubId("");
                setShowInvite(false);
                toast.success("Invitation sent");
            } catch {
                toast.error("Failed to invite");
            }
        });
    }

    function handleStatusChange(invId: string, status: string) {
        startTransition(async () => {
            try {
                await recordBidResponse(invId, pkg.id, projectId, { status });
                setPkg(p => ({ ...p, invitations: p.invitations.map(i => i.id === invId ? { ...i, status } : i) }));
            } catch {
                toast.error("Failed to update status");
            }
        });
    }

    function handleAward(invId: string) {
        if (!confirm("Award this bid? This will close the package.")) return;
        startTransition(async () => {
            try {
                await awardBid(pkg.id, invId, projectId);
                setPkg(p => ({
                    ...p,
                    status: "Awarded",
                    invitations: p.invitations.map(i => i.id === invId ? { ...i, status: "Awarded" } : i),
                }));
                toast.success("Bid awarded");
            } catch {
                toast.error("Failed to award bid");
            }
        });
    }

    return (
        <div className="max-w-4xl mx-auto py-8 px-6 space-y-6">
            {/* Breadcrumb */}
            <div className="flex items-center gap-2 text-sm text-hui-textMuted">
                <Link href={`/projects/${projectId}`} className="hover:text-hui-textMain">{pkg.project.name}</Link>
                <span>/</span>
                <Link href={`/projects/${projectId}/bid-packages`} className="hover:text-hui-textMain">Bid Packages</Link>
                <span>/</span>
                <span className="text-hui-textMain">{pkg.title}</span>
            </div>

            {/* Header / Details */}
            <div className="hui-card p-5">
                {editDetails ? (
                    <div className="space-y-3">
                        <input value={detailTitle} onChange={e => setDetailTitle(e.target.value)} className="hui-input w-full text-lg font-semibold" placeholder="Package title" />
                        <textarea value={detailDesc} onChange={e => setDetailDesc(e.target.value)} rows={2} className="hui-input w-full resize-none" placeholder="Description" />
                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <label className="block text-xs text-hui-textMuted mb-1">Due Date</label>
                                <input type="date" value={detailDue} onChange={e => setDetailDue(e.target.value)} className="hui-input w-full" />
                            </div>
                            <div>
                                <label className="block text-xs text-hui-textMuted mb-1">Status</label>
                                <select value={detailStatus} onChange={e => setDetailStatus(e.target.value)} className="hui-input w-full">
                                    {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
                                </select>
                            </div>
                        </div>
                        <div className="flex gap-2 justify-end">
                            <button onClick={() => setEditDetails(false)} className="hui-btn hui-btn-secondary text-sm">Cancel</button>
                            <button onClick={handleSaveDetails} disabled={isPending} className="hui-btn hui-btn-primary text-sm disabled:opacity-50">Save</button>
                        </div>
                    </div>
                ) : (
                    <div className="flex items-start justify-between gap-4">
                        <div>
                            <div className="flex items-center gap-3 mb-1">
                                <h1 className="text-xl font-bold text-hui-textMain">{pkg.title}</h1>
                                <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[pkg.status] ?? "bg-gray-100 text-gray-600"}`}>{pkg.status}</span>
                            </div>
                            {pkg.description && <p className="text-sm text-hui-textMuted">{pkg.description}</p>}
                            {pkg.dueDate && <p className="text-xs text-hui-textMuted mt-1">Due: {new Date(pkg.dueDate).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}</p>}
                        </div>
                        <button onClick={() => setEditDetails(true)} className="hui-btn hui-btn-secondary text-xs">Edit Details</button>
                    </div>
                )}
            </div>

            {/* Scope of Work */}
            <div className="hui-card overflow-hidden">
                <div className="px-5 py-3 border-b border-hui-border flex items-center justify-between">
                    <h2 className="text-sm font-semibold text-hui-textMain">Scope of Work</h2>
                    <button onClick={() => setShowAddScope(true)} className="hui-btn hui-btn-secondary text-xs">+ Add Scope</button>
                </div>
                {showAddScope && (
                    <div className="px-5 py-4 border-b border-hui-border bg-hui-surface/30 space-y-2">
                        <input placeholder="Scope name *" value={scopeName} onChange={e => setScopeName(e.target.value)} className="hui-input w-full text-sm" />
                        <input placeholder="Description (optional)" value={scopeDesc} onChange={e => setScopeDesc(e.target.value)} className="hui-input w-full text-sm" />
                        <input type="number" placeholder="Budget amount (optional)" value={scopeBudget} onChange={e => setScopeBudget(e.target.value)} className="hui-input w-full text-sm" />
                        <div className="flex gap-2">
                            <button onClick={() => setShowAddScope(false)} className="hui-btn hui-btn-secondary text-xs">Cancel</button>
                            <button onClick={handleAddScope} disabled={!scopeName.trim() || isPending} className="hui-btn hui-btn-primary text-xs disabled:opacity-50">Add</button>
                        </div>
                    </div>
                )}
                {pkg.scopes.length === 0 ? (
                    <div className="px-5 py-8 text-center text-hui-textMuted text-sm">No scopes yet. Add scopes to describe the work.</div>
                ) : (
                    <div className="divide-y divide-hui-border">
                        {pkg.scopes.map((scope, i) => (
                            <div key={scope.id} className="px-5 py-3 flex items-center justify-between hover:bg-hui-surface/50">
                                <div>
                                    <p className="text-sm font-medium text-hui-textMain">{scope.name}</p>
                                    {scope.description && <p className="text-xs text-hui-textMuted">{scope.description}</p>}
                                </div>
                                <div className="flex items-center gap-3">
                                    {scope.budgetAmount != null && <span className="text-xs font-semibold text-hui-textMuted">{fmt(scope.budgetAmount)}</span>}
                                    <button onClick={() => handleDeleteScope(scope.id)} className="text-xs text-red-500 hover:underline">Remove</button>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* Invite Subcontractors */}
            <div className="hui-card overflow-hidden">
                <div className="px-5 py-3 border-b border-hui-border flex items-center justify-between">
                    <h2 className="text-sm font-semibold text-hui-textMain">Subcontractor Invitations</h2>
                    <button onClick={() => setShowInvite(true)} className="hui-btn hui-btn-secondary text-xs">+ Invite Sub</button>
                </div>
                {showInvite && (
                    <div className="px-5 py-4 border-b border-hui-border bg-hui-surface/30 space-y-2">
                        <div>
                            <label className="block text-xs text-hui-textMuted mb-1">Select from project subcontractors</label>
                            <select value={inviteSubId} onChange={e => { setInviteSubId(e.target.value); if (e.target.value) setInviteEmail(""); }} className="hui-input w-full text-sm">
                                <option value="">— Choose subcontractor —</option>
                                {subcontractors.map(s => <option key={s.id} value={s.id}>{s.companyName} · {s.email}</option>)}
                            </select>
                        </div>
                        <div className="text-xs text-hui-textMuted text-center">or</div>
                        <input
                            type="email"
                            placeholder="Email address"
                            value={inviteEmail}
                            onChange={e => { setInviteEmail(e.target.value); if (e.target.value) setInviteSubId(""); }}
                            className="hui-input w-full text-sm"
                        />
                        <div className="flex gap-2">
                            <button onClick={() => setShowInvite(false)} className="hui-btn hui-btn-secondary text-xs">Cancel</button>
                            <button
                                onClick={handleInvite}
                                disabled={isPending || (!inviteEmail.trim() && !inviteSubId)}
                                className="hui-btn hui-btn-primary text-xs disabled:opacity-50"
                            >
                                Send Invitation
                            </button>
                        </div>
                    </div>
                )}
                {pkg.invitations.length === 0 ? (
                    <div className="px-5 py-8 text-center text-hui-textMuted text-sm">No invitations sent yet.</div>
                ) : (
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="text-left text-xs text-hui-textMuted uppercase tracking-wide border-b border-hui-border bg-hui-surface">
                                <th className="px-5 py-2">Subcontractor</th>
                                <th className="px-5 py-2">Status</th>
                                <th className="px-5 py-2 text-right">Bid Amount</th>
                                <th className="px-5 py-2">Sent</th>
                                <th className="px-5 py-2" />
                            </tr>
                        </thead>
                        <tbody>
                            {pkg.invitations.map(inv => (
                                <tr key={inv.id} className="border-b border-hui-border last:border-0 hover:bg-hui-surface/50">
                                    <td className="px-5 py-3 font-medium text-hui-textMain">{inv.email}</td>
                                    <td className="px-5 py-3">
                                        <select
                                            value={inv.status}
                                            onChange={e => handleStatusChange(inv.id, e.target.value)}
                                            disabled={isPending}
                                            className={`text-xs font-semibold rounded-full px-2 py-1 border-0 cursor-pointer ${INV_COLORS[inv.status] ?? "bg-gray-100 text-gray-600"}`}
                                        >
                                            {INV_STATUS_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
                                        </select>
                                    </td>
                                    <td className="px-5 py-3 text-right font-semibold text-hui-textMain">
                                        {inv.bidAmount != null ? fmt(inv.bidAmount) : "—"}
                                    </td>
                                    <td className="px-5 py-3 text-xs text-hui-textMuted">
                                        {inv.sentAt ? new Date(inv.sentAt).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—"}
                                    </td>
                                    <td className="px-5 py-3">
                                        {inv.status === "Submitted" && pkg.status !== "Awarded" && (
                                            <button onClick={() => handleAward(inv.id)} className="hui-btn hui-btn-primary text-xs py-1">Award</button>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>
        </div>
    );
}
