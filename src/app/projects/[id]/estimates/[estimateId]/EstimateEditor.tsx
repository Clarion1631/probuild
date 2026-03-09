"use client";

import { useState } from "react";
import { saveEstimate, createInvoiceFromEstimate, deleteEstimate } from "@/lib/actions";
import { useRouter } from "next/navigation";
import { DragDropContext, Droppable, Draggable } from "@hello-pangea/dnd";
import ExpensesTab from "./ExpensesTab";
import { toast } from "sonner";

export default function EstimateEditor({ context, initialEstimate }: { context: { type: "project" | "lead", id: string, name: string, clientName: string, clientEmail?: string, location?: string }, initialEstimate: any }) {
    const router = useRouter();
    const [title, setTitle] = useState(initialEstimate.title);
    const [code, setCode] = useState(initialEstimate.code);
    const [status, setStatus] = useState(initialEstimate.status);
    const [items, setItems] = useState<any[]>(initialEstimate.items || []);
    const [paymentSchedules, setPaymentSchedules] = useState<any[]>(initialEstimate.paymentSchedules || []);
    const [isSaving, setIsSaving] = useState(false);
    const [isCreatingInvoice, setIsCreatingInvoice] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);
    const [activeTab, setActiveTab] = useState("builder"); // builder | expenses

    // Filter items to calculate subtotal correctly (don't double count children if parent also has cost, but here we just sum everything that isn't an assembly, or just sum all)
    // To match Houzz, Assemblies sum up their children, but for simplicity we will just let every row have a cost and sum all root level or sum all.
    // Let's sum every item's (qty * cost).
    const subtotal = items.reduce((acc, item) => acc + ((parseFloat(item.quantity) || 0) * (parseFloat(item.unitCost) || 0)), 0);
    const tax = subtotal * 0.087; // Estimate local tax
    const total = subtotal + tax;

    async function handleSave() {
        setIsSaving(true);
        const mappedItems = items.map((item, index) => ({
            ...item,
            order: index,
            total: (parseFloat(item.quantity) || 0) * (parseFloat(item.unitCost) || 0)
        }));
        const mappedSchedules = paymentSchedules.map((schedule, index) => ({
            ...schedule,
            order: index
        }));

        await saveEstimate(initialEstimate.id, context.id, context.type, {
            title, code, status, totalAmount: total, paymentSchedules: mappedSchedules
        }, mappedItems);
        setIsSaving(false);
        toast.success("Estimate saved successfully");
        router.refresh();
    }

    async function handleCreateInvoice() {
        setIsCreatingInvoice(true);
        try {
            await handleSave();
            const res = await createInvoiceFromEstimate(initialEstimate.id);
            if (res.id) {
                toast.success("Invoice drafted from this estimate.");
                router.push(`/projects/${context.id}/invoices/${res.id}`);
            }
        } catch (e: any) {
            toast.error(e.message || "Failed to create invoice.");
        } finally {
            setIsCreatingInvoice(false);
        }
    }

    async function handleDelete() {
        if (!confirm("Are you sure you want to delete this estimate? This action cannot be undone.")) return;
        setIsDeleting(true);
        try {
            await deleteEstimate(initialEstimate.id);
            toast.success("Estimate deleted");
            if (context.type === "project") {
                router.push(`/projects/${context.id}/estimates`);
            } else {
                router.push(`/leads/${context.id}`);
            }
        } catch (error) {
            toast.error("Failed to delete estimate");
        } finally {
            setIsDeleting(false);
        }
    }

    function generateId() {
        return Math.random().toString(36).substr(2, 9);
    }

    function addItem(parentId: string | null = null) {
        setItems([...items, {
            id: generateId(),
            name: "",
            description: "",
            type: "Material",
            quantity: 1,
            unitCost: 0,
            total: 0,
            parentId
        }]);
    }

    function updateItem(index: number, field: string, value: any) {
        const newItems = [...items];
        newItems[index][field] = value;
        setItems(newItems);
    }

    function removeItem(index: number) {
        const itemToRemove = items[index];
        // Also remove children if it's a parent
        setItems(items.filter((item, i) => i !== index && item.parentId !== itemToRemove.id));
    }

    function addPaymentSchedule() {
        setPaymentSchedules([...paymentSchedules, {
            id: generateId(),
            name: "Progress Payment",
            percentage: "",
            amount: 0,
            dueDate: ""
        }]);
    }

    function updatePaymentSchedule(index: number, field: string, value: any) {
        const newSchedules = [...paymentSchedules];
        if (field === "percentage") {
            const pct = parseFloat(value) || 0;
            newSchedules[index].percentage = value;
            newSchedules[index].amount = (total * (pct / 100)).toFixed(2);
        } else {
            newSchedules[index][field] = value;
        }
        setPaymentSchedules(newSchedules);
    }

    function removePaymentSchedule(index: number) {
        const newSchedules = [...paymentSchedules];
        newSchedules.splice(index, 1);
        setPaymentSchedules(newSchedules);
    }

    function onDragEnd(result: any) {
        if (!result.destination) return;
        const newItems = Array.from(items);
        const [reorderedItem] = newItems.splice(result.source.index, 1);
        newItems.splice(result.destination.index, 0, reorderedItem);
        setItems(newItems);
    }

    return (
        <div
            className="flex flex-col h-full bg-slate-50"
            onBlur={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                    // Only auto-save if we actually have changes? For now, just save on blur outside.
                    handleSave();
                }
            }}
        >
            {/* Top Navigation / Action Bar */}
            <div className="bg-white border-b border-hui-border px-6 py-4 flex items-center justify-between shadow-sm z-10 sticky top-0">
                <div className="flex items-center gap-4">
                    <button onClick={() => {
                        if (context.type === "project") {
                            router.push(`/projects/${context.id}/estimates`);
                        } else {
                            router.push(`/leads/${context.id}`);
                        }
                    }} className="text-hui-textMuted hover:text-hui-textMain transition text-sm flex items-center gap-1">
                        ← Back to {context.type === "project" ? "Estimates" : "Lead"}
                    </button>
                    <div className="h-4 w-px bg-hui-border"></div>
                    <span className="text-sm font-medium text-hui-textMain">{code}</span>
                    <span className="px-2 py-0.5 rounded text-xs bg-slate-100 text-hui-textMuted border border-hui-border">{status}</span>
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
                        onClick={() => setActiveTab("expenses")}
                        className={`px-4 py-1.5 text-sm font-medium rounded-md transition ${activeTab === "expenses" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}
                    >
                        Costing & Expenses
                    </button>
                </div>

                <div className="flex items-center gap-3">
                    <button
                        onClick={handleDelete}
                        disabled={isDeleting}
                        className="hui-btn hui-btn-secondary text-red-600 border-red-200 hover:bg-red-50 mr-2 disabled:opacity-50"
                    >
                        {isDeleting ? "Deleting..." : "Delete"}
                    </button>
                    <button
                        onClick={() => window.open(`/portal/estimates/${initialEstimate.id}`, '_blank')}
                        className="hui-btn hui-btn-secondary"
                    >
                        Customer Portal
                    </button>
                    <a
                        href={`/api/pdf/${initialEstimate.id}`}
                        target="_blank"
                        className="hui-btn hui-btn-secondary inline-flex items-center justify-center"
                    >
                        Download PDF
                    </a>
                    {context.type === "project" && (
                        <button
                            onClick={handleCreateInvoice}
                            disabled={isCreatingInvoice}
                            className="hui-btn hui-btn-secondary disabled:opacity-50"
                        >
                            {isCreatingInvoice ? "Creating..." : "Create Invoice"}
                        </button>
                    )}
                    <button
                        onClick={handleSave}
                        disabled={isSaving}
                        className="hui-btn hui-btn-primary disabled:opacity-50"
                    >
                        {isSaving ? "Saving..." : "Save Draft"}
                    </button>
                </div>
            </div>

            <div className="flex-1 p-8 flex justify-center pb-24">
                {activeTab === "builder" && (
                    <div className="w-full max-w-5xl">
                        {/* Document Header */}
                        <div className="bg-white p-8 rounded-t-lg shadow-sm border border-hui-border border-b-0 space-y-6">
                            <input
                                type="text"
                                value={title}
                                onChange={e => setTitle(e.target.value)}
                                className="text-3xl font-bold text-hui-textMain w-full focus:outline-none focus:border-b border-hui-border pb-1 placeholder:text-slate-300 bg-transparent"
                                placeholder="Estimate Title"
                            />

                            <div className="flex gap-12 text-sm">
                                <div>
                                    <p className="text-hui-textMuted mb-1">To</p>
                                    <p className="font-medium text-hui-textMain">{context.clientName}</p>
                                    <p className="text-hui-textMuted">{context.clientEmail || "No email provided"}</p>
                                    <p className="text-hui-textMuted">{context.location}</p>
                                </div>
                                <div>
                                    <p className="text-hui-textMuted mb-1">Estimate Details</p>
                                    <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                                        <label className="text-hui-textMuted">Code</label>
                                        <input type="text" value={code} onChange={e => setCode(e.target.value)} className="border-b border-dashed border-slate-300 focus:outline-none focus:border-solid focus:border-slate-400 max-w-24 text-right bg-transparent" />
                                        <label className="text-hui-textMuted">Date</label>
                                        <span className="text-right text-hui-textMain">{new Date().toLocaleDateString()}</span>
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* Items Grid with DnD */}
                        <div className="bg-white shadow-sm border border-hui-border">
                            <div className="flex text-xs font-medium text-hui-textMuted bg-slate-50 border-b border-hui-border px-6 py-3 uppercase tracking-wider">
                                <div className="w-8"></div>
                                <div className="flex-1">Item Description</div>
                                <div className="w-32">Type</div>
                                <div className="w-24 text-right">Qty</div>
                                <div className="w-32 text-right">Unit Cost</div>
                                <div className="w-32 text-right">Total</div>
                                <div className="w-10"></div>
                            </div>

                            <DragDropContext onDragEnd={onDragEnd}>
                                <Droppable droppableId="items-list">
                                    {(provided) => (
                                        <div {...provided.droppableProps} ref={provided.innerRef} className="divide-y divide-slate-100">
                                            {items.map((item, index) => {
                                                const itemTotal = (parseFloat(item.quantity) || 0) * (parseFloat(item.unitCost) || 0);
                                                const isSubItem = !!item.parentId;
                                                return (
                                                    <Draggable key={item.id} draggableId={item.id} index={index}>
                                                        {(provided, snapshot) => (
                                                            <div
                                                                ref={provided.innerRef}
                                                                {...provided.draggableProps}
                                                                className={`flex items-center px-6 py-3 bg-white group hover:bg-slate-50 transition border-l-2 ${snapshot.isDragging ? "shadow-lg border-hui-primary z-50 ring-1 ring-hui-primary/20" : isSubItem ? "border-transparent ml-8 bg-slate-50/30" : "border-transparent"}`}
                                                            >
                                                                <div {...provided.dragHandleProps} className="w-8 flex items-center justify-center text-slate-300 hover:text-hui-textMuted cursor-grab opacity-0 group-hover:opacity-100">
                                                                    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M4 5a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm0 6a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm5-6a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm0 6a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm5-6a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm0 6a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z" /></svg>
                                                                </div>
                                                                <div className="flex-1 flex flex-col">
                                                                    <input
                                                                        type="text"
                                                                        value={item.name}
                                                                        onChange={e => updateItem(index, "name", e.target.value)}
                                                                        placeholder="Item name / description"
                                                                        className={`w-full bg-transparent focus:outline-none focus:bg-white focus:ring-1 ring-hui-border rounded px-2 py-1 -ml-2 transition text-sm ${isSubItem ? 'text-hui-textMuted' : 'font-medium text-hui-textMain'}`}
                                                                    />
                                                                    {!isSubItem && (
                                                                        <button onClick={() => addItem(item.id)} className="text-[10px] text-hui-primary hover:text-hui-primaryHover font-medium text-left w-fit mt-1 opacity-0 group-hover:opacity-100 transition">
                                                                            + Add Sub-item
                                                                        </button>
                                                                    )}
                                                                </div>
                                                                <div className="w-32 px-4">
                                                                    <select
                                                                        value={item.type}
                                                                        onChange={e => updateItem(index, "type", e.target.value)}
                                                                        className="bg-transparent focus:outline-none text-hui-textMuted w-full text-sm"
                                                                    >
                                                                        <option>Material</option>
                                                                        <option>Labor</option>
                                                                        <option>Subcontractor</option>
                                                                        <option>Assembly</option>
                                                                    </select>
                                                                </div>
                                                                <div className="w-24 px-4 text-right">
                                                                    <input
                                                                        type="number"
                                                                        value={item.quantity}
                                                                        onChange={e => updateItem(index, "quantity", e.target.value)}
                                                                        className="w-full bg-transparent focus:outline-none focus:bg-white focus:ring-1 ring-hui-border rounded px-2 py-1 text-right transition text-sm text-hui-textMain"
                                                                    />
                                                                </div>
                                                                <div className="w-32 px-4 text-right">
                                                                    <input
                                                                        type="number"
                                                                        value={item.unitCost}
                                                                        onChange={e => updateItem(index, "unitCost", e.target.value)}
                                                                        className="w-full bg-transparent focus:outline-none focus:bg-white focus:ring-1 ring-hui-border rounded px-2 py-1 text-right transition text-sm text-hui-textMain"
                                                                    />
                                                                </div>
                                                                <div className="w-32 px-4 text-right font-medium text-hui-textMain text-sm">
                                                                    ${itemTotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                                                </div>
                                                                <div className="w-10 flex justify-end">
                                                                    <button onClick={() => removeItem(index)} className="text-slate-300 hover:text-red-500 transition opacity-0 group-hover:opacity-100 p-1">
                                                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
                                                                    </button>
                                                                </div>
                                                            </div>
                                                        )}
                                                    </Draggable>
                                                );
                                            })}
                                            {provided.placeholder}
                                        </div>
                                    )}
                                </Droppable>
                            </DragDropContext>

                            <div className="p-4 border-t border-hui-border bg-slate-50/50 flex items-center gap-4">
                                <button onClick={() => addItem(null)} className="text-sm font-medium text-hui-textMain hover:text-hui-primary flex items-center gap-1 transition">
                                    + Add Item
                                </button>
                            </div>
                        </div>

                        {/* Progress Payments Section */}
                        {paymentSchedules.length > 0 && (
                            <div className="bg-white shadow-sm border border-hui-border mt-6">
                                <div className="flex items-center justify-between bg-slate-50 border-b border-hui-border px-6 py-4">
                                    <h3 className="font-semibold text-hui-textMain">Payment Schedule</h3>
                                </div>
                                <div className="flex text-xs font-medium text-hui-textMuted bg-white border-b border-hui-border px-6 py-3 uppercase tracking-wider">
                                    <div className="flex-1">Payment Name</div>
                                    <div className="w-32">Percentage</div>
                                    <div className="w-32">Amount</div>
                                    <div className="w-40 text-right">Due Date</div>
                                    <div className="w-10"></div>
                                </div>
                                <div className="divide-y divide-slate-100">
                                    {paymentSchedules.map((schedule, index) => (
                                        <div key={schedule.id || index} className="flex items-center px-6 py-3 bg-white group hover:bg-slate-50 transition border-l-2 border-transparent">
                                            <div className="flex-1">
                                                <input
                                                    type="text"
                                                    value={schedule.name}
                                                    onChange={e => updatePaymentSchedule(index, "name", e.target.value)}
                                                    placeholder="e.g. Initial Deposit"
                                                    className="w-full bg-transparent focus:outline-none focus:bg-white focus:ring-1 ring-hui-border rounded px-2 py-1 -ml-2 transition text-sm font-medium text-hui-textMain"
                                                />
                                            </div>
                                            <div className="w-32 px-4">
                                                <input
                                                    type="number"
                                                    value={schedule.percentage}
                                                    onChange={e => updatePaymentSchedule(index, "percentage", e.target.value)}
                                                    placeholder="%"
                                                    className="w-full bg-transparent focus:outline-none focus:bg-white focus:ring-1 ring-hui-border rounded px-2 py-1 transition text-sm text-hui-textMuted"
                                                />
                                            </div>
                                            <div className="w-32 px-4">
                                                <div className="flex items-center">
                                                    <span className="text-hui-textMuted mr-1">$</span>
                                                    <input
                                                        type="number"
                                                        value={schedule.amount}
                                                        onChange={e => updatePaymentSchedule(index, "amount", e.target.value)}
                                                        className="w-full bg-transparent focus:outline-none focus:bg-white focus:ring-1 ring-hui-border rounded px-2 py-1 transition text-sm text-hui-textMain"
                                                    />
                                                </div>
                                            </div>
                                            <div className="w-40 px-4 text-right">
                                                <input
                                                    type="date"
                                                    value={schedule.dueDate ? new Date(schedule.dueDate).toISOString().split('T')[0] : ''}
                                                    onChange={e => updatePaymentSchedule(index, "dueDate", new Date(e.target.value).toISOString())}
                                                    className="w-full bg-transparent focus:outline-none focus:bg-white focus:ring-1 ring-hui-border rounded px-2 py-1 text-right transition text-sm text-hui-textMuted"
                                                />
                                            </div>
                                            <div className="w-10 flex justify-end">
                                                <button onClick={() => removePaymentSchedule(index)} className="text-slate-300 hover:text-red-500 transition opacity-0 group-hover:opacity-100 p-1">
                                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
                                                </button>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* Footer Totals */}
                        <div className="bg-white p-8 rounded-b-lg shadow-sm border border-hui-border border-t-0 flex justify-end">
                            <div className="w-80 space-y-3 text-sm">
                                <div className="flex justify-between text-hui-textMuted">
                                    <span>Subtotal</span>
                                    <span>${subtotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                                </div>
                                <div className="flex justify-between text-hui-textMuted">
                                    <span>Estimated Tax (8.7%)</span>
                                    <span>${tax.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                                </div>
                                <div className="h-px w-full bg-hui-border my-2"></div>
                                <div className="flex justify-between text-lg font-bold text-hui-textMain">
                                    <span>Estimate Total</span>
                                    <span>${total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                                </div>
                            </div>
                        </div>

                        <div className="mt-8">
                            <div>
                                <button onClick={addPaymentSchedule} className="text-sm font-medium text-hui-primary hover:text-hui-primaryHover transition">
                                    + Add Payment Schedule
                                </button>
                                {paymentSchedules.length === 0 && (
                                    <p className="text-xs text-hui-textMuted mt-1">Break this estimate into multiple progress payments (e.g., Deposit, Milestone, Completion)</p>
                                )}
                            </div>
                        </div>
                    </div>
                )}
                {activeTab === "expenses" && (
                    <div className="w-full max-w-5xl bg-white border border-hui-border rounded-lg shadow-sm">
                        <ExpensesTab estimateId={initialEstimate.id} projectId={context.type === "project" ? context.id : ""} items={items} />
                    </div>
                )}
            </div>
        </div>
    );
}
