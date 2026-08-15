"use client";

import { useState } from "react";
import { updateChangeOrder, deleteChangeOrder, countersignChangeOrderAsCompany, sendChangeOrderToClient, previewCostPlusChangeOrder, billCostPlusChangeOrder, manuallyApproveChangeOrder } from "@/lib/actions";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import Link from "next/link";
import { formatCurrency } from "@/lib/utils";
import { coTaxRate, coTaxLabel, coLineCents, coItemsSubtotal, effectiveCoTaxInfo } from "@/lib/co-tax";

// handleSave's return type: the server action returns a JSON-serialized Prisma row,
// but status/revision are the only fields the manual-approval CAS and Send-for-Approval
// paths depend on.
type SavedChangeOrder = { status: string; revision: number } & Record<string, unknown>;

export default function ChangeOrderEditor({ context, initialData }: { context: any, initialData: any }) {
    const router = useRouter();
    const [title, setTitle] = useState(initialData.title);
    const [description, setDescription] = useState(initialData.description || "");
    const [status, setStatus] = useState(initialData.status);
    const [items, setItems] = useState<any[]>(initialData.items || []);
    const [paymentSchedules, setPaymentSchedules] = useState<any[]>(initialData.paymentSchedules || []);
    const [pricingType, setPricingType] = useState<"FIXED" | "COST_PLUS">(initialData.pricingType === "COST_PLUS" ? "COST_PLUS" : "FIXED");
    const [markupPercent, setMarkupPercent] = useState(String(initialData.markupPercent ?? 10));
    const [isSaving, setIsSaving] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);
    const [activeTab, setActiveTab] = useState("builder"); // builder | details
    const [showSignModal, setShowSignModal] = useState(false);
    const [signName, setSignName] = useState("");
    const [isSigning, setIsSigning] = useState(false);
    const [isSending, setIsSending] = useState(false);
    const [isBilling, setIsBilling] = useState(false);
    const [billingPreview, setBillingPreview] = useState<any | null>(null);
    const [showManualApproveConfirm, setShowManualApproveConfirm] = useState(false);
    const [isManuallyApproving, setIsManuallyApproving] = useState(false);
    // Tracks the CO's revision across saves so handleSave/handleManualApprove can send
    // an expectedRevision CAS token that reflects what THIS tab last wrote, not just what
    // the page loaded with — initialData.revision never updates after mount, since Next
    // passing fresh server props to an already-mounted client component does not re-run
    // useState's initializer.
    const [revision, setRevision] = useState<number>(initialData.revision);

    // A signed CO is a contract: title, description, and items are the approved
    // scope and remain immutable after approval. The server enforces the same
    // rule; these disabled controls make that invariant visible in the editor.
    const isApproved = status === "Approved";
    const hasSignatureAudit = !!(
        initialData.approvedBy
        || initialData.approvedAt
        || initialData.clientSignatureUrl
        || initialData.companySignedBy
        || initialData.companySignedAt
        || initialData.companySignatureUrl
    );
    const isScopeLocked = isApproved || hasSignatureAudit;
    const canCountersign = status === "Sent" || status === "Approved";
    const canManuallyApprove = (status === "Draft" || status === "Sent") && !initialData.clientSignatureUrl;

    // Same integer-cents math as the server's item sync and billChangeOrderCore,
    // so the Revised Amount shown here is exactly what billing will charge.
    // Tax follows the estimate's treatment (tax-exempt customers pay none) — kept
    // in sync with the portal signature page and billChangeOrderCore via lib/co-tax.
    const subtotal = coItemsSubtotal(items);
    const taxInfo = effectiveCoTaxInfo(initialData, initialData.estimate);
    const tax = Math.round(subtotal * coTaxRate(taxInfo) * 100) / 100;
    const total = Math.round((subtotal + tax) * 100) / 100;
    const taxLabel = coTaxLabel(taxInfo);
    const unbilledTime = (initialData.timeEntries || []).filter((row: any) => row.isBillable && !row.invoiceId && !row.invoicedAt);
    const unbilledExpenses = (initialData.expenses || []).filter((row: any) => row.isBillable && !row.invoiceId && !row.invoicedAt);
    const actualHours = unbilledTime.reduce((sum: number, row: any) => sum + Number(row.durationHours || 0), 0);
    const actualLabor = unbilledTime.reduce((sum: number, row: any) => sum + Number(row.laborCost || 0) + Number(row.burdenCost || 0), 0);
    const actualExpenses = unbilledExpenses.reduce((sum: number, row: any) => sum + Number(row.amount || 0), 0);
    const scheduledPriorCents = paymentSchedules.slice(0, -1).reduce((sum: number, row: any) => sum + Math.round(Number(row.amount || 0) * 100), 0);
    const finalScheduleCents = Math.round(subtotal * 100) - scheduledPriorCents;

    async function handleSign() {
        if (!signName.trim()) { toast.error("Please enter a name to sign"); return; }
        setIsSigning(true);
        try {
            // Company countersignature — writes only the company fields and never
            // touches the customer's approval (see countersignChangeOrderAsCompany).
            await countersignChangeOrderAsCompany(initialData.id, signName.trim());
            toast.success("Change order countersigned");
            setShowSignModal(false);
            router.refresh();
        } catch (e: any) {
            toast.error(e?.message || "Failed to countersign change order");
        } finally {
            setIsSigning(false);
        }
    }

    async function handleManualApprove() {
        setIsManuallyApproving(true);
        try {
            // Save first, exactly like Send for Approval below — otherwise a staff
            // member could edit items/pricing, then approve, and bill whatever was
            // last saved to the DB instead of what's on screen. Fail closed: a
            // failed save must never reach the approval call. handleSave() already
            // toasts its own failure.
            // On the scope-locked path we pass the tracked revision (last set by our
            // own save/approve, defaulting to the page-load value), so a countersign or
            // any other edit this tab did not itself make fails closed with a refresh message.
            const saved = isScopeLocked ? { revision } : await handleSave();
            if (!saved) return;
            // Staff-side approval — bills the same as the portal path but never
            // emails the client (see manuallyApproveChangeOrder).
            const updated = await manuallyApproveChangeOrder(initialData.id, saved.revision);
            setStatus(updated.status);
            setRevision(updated.revision);
            toast.success("Change order marked as approved (manual)");
            setShowManualApproveConfirm(false);
            router.refresh();
        } catch (e: any) {
            toast.error(e?.message || "Failed to mark as approved");
            // A CAS conflict means initialData.revision is stale — leaving the
            // confirm dialog open just re-fails the same retry until a manual
            // reload, since initialData never refreshes on its own. Close it and
            // refresh so the next attempt picks up the current revision.
            if (e?.message?.includes("was modified after this page loaded")) {
                setShowManualApproveConfirm(false);
                router.refresh();
            }
        } finally {
            setIsManuallyApproving(false);
        }
    }

    // Returns whether the save persisted — the send flow must not email the client
    // a signature request when the save failed (they'd sign the stale amounts).
    async function handleSave(): Promise<SavedChangeOrder | null> {
        if (isDeleting) return null; // Prevent saving if we are in the middle of deleting
        if (isScopeLocked) {
            toast.error("Signed change orders are locked. Create a new change order for additional work.");
            return null;
        }
        setIsSaving(true);
        const mappedItems = items.map((item, index) => ({
            id: item.id,
            name: item.name,
            description: item.description || null,
            type: item.type,
            quantity: parseFloat(item.quantity) || 0,
            unitCost: parseFloat(item.unitCost) || 0,
            order: index,
            costCodeId: item.costCodeId || null,
            costTypeId: item.costTypeId || null,
        }));

        try {
            // The server syncs the items and recomputes totalAmount from them as the
            // PRE-TAX subtotal (billing adds the estimate's tax on top) — sending a
            // tax-inclusive total here is what inflated billed amounts before.
            // Status is never sent: sendChangeOrderToClientCore owns Draft -> Sent,
            // and Approved/Declined belong to the signature flows.
            const updated = await updateChangeOrder(initialData.id, {
                title,
                description,
                items: mappedItems,
                pricingType,
                markupPercent: pricingType === "COST_PLUS" ? Number(markupPercent || 10) : null,
                paymentSchedules: pricingType === "COST_PLUS" ? [] : paymentSchedules.map((row, index) => ({
                    id: row.id,
                    name: row.name,
                    amount: index === paymentSchedules.length - 1 ? finalScheduleCents / 100 : Number(row.amount || 0),
                    dueDate: row.dueDate || null,
                    order: index,
                })),
                expectedRevision: revision,
            });
            setStatus(updated.status);
            setRevision(updated.revision);
            toast.success("Change Order saved");
            router.refresh();
            return updated;
        } catch (e: any) {
            toast.error(e?.message || "Failed to save CO");
            // A conflict refreshes server-rendered data. This state token remains
            // stale until a full reload, so retries continue to fail closed.
            if (e?.message?.includes("was modified after this page loaded")) router.refresh();
            return null;
        } finally {
            setIsSaving(false);
        }
    }

    async function handleDelete() {
        if (!confirm("Delete this Change Order?")) return;
        setIsDeleting(true);
        try {
            await deleteChangeOrder(initialData.id);
            toast.success("Change Order deleted");
            router.push(`/projects/${context.projectId}/change-orders`);
        } catch (error) {
            toast.error("Failed to delete");
        } finally {
            setIsDeleting(false);
        }
    }

    function generateId() {
        return Math.random().toString(36).substr(2, 9);
    }

    function addItem() {
        setItems([...items, {
            id: generateId(),
            name: "",
            description: "",
            quantity: 1,
            unitCost: 0,
            total: 0
        }]);
    }

    function removeItem(index: number) {
        const newItems = [...items];
        newItems.splice(index, 1);
        setItems(newItems);
    }

    function updateItem(index: number, field: string, value: any) {
        const newItems = [...items];
        newItems[index][field] = value;
        setItems(newItems);
    }

    function addSchedule() {
        setPaymentSchedules((rows) => [...rows, { id: generateId(), name: `Payment ${rows.length + 1}`, amount: 0, dueDate: "", order: rows.length }]);
    }

    function updateSchedule(index: number, field: string, value: any) {
        setPaymentSchedules((rows) => rows.map((row, rowIndex) => rowIndex === index ? { ...row, [field]: value } : row));
    }

    async function previewActuals() {
        const throughDate = new Date().toLocaleDateString("en-CA");
        setIsBilling(true);
        try {
            const preview = await previewCostPlusChangeOrder(initialData.id, throughDate);
            setBillingPreview(preview);
        } catch (error: any) {
            toast.error(error?.message || "Could not preview billable actuals");
        } finally {
            setIsBilling(false);
        }
    }

    async function confirmBillActuals() {
        if (!billingPreview) return;
        setIsBilling(true);
        try {
            await billCostPlusChangeOrder(
                initialData.id,
                billingPreview.throughDate,
                billingPreview.fingerprint,
                billingPreview.invoiceId,
                billingPreview.markupPercent,
                billingPreview.taxRate,
            );
            toast.success("Actuals billed to the project invoice");
            setBillingPreview(null);
            router.refresh();
        } catch (error: any) {
            toast.error(error?.message || "Billing failed; refresh the preview and try again");
        } finally {
            setIsBilling(false);
        }
    }

    return (
        <>
        <div className="flex flex-col h-full bg-slate-50">
            {/* Top Navigation / Action Bar */}
            <div className="bg-white border-b border-hui-border px-6 py-4 items-center flex justify-between shadow-sm z-10 sticky top-0">
                <div className="flex items-center gap-4">
                    <Link href={`/projects/${context.projectId}/change-orders`} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-hui-textMain bg-white border border-hui-border rounded-md hover:bg-slate-50 transition shadow-sm">
                        ← Back to Change Orders
                    </Link>
                    <div className="h-4 w-px bg-hui-border"></div>
                    <span className="text-sm font-medium text-hui-textMain">{initialData.code}</span>
                    <span className={`px-2 py-0.5 rounded text-xs border ${
                        status === "Approved" ? "bg-green-100 text-green-800 border-green-200" :
                        status === "Sent" ? "bg-blue-100 text-blue-800 border-blue-200" : "bg-slate-100 text-hui-textMuted border-hui-border"
                    }`}>{status}</span>
                </div>

                {/* Tabs Middle */}
                <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-lg absolute left-1/2 -translate-x-1/2">
                    <button
                        onClick={() => setActiveTab("builder")}
                        className={`px-4 py-1.5 text-sm font-medium rounded-md transition ${activeTab === "builder" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}
                    >
                        Builder
                    </button>
                    <button
                        onClick={() => setActiveTab("details")}
                        className={`px-4 py-1.5 text-sm font-medium rounded-md transition ${activeTab === "details" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}
                    >
                        Details & Signatures
                    </button>
                </div>

                <div className="flex items-center gap-2">
                    <a
                        href={`/api/pdf/change-orders/${initialData.id}?inline=true`}
                        target="_blank"
                        rel="noreferrer"
                        className="hui-btn hui-btn-secondary text-slate-600 hover:bg-slate-100"
                    >
                        Preview PDF
                    </a>
                    <a
                        href={`/api/pdf/change-orders/${initialData.id}`}
                        target="_blank"
                        rel="noreferrer"
                        className="hui-btn hui-btn-secondary text-slate-600 hover:bg-slate-100"
                    >
                        Download PDF
                    </a>
                    <button
                        onClick={handleDelete}
                        disabled={isDeleting || status !== "Draft" || hasSignatureAudit}
                        title={status !== "Draft" || hasSignatureAudit ? "Only unsigned Draft change orders can be deleted" : undefined}
                        className="hui-btn hui-btn-secondary text-red-600 border-red-200 hover:bg-red-50 disabled:opacity-50"
                    >
                        Delete
                    </button>
                    <button
                        disabled={isSending || isApproved}
                        title={isApproved ? "Approved change orders cannot be resent" : undefined}
                        onClick={async () => {
                            if (!confirm("Save and send this change order to the client for approval?")) return;
                            setIsSending(true);
                            try {
                                // Save first, then send email. A failed save must
                                // abort the send — otherwise the client is asked to
                                // sign amounts that never persisted. The Sent status
                                // is owned by sendChangeOrderToClientCore; the local
                                // badge only updates after a confirmed send.
                                const saved = isScopeLocked ? true : await handleSave();
                                if (!saved) return;
                                const result = await sendChangeOrderToClient(initialData.id);
                                if (result.success) {
                                    setStatus("Sent");
                                    toast.success(`Change order sent to ${result.sentTo}`);
                                    router.refresh();
                                } else {
                                    toast.error(result.error || "Failed to send");
                                }
                            } catch {
                                toast.error("Failed to send change order");
                            } finally {
                                setIsSending(false);
                            }
                        }}
                        className="hui-btn hui-btn-secondary bg-blue-50 text-blue-700 hover:bg-blue-100 border-blue-200 disabled:opacity-50"
                    >
                        {isSending ? "Sending..." : "Send for Approval"}
                    </button>
                    <button
                        onClick={handleSave}
                        disabled={isSaving || isScopeLocked}
                        title={isScopeLocked ? "Signed change orders are locked" : undefined}
                        className="hui-btn hui-btn-primary bg-amber-600 hover:bg-amber-700 border-amber-600 text-white disabled:opacity-50"
                    >
                        {isSaving ? "Saving..." : "Save"}
                    </button>
                </div>
            </div>

            <div className="flex-1 p-8 flex justify-center pb-24 overflow-y-auto">
                {activeTab === "builder" && (
                    <div className="w-full max-w-5xl">
                        <div className="bg-white rounded-xl shadow-[0_8px_30px_rgb(0,0,0,0.04)] border border-slate-200 overflow-hidden relative">
                            <div className="h-1.5 w-full bg-gradient-to-r from-amber-500 via-orange-500 to-red-500"></div>
                            <div className="p-10 pb-12 space-y-10 border-b border-slate-100">
                                <input
                                    type="text"
                                    value={title}
                                    disabled={isScopeLocked}
                                    onChange={e => setTitle(e.target.value)}
                                    className="text-4xl font-extrabold tracking-tight text-slate-800 w-full focus:outline-none focus:bg-slate-50 hover:bg-slate-50 transition-colors rounded-lg px-3 py-2 -ml-3 placeholder:text-slate-300 bg-transparent"
                                    placeholder="Change Order Title"
                                />

                                <div className="flex justify-between items-start gap-12 text-sm px-3">
                                    <div className="space-y-1">
                                        <p className="text-[11px] font-semibold tracking-widest uppercase text-slate-400 mb-2">Change Order For</p>
                                        <p className="font-semibold text-base text-slate-800">{context.clientName}</p>
                                        <p className="text-slate-500">{context.projectName} • {context.location}</p>
                                    </div>
                                    <div className="bg-slate-50 p-5 rounded-lg border border-slate-100 min-w-[280px]">
                                        <div className="grid grid-cols-2 gap-x-4 gap-y-4">
                                            <label className="text-slate-500 font-medium">CO No.</label>
                                            <span className="font-semibold text-slate-800 text-right">{initialData.code}</span>
                                            
                                            <label className="text-slate-500 font-medium">Original Est.</label>
                                            <span className="text-right font-medium text-slate-800 truncate">{initialData.estimate?.title}</span>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-5 px-10 py-6 border-b border-slate-100 bg-amber-50/30">
                                <div>
                                    <label className="block text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">Pricing type</label>
                                    <select
                                        value={pricingType}
                                        disabled={isScopeLocked}
                                        onChange={e => {
                                            const value = e.target.value as "FIXED" | "COST_PLUS";
                                            setPricingType(value);
                                            if (value === "COST_PLUS") setPaymentSchedules([]);
                                        }}
                                        className="hui-input w-full"
                                    >
                                        <option value="FIXED">Fixed price</option>
                                        <option value="COST_PLUS">Cost plus</option>
                                    </select>
                                </div>
                                {pricingType === "COST_PLUS" && (
                                    <div>
                                        <label className="block text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">Markup percent</label>
                                        <div className="relative">
                                            <input type="number" min="0" max="1000" step="0.1" value={markupPercent} disabled={isScopeLocked} onChange={e => setMarkupPercent(e.target.value)} className="hui-input w-full pr-10" />
                                            <span className="absolute right-3 top-2.5 text-slate-400">%</span>
                                        </div>
                                        <p className="text-xs text-slate-500 mt-2">Billed from actual time & materials at cost + {markupPercent || 0}% + tax.</p>
                                    </div>
                                )}
                            </div>

                            <div className="bg-white">
                                <div className="flex text-[11px] font-bold text-slate-400 bg-slate-50/80 border-b border-slate-100 px-8 py-4 uppercase tracking-wider">
                                    <div className="flex-1">{pricingType === "COST_PLUS" ? "Scope estimate (not a fixed price)" : "Item Description"}</div>
                                    <div className="w-24 text-right">Qty</div>
                                    <div className="w-32 text-right">Unit Cost</div>
                                    <div className="w-32 text-right">Total</div>
                                    <div className="w-10"></div>
                                </div>

                                <div className="divide-y divide-slate-100">
                                    {items.map((item, index) => {
                                        const itemTotal = coLineCents(parseFloat(item.quantity) || 0, parseFloat(item.unitCost) || 0) / 100;
                                        return (
                                            <div key={item.id} className="flex items-start px-8 py-3 bg-white group hover:bg-slate-50 transition border-transparent border-l-2">
                                                <div className="flex-1">
                                                    <input
                                                        type="text"
                                                        value={item.name}
                                                        disabled={isScopeLocked}
                                                        onChange={e => updateItem(index, "name", e.target.value)}
                                                        className="w-full bg-transparent focus:outline-none focus:bg-white focus:ring-1 ring-hui-border rounded px-2 py-1 -ml-2 transition text-sm font-medium text-hui-textMain"
                                                    />
                                                {(!isScopeLocked || item.description) && (
                                                    <textarea
                                                        value={item.description || ""}
                                                        disabled={isScopeLocked}
                                                        onChange={e => updateItem(index, "description", e.target.value)}
                                                        placeholder="Detailed description (shown to the client)"
                                                        rows={Math.min(12, Math.max(1, ((item.description || "").match(/\n/g)?.length ?? 0) + 1, Math.ceil((item.description || "").length / 90)))}
                                                        className="w-full mt-1 bg-transparent focus:outline-none focus:bg-white focus:ring-1 ring-hui-border rounded px-2 py-1 -ml-2 transition text-xs text-slate-500 leading-relaxed resize-y placeholder:text-slate-300"
                                                    />
                                                )}
                                                </div>
                                                <div className="w-24 px-4 pt-1 text-right">
                                                    <input
                                                        type="number"
                                                        value={item.quantity}
                                                        disabled={isScopeLocked}
                                                        onChange={e => updateItem(index, "quantity", e.target.value)}
                                                        className="w-full bg-transparent focus:outline-none focus:bg-white focus:ring-1 ring-slate-200 rounded px-2 py-1 text-right hover:bg-slate-50 transition text-sm font-medium text-slate-700"
                                                    />
                                                </div>
                                                <div className="w-32 px-4 pt-1 text-right relative">
                                                    <span className="absolute left-6 top-1.5 text-slate-400 text-sm">$</span>
                                                    <input
                                                        type="number"
                                                        value={item.unitCost}
                                                        disabled={isScopeLocked}
                                                        onChange={e => updateItem(index, "unitCost", e.target.value)}
                                                        className="w-full bg-transparent focus:outline-none focus:bg-white focus:ring-1 ring-slate-200 rounded px-2 py-1 pl-6 text-right hover:bg-slate-50 transition text-sm font-medium text-slate-700"
                                                    />
                                                </div>
                                                <div className="w-32 px-4 pt-2 text-right font-semibold text-slate-800 text-sm">
                                                    {formatCurrency(itemTotal)}
                                                </div>
                                                <div className="w-10 pt-1.5 flex justify-end">
                                                    {!isScopeLocked && (
                                                        <button onClick={() => removeItem(index)} className="text-slate-300 hover:text-red-500 hover:bg-red-50 rounded p-1.5 transition opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto [@media(hover:none)]:opacity-100 [@media(hover:none)]:pointer-events-auto">
                                                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
                                                        </button>
                                                    )}
                                                </div>
                                            </div>
                                        );
                                    })}
                                    {items.length === 0 && (
                                        <div className="p-8 text-center text-slate-400 text-sm">No items attached to this Change Order.</div>
                                    )}
                                </div>

                                {!isScopeLocked && (
                                    <div className="p-4 px-8 border-t border-slate-100 bg-white hover:bg-slate-50 transition-colors flex items-center gap-4 cursor-pointer group" onClick={addItem}>
                                        <button className="text-sm font-semibold text-amber-600 group-hover:text-amber-700 flex items-center gap-2 transition">
                                            <span className="bg-amber-50 text-amber-600 group-hover:bg-amber-100 rounded p-1">
                                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14"/></svg>
                                            </span>
                                            Add New Item
                                        </button>
                                    </div>
                                )}
                            </div>

                            {pricingType === "FIXED" && (
                                <div className="border-t border-slate-200 px-8 py-7 bg-white">
                                    <div className="flex items-center justify-between mb-4">
                                        <div>
                                            <h3 className="font-bold text-slate-800">Payment schedule</h3>
                                            <p className="text-xs text-slate-500 mt-1">Optional. Use at least two positive payments; the final payment absorbs the cent-exact remainder.</p>
                                        </div>
                                        {!isScopeLocked && <button type="button" onClick={addSchedule} className="hui-btn hui-btn-secondary text-sm">Add payment</button>}
                                    </div>
                                    <div className="space-y-3">
                                        {paymentSchedules.map((row, index) => {
                                            const isLast = index === paymentSchedules.length - 1;
                                            return (
                                                <div key={row.id || index} className="grid grid-cols-[1fr_150px_160px_40px] gap-3 items-center">
                                                    <input value={row.name || ""} disabled={isScopeLocked} onChange={e => updateSchedule(index, "name", e.target.value)} className="hui-input" placeholder={`Payment ${index + 1}`} />
                                                    <input type="number" min="0.01" step="0.01" value={isLast ? Math.max(0, finalScheduleCents) / 100 : row.amount || ""} disabled={isScopeLocked || isLast} onChange={e => updateSchedule(index, "amount", e.target.value)} className="hui-input text-right" aria-label={`Payment ${index + 1} amount`} />
                                                    <input type="date" value={row.dueDate ? String(row.dueDate).slice(0, 10) : ""} disabled={isScopeLocked} onChange={e => updateSchedule(index, "dueDate", e.target.value)} className="hui-input" />
                                                    {!isScopeLocked && <button type="button" onClick={() => setPaymentSchedules(rows => rows.filter((_, rowIndex) => rowIndex !== index))} className="text-slate-400 hover:text-red-600">×</button>}
                                                </div>
                                            );
                                        })}
                                    </div>
                                    {paymentSchedules.length > 0 && (
                                        <p className={`text-xs mt-3 ${paymentSchedules.length < 2 || finalScheduleCents <= 0 ? "text-red-600" : "text-emerald-700"}`}>
                                            {paymentSchedules.length < 2 ? "Add at least one more payment." : finalScheduleCents <= 0 ? "Earlier payments must total less than the subtotal." : `Final payment remainder: ${formatCurrency(finalScheduleCents / 100)}. Schedule sums to ${formatCurrency(subtotal)}.`}
                                        </p>
                                    )}
                                </div>
                            )}

                            <div className="bg-slate-50 p-10 flex justify-end border-t border-slate-200">
                                <div className="w-80 space-y-4 text-sm">
                                    {pricingType === "FIXED" ? <>
                                    <div className="flex justify-between text-slate-500 font-medium">
                                        <span>Change Order Subtotal</span>
                                        <span className="text-slate-800">{formatCurrency(subtotal)}</span>
                                    </div>
                                    <div className="flex justify-between text-slate-500 font-medium">
                                        <span>{taxLabel}</span>
                                        <span className="text-slate-800">{formatCurrency(tax)}</span>
                                    </div>
                                    <div className="h-px w-full bg-slate-200 my-4 shadow-sm"></div>
                                    <div className="flex justify-between text-xl font-extrabold text-slate-900">
                                        <span>Revised Amount</span>
                                        <span className="text-amber-600">{formatCurrency(total)}</span>
                                    </div>
                                    </> : <div className="rounded-lg border border-amber-200 bg-amber-50 p-5">
                                        <p className="text-xs font-semibold uppercase tracking-wider text-amber-700">Approved terms</p>
                                        <p className="text-xl font-extrabold text-slate-900 mt-2">Cost + {markupPercent || 0}% + tax</p>
                                        <p className="text-xs text-slate-600 mt-2">No fixed revised amount. Scope values are estimates only.</p>
                                    </div>}
                                </div>
                            </div>
                        </div>

                        {pricingType === "COST_PLUS" && (
                            <div className="hui-card mt-6 p-6">
                                <div className="flex items-start justify-between gap-4">
                                    <div>
                                        <h2 className="text-lg font-bold text-slate-900">Actuals</h2>
                                        <p className="text-sm text-slate-500 mt-1">Tagged billable time and expenses. Billed rows remain visible in the frozen history.</p>
                                    </div>
                                    <button onClick={previewActuals} disabled={status !== "Approved" || isBilling || (unbilledTime.length === 0 && unbilledExpenses.length === 0)} className="hui-btn hui-btn-primary disabled:opacity-50">
                                        {isBilling ? "Preparing…" : "Bill actuals…"}
                                    </button>
                                </div>
                                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-5">
                                    <div className="rounded-lg bg-slate-50 p-4"><p className="text-xs text-slate-500">Unbilled hours</p><p className="font-bold mt-1">{actualHours.toFixed(2)}h</p></div>
                                    <div className="rounded-lg bg-slate-50 p-4"><p className="text-xs text-slate-500">Labor + burden</p><p className="font-bold mt-1">{formatCurrency(actualLabor)}</p></div>
                                    <div className="rounded-lg bg-slate-50 p-4"><p className="text-xs text-slate-500">Expenses</p><p className="font-bold mt-1">{formatCurrency(actualExpenses)}</p></div>
                                    <div className="rounded-lg bg-slate-50 p-4"><p className="text-xs text-slate-500">Billing runs</p><p className="font-bold mt-1">{initialData.billings?.length || 0}</p></div>
                                </div>
                                <div className="mt-6 grid gap-5 xl:grid-cols-2">
                                    <div className="overflow-hidden rounded-lg border border-slate-200">
                                        <div className="border-b border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-800">Tagged time</div>
                                        {(initialData.timeEntries?.length || 0) === 0 ? (
                                            <p className="p-4 text-sm text-slate-500">No time entries tagged yet.</p>
                                        ) : (
                                            <div className="divide-y divide-slate-100">
                                                {initialData.timeEntries.map((row: any) => {
                                                    const billed = Boolean(row.invoiceId || row.invoicedAt);
                                                    return <div key={row.id} className="flex items-center justify-between gap-4 p-4 text-sm">
                                                        <div className="min-w-0">
                                                            <p className="truncate font-medium text-slate-800">{row.user?.name || row.user?.email || "Crew member"}</p>
                                                            <p className="text-xs text-slate-500">{new Date(row.startTime).toLocaleDateString()} · {Number(row.durationHours || 0).toFixed(2)}h</p>
                                                        </div>
                                                        <div className="shrink-0 text-right">
                                                            <p className="font-semibold">{formatCurrency(Number(row.laborCost || 0) + Number(row.burdenCost || 0))}</p>
                                                            <span className={`text-xs font-semibold ${billed ? "text-slate-500" : "text-emerald-700"}`}>{billed ? "Billed" : "Unbilled"}</span>
                                                        </div>
                                                    </div>;
                                                })}
                                            </div>
                                        )}
                                    </div>
                                    <div className="overflow-hidden rounded-lg border border-slate-200">
                                        <div className="border-b border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-800">Tagged expenses</div>
                                        {(initialData.expenses?.length || 0) === 0 ? (
                                            <p className="p-4 text-sm text-slate-500">No expenses tagged yet.</p>
                                        ) : (
                                            <div className="divide-y divide-slate-100">
                                                {initialData.expenses.map((row: any) => {
                                                    const billed = Boolean(row.invoiceId || row.invoicedAt);
                                                    return <div key={row.id} className="flex items-center justify-between gap-4 p-4 text-sm">
                                                        <div className="min-w-0">
                                                            <p className="truncate font-medium text-slate-800">{row.vendor || row.description || "Expense"}</p>
                                                            <p className="text-xs text-slate-500">{new Date(row.date || row.createdAt).toLocaleDateString()}</p>
                                                        </div>
                                                        <div className="shrink-0 text-right">
                                                            <p className="font-semibold">{formatCurrency(Number(row.amount || 0))}</p>
                                                            <span className={`text-xs font-semibold ${billed ? "text-slate-500" : "text-emerald-700"}`}>{billed ? "Billed" : "Unbilled"}</span>
                                                        </div>
                                                    </div>;
                                                })}
                                            </div>
                                        )}
                                    </div>
                                </div>
                                {(initialData.billings?.length || 0) > 0 && <div className="mt-6 border-t border-slate-200 pt-4 space-y-2">
                                    <h3 className="text-sm font-semibold text-slate-800">Billing history</h3>
                                    {initialData.billings.map((billing: any) => <div key={billing.id} className="flex items-center justify-between text-sm"><span>{billing.label} · {new Date(billing.createdAt).toLocaleDateString()}</span><span className="font-semibold">{formatCurrency(Number(billing.totalCents) / 100)}</span></div>)}
                                </div>}
                            </div>
                        )}
                    </div>
                )}

                {activeTab === "details" && (
                    <div className="w-full max-w-5xl space-y-6">
                        <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
                            <div className="p-6 border-b border-slate-100">
                                <h3 className="text-lg font-bold text-slate-800">Change Order Description / Memo</h3>
                                <p className="text-sm text-slate-500 mt-1">Provide context for the client on why this Change Order exists.</p>
                            </div>
                            <div className="p-6">
                                <textarea
                                    className="hui-input w-full h-40 resize-y"
                                    placeholder="Enter details around the need for this change order..."
                                    value={description}
                                    disabled={isScopeLocked}
                                    onChange={(e) => setDescription(e.target.value)}
                                    onBlur={isScopeLocked || description === (initialData.description || "") ? undefined : handleSave}
                                />
                            </div>
                        </div>

                        <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
                            <div className="p-6 border-b border-slate-100 flex justify-between items-center">
                                <div>
                                    <h3 className="text-lg font-bold text-slate-800">Signatures & Approvals</h3>
                                    <p className="text-sm text-slate-500 mt-1">E-signature tracking for this Change Order.</p>
                                </div>
                                <span className={`px-2 py-0.5 rounded text-xs border ${
                                    initialData.approvedBy ? "bg-green-100 text-green-800 border-green-200" :
                                    "bg-slate-100 text-slate-600 border-slate-200"
                                }`}>{initialData.approvedBy ? "Signed" : "Pending Signature"}</span>
                            </div>
                            <div className="p-6 grid grid-cols-2 gap-8">
                                <div className="border border-slate-200 rounded-lg p-6 bg-slate-50/50">
                                    <h4 className="font-semibold text-slate-700 mb-4 tracking-wide text-sm uppercase">Client Signature</h4>
                                    {initialData.approvedBy ? (
                                        <div className="space-y-4">
                                            <div className="bg-white p-4 border border-slate-200 rounded flex items-center justify-center min-h-[100px]">
                                                {initialData.clientSignatureUrl ? (
                                                    <img src={initialData.clientSignatureUrl} alt="Signature" className="max-h-16 opacity-80" />
                                                ) : (
                                                    <span className="font-editorial text-2xl italic text-slate-800">{initialData.approvedBy}</span>
                                                )}
                                            </div>
                                            <div className="text-sm text-slate-600">
                                                <p><strong>Approved By:</strong> {initialData.approvedBy}</p>
                                                <p><strong>Approved At:</strong> {new Date(initialData.approvedAt).toLocaleString()}</p>
                                            </div>
                                        </div>
                                    ) : (
                                        <div className="bg-white border border-dashed border-slate-300 rounded p-8 text-center text-slate-400">
                                            <svg className="w-8 h-8 mx-auto mb-2 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                                            <p className="text-sm">Awaiting client signature</p>
                                            {status === "Sent" && (
                                                <p className="text-xs mt-1 text-slate-400">We&apos;ve asked the client to sign this.</p>
                                            )}
                                            {canManuallyApprove && (
                                                showManualApproveConfirm ? (
                                                    <div className="mt-4 pt-4 border-t border-slate-200 text-left">
                                                        <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded p-2">
                                                            Approves without client signature. Billing milestones are created but nothing is emailed to the client.
                                                        </p>
                                                        <div className="flex justify-center gap-2 mt-3">
                                                            <button
                                                                type="button"
                                                                onClick={() => setShowManualApproveConfirm(false)}
                                                                disabled={isManuallyApproving}
                                                                className="hui-btn hui-btn-secondary text-xs px-3 py-1.5 disabled:opacity-50"
                                                            >
                                                                Cancel
                                                            </button>
                                                            <button
                                                                type="button"
                                                                onClick={handleManualApprove}
                                                                disabled={isManuallyApproving}
                                                                className="hui-btn hui-btn-primary text-xs px-3 py-1.5 disabled:opacity-50"
                                                            >
                                                                {isManuallyApproving ? "Approving…" : "Confirm approval"}
                                                            </button>
                                                        </div>
                                                    </div>
                                                ) : (
                                                    <button
                                                        type="button"
                                                        onClick={() => setShowManualApproveConfirm(true)}
                                                        className="text-amber-600 hover:text-amber-700 font-medium text-sm mt-3"
                                                    >
                                                        Mark as Approved (manual)
                                                    </button>
                                                )
                                            )}
                                        </div>
                                    )}
                                </div>

                                <div className="border border-slate-200 rounded-lg p-6 bg-slate-50/50">
                                    <h4 className="font-semibold text-slate-700 mb-4 tracking-wide text-sm uppercase">Company Signature</h4>
                                    {initialData.companySignedBy ? (
                                        <div className="space-y-4">
                                            <div className="bg-white p-4 border border-slate-200 rounded flex items-center justify-center min-h-[100px]">
                                                {initialData.companySignatureUrl ? (
                                                    <img src={initialData.companySignatureUrl} alt="Signature" className="max-h-16 opacity-80" />
                                                ) : (
                                                    <span className="font-editorial text-2xl italic text-slate-800">{initialData.companySignedBy}</span>
                                                )}
                                            </div>
                                            <div className="text-sm text-slate-600">
                                                <p><strong>Signed By:</strong> {initialData.companySignedBy}</p>
                                                {initialData.companySignedAt && (
                                                    <p><strong>Signed At:</strong> {new Date(initialData.companySignedAt).toLocaleString()}</p>
                                                )}
                                            </div>
                                        </div>
                                    ) : (
                                        <div className="bg-white border border-slate-200 rounded p-8 text-center flex flex-col items-center justify-center gap-3">
                                            <div className="w-10 h-10 bg-amber-100 text-amber-600 rounded-full flex items-center justify-center">
                                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>
                                            </div>
                                            <div>
                                                <p className="text-sm text-slate-700 font-medium">Ready to sign?</p>
                                                <p className="text-xs text-slate-500 mt-1">Sign on behalf of the company.</p>
                                            </div>
                                            <button
                                                onClick={() => setShowSignModal(true)}
                                                disabled={!canCountersign}
                                                title={!canCountersign ? "Send the change order before countersigning" : undefined}
                                                className="text-amber-600 hover:text-amber-700 font-medium text-sm mt-1 disabled:text-slate-400 disabled:cursor-not-allowed"
                                            >Sign Now →</button>
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>

        {billingPreview && (
            <div className="fixed inset-0 bg-slate-900/50 flex items-center justify-center z-50 p-4">
                <div className="bg-white rounded-xl shadow-xl max-w-lg w-full border border-hui-border overflow-hidden">
                    <div className="px-6 py-4 border-b border-hui-border">
                        <h2 className="text-lg font-bold text-hui-textMain">Review billable actuals</h2>
                        <p className="text-sm text-slate-500 mt-1">T&M through {billingPreview.throughDate} · {billingPreview.timeZone}</p>
                    </div>
                    <div className="p-6 space-y-3 text-sm">
                        <div className="flex justify-between"><span>Labor + burden ({billingPreview.timeEntries.length} entries)</span><strong>{formatCurrency(billingPreview.laborCents / 100)}</strong></div>
                        <div className="flex justify-between"><span>Expenses ({billingPreview.expenses.length})</span><strong>{formatCurrency(billingPreview.expenseCents / 100)}</strong></div>
                        <div className="flex justify-between"><span>Markup ({billingPreview.markupPercent}%)</span><strong>{formatCurrency(billingPreview.markupCents / 100)}</strong></div>
                        <div className="flex justify-between"><span>{billingPreview.taxLabel}</span><strong>{formatCurrency(billingPreview.taxCents / 100)}</strong></div>
                        <div className="flex justify-between border-t border-slate-200 pt-3 text-base"><strong>Total milestone</strong><strong>{formatCurrency(billingPreview.totalCents / 100)}</strong></div>
                    </div>
                    <div className="px-6 py-4 border-t border-hui-border flex justify-end gap-3">
                        <button className="hui-btn hui-btn-secondary" onClick={() => setBillingPreview(null)}>Cancel</button>
                        <button className="hui-btn hui-btn-primary disabled:opacity-50" disabled={isBilling} onClick={confirmBillActuals}>{isBilling ? "Billing…" : "Confirm & bill"}</button>
                    </div>
                </div>
            </div>
        )}

        {showSignModal && (
            <div className="fixed inset-0 bg-slate-900/50 flex items-center justify-center z-50 p-4">
                <div className="bg-white rounded-xl shadow-xl max-w-sm w-full border border-hui-border overflow-hidden">
                    <div className="px-6 py-4 border-b border-hui-border flex items-center justify-between">
                        <h2 className="text-lg font-bold text-hui-textMain">Sign Change Order</h2>
                        <button onClick={() => setShowSignModal(false)} className="text-hui-textMuted hover:text-hui-textMain">
                            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                        </button>
                    </div>
                    <div className="p-6 space-y-4">
                        <p className="text-sm text-hui-textMuted">Type your full name to sign this change order on behalf of the company.</p>
                        <div>
                            <label className="block text-sm font-medium text-hui-textMain mb-1">Full Name <span className="text-red-500">*</span></label>
                            <input
                                type="text"
                                className="hui-input w-full"
                                placeholder="Your name"
                                value={signName}
                                onChange={e => setSignName(e.target.value)}
                                onKeyDown={e => { if (e.key === "Enter") handleSign(); }}
                                autoFocus
                            />
                        </div>
                    </div>
                    <div className="px-6 py-4 border-t border-hui-border flex justify-end gap-3">
                        <button className="hui-btn hui-btn-secondary" onClick={() => setShowSignModal(false)}>Cancel</button>
                        <button
                            className="hui-btn hui-btn-primary disabled:opacity-50"
                            disabled={!signName.trim() || isSigning}
                            onClick={handleSign}
                        >
                            {isSigning ? "Signing…" : "Sign"}
                        </button>
                    </div>
                </div>
            </div>
        )}
        </>
    );
}
