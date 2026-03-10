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
                    }} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-hui-textMain bg-white border border-hui-border rounded-md hover:bg-slate-50 transition shadow-sm">
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

            <div className="flex-1 p-8 flex justify-center pb-24 overflow-y-auto">
                {activeTab === "builder" && (
                    <div className="w-full max-w-5xl">
                        {/* Premium Document Wrapper */}
                        <div className="bg-white rounded-xl shadow-[0_8px_30px_rgb(0,0,0,0.04)] border border-slate-200 overflow-hidden relative">
                            {/* Subtle Gradient Accent Top Line */}
                            <div className="h-1.5 w-full bg-gradient-to-r from-blue-500 via-indigo-500 to-purple-500"></div>
                            {/* Document Header */}
                            <div className="p-10 pb-12 space-y-10 border-b border-slate-100">
                                <input
                                    type="text"
                                    value={title}
                                    onChange={e => setTitle(e.target.value)}
                                    className="text-4xl font-extrabold tracking-tight text-slate-800 w-full focus:outline-none focus:bg-slate-50 hover:bg-slate-50 transition-colors rounded-lg px-3 py-2 -ml-3 placeholder:text-slate-300 bg-transparent"
                                    placeholder="Estimate Title"
                                />

                                <div className="flex justify-between items-start gap-12 text-sm px-3">
                                    <div className="space-y-1">
                                        <p className="text-[11px] font-semibold tracking-widest uppercase text-slate-400 mb-2">Estimate To</p>
                                        <p className="font-semibold text-base text-slate-800">{context.clientName}</p>
                                        {context.clientEmail && <p className="text-slate-500">{context.clientEmail}</p>}
                                        {context.location && <p className="text-slate-500 pt-1">{context.location}</p>}
                                    </div>
                                    <div className="bg-slate-50 p-5 rounded-lg border border-slate-100 min-w-[280px]">
                                        <div className="grid grid-cols-2 gap-x-4 gap-y-4">
                                            <label className="text-slate-500 font-medium">Estimate No.</label>
                                            <input type="text" value={code} onChange={e => setCode(e.target.value)} className="font-semibold text-slate-800 focus:outline-none focus:bg-white focus:ring-1 ring-slate-200 rounded px-2 py-1 -mr-2 text-right bg-transparent transition" />
                                            
                                            <label className="text-slate-500 font-medium">Date Issued</label>
                                            <span className="text-right font-medium text-slate-800 px-2 py-1">{new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}</span>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            {/* Items Grid with DnD */}
                            <div className="bg-white">
                                <div className="flex text-[11px] font-bold text-slate-400 bg-slate-50/80 border-b border-slate-100 px-8 py-4 uppercase tracking-wider">
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
                                                                    <div className="w-24 px-4 pt-1 text-right">
                                                                        <input
                                                                            type="number"
                                                                            value={item.quantity}
                                                                            onChange={e => updateItem(index, "quantity", e.target.value)}
                                                                            className="w-full bg-transparent focus:outline-none focus:bg-white focus:ring-1 ring-slate-200 rounded px-2 py-1 text-right hover:bg-slate-50 transition text-sm font-medium text-slate-700"
                                                                        />
                                                                    </div>
                                                                    <div className="w-32 px-4 pt-1 text-right relative">
                                                                        <span className="absolute left-6 top-1.5 text-slate-400 text-sm">$</span>
                                                                        <input
                                                                            type="number"
                                                                            value={item.unitCost}
                                                                            onChange={e => updateItem(index, "unitCost", e.target.value)}
                                                                            className="w-full bg-transparent focus:outline-none focus:bg-white focus:ring-1 ring-slate-200 rounded px-2 py-1 pl-6 text-right hover:bg-slate-50 transition text-sm font-medium text-slate-700"
                                                                        />
                                                                    </div>
                                                                    <div className="w-32 px-4 pt-2 text-right font-semibold text-slate-800 text-sm">
                                                                        ${itemTotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                                                    </div>
                                                                    <div className="w-10 pt-1.5 flex justify-end">
                                                                    <button onClick={() => removeItem(index)} className="text-slate-300 hover:text-red-500 hover:bg-red-50 rounded p-1.5 transition opacity-0 group-hover:opacity-100">
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

                            <div className="p-4 px-8 border-t border-slate-100 bg-white hover:bg-slate-50 transition-colors flex items-center gap-4 cursor-pointer group" onClick={() => addItem(null)}>
                                <button className="text-sm font-semibold text-indigo-500 group-hover:text-indigo-600 flex items-center gap-2 transition">
                                    <span className="bg-indigo-50 text-indigo-500 group-hover:bg-indigo-100 rounded p-1">
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14"/></svg>
                                    </span>
                                    Add New Item
                                </button>
                            </div>
                        </div>

                        {/* Progress Payments Section */}
                        {paymentSchedules.length > 0 && (
                            <div className="bg-white border-t border-slate-200 mt-8">
                                <div className="flex items-center justify-between bg-slate-50/50 border-b border-slate-100 px-8 py-5">
                                    <h3 className="font-bold text-slate-800 tracking-tight">Payment Schedule</h3>
                                </div>
                                <div className="flex text-[11px] font-bold text-slate-400 bg-white border-b border-slate-100 px-8 py-3 uppercase tracking-wider">
                                    <div className="flex-1">Payment Name</div>
                                    <div className="w-32">Percentage</div>
                                    <div className="w-32">Amount</div>
                                    <div className="w-40 text-right">Due Date</div>
                                    <div className="w-10"></div>
                                </div>
                                <div className="divide-y divide-slate-50">
                                    {paymentSchedules.map((schedule, index) => (
                                        <div key={schedule.id || index} className="flex items-center px-8 py-4 bg-white group hover:bg-slate-50/50 transition-colors border-l-4 border-transparent">
                                            <div className="flex-1">
                                                <input
                                                    type="text"
                                                    value={schedule.name}
                                                    onChange={e => updatePaymentSchedule(index, "name", e.target.value)}
                                                    placeholder="e.g. Initial Deposit"
                                                    className="w-full bg-transparent focus:outline-none focus:bg-white focus:ring-1 ring-slate-200 rounded px-3 py-1.5 -ml-3 transition-all text-sm font-semibold text-slate-800"
                                                />
                                            </div>
                                            <div className="w-32 px-4 relative">
                                                <input
                                                    type="number"
                                                    value={schedule.percentage}
                                                    onChange={e => updatePaymentSchedule(index, "percentage", e.target.value)}
                                                    placeholder="%"
                                                    className="w-full bg-transparent focus:outline-none focus:bg-white focus:ring-1 ring-slate-200 rounded px-3 py-1.5 pr-6 transition-all text-sm font-medium text-slate-600"
                                                />
                                                <span className="absolute right-7 top-2 text-slate-400 text-xs">%</span>
                                            </div>
                                            <div className="w-32 px-4 relative">
                                                <span className="absolute left-6 top-1.5 text-slate-400 text-sm">$</span>
                                                <input
                                                    type="number"
                                                    value={schedule.amount}
                                                    onChange={e => updatePaymentSchedule(index, "amount", e.target.value)}
                                                    className="w-full bg-transparent focus:outline-none focus:bg-white focus:ring-1 ring-slate-200 rounded px-3 py-1.5 pl-5 transition-all text-sm font-medium text-slate-800"
                                                />
                                            </div>
                                            <div className="w-40 px-4 text-right">
                                                <input
                                                    type="date"
                                                    value={schedule.dueDate ? new Date(schedule.dueDate).toISOString().split('T')[0] : ''}
                                                    onChange={e => updatePaymentSchedule(index, "dueDate", new Date(e.target.value).toISOString())}
                                                    className="w-full bg-transparent focus:outline-none focus:bg-white focus:ring-1 ring-slate-200 rounded px-2 py-1.5 text-right transition-all text-sm font-medium text-slate-500"
                                                />
                                            </div>
                                            <div className="w-10 pt-0.5 flex justify-end">
                                                <button onClick={() => removePaymentSchedule(index)} className="text-slate-300 hover:text-red-500 hover:bg-red-50 rounded p-1.5 transition opacity-0 group-hover:opacity-100">
                                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
                                                </button>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* Footer Totals */}
                            <div className="bg-slate-50 p-10 flex justify-end border-t border-slate-200">
                                <div className="w-80 space-y-4 text-sm">
                                    <div className="flex justify-between text-slate-500 font-medium">
                                        <span>Subtotal</span>
                                        <span className="text-slate-800">${subtotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                                    </div>
                                    <div className="flex justify-between text-slate-500 font-medium">
                                        <span>Estimated Tax (8.7%)</span>
                                        <span className="text-slate-800">${tax.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                                    </div>
                                    <div className="h-px w-full bg-slate-200 my-4 shadow-sm"></div>
                                    <div className="flex justify-between text-xl font-extrabold text-slate-900">
                                        <span>Total</span>
                                        <span className="text-indigo-600">${total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div className="mt-8 flex items-start gap-4 mx-2">
                            <div className="bg-indigo-50 p-3 rounded-lg flex-1 border border-indigo-100 flex items-center justify-between">
                                <div>
                                    <h4 className="font-semibold text-indigo-900 text-sm">Payment Schedule</h4>
                                    <p className="text-xs text-indigo-700/70 mt-0.5">Allow your clients to pay in milestones (e.g., Deposit, Completion).</p>
                                </div>
                                <button onClick={addPaymentSchedule} className="hui-btn hui-btn-secondary text-indigo-700 border-indigo-200 hover:bg-indigo-100 bg-white transition shadow-sm text-xs py-1.5 px-3">
                                    + Add milestone
                                </button>
                            </div>
                        </div>
                    </div>
                )}
                {activeTab === "expenses" && (
                    <div className="w-full max-w-5xl bg-white rounded-xl shadow-[0_8px_30px_rgb(0,0,0,0.04)] border border-slate-200 overflow-hidden relative">
                        <div className="h-1.5 w-full bg-gradient-to-r from-emerald-500 via-teal-500 to-cyan-500"></div>
                        <ExpensesTab estimateId={initialEstimate.id} projectId={context.type === "project" ? context.id : ""} items={items} />
                    </div>
                )}
            </div>
        </div>
    );
}
