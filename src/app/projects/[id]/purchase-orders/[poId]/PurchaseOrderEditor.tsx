"use client";

import { useState, useRef, useCallback } from "react";
import { createPurchaseOrder, updatePurchaseOrder, deletePurchaseOrder, sendPurchaseOrder, approvePurchaseOrder, uploadPurchaseOrderFile, deletePurchaseOrderFile, createVendor, uploadPurchaseOrderFileFromBuffer } from "@/lib/actions";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import StatusBadge from "@/components/StatusBadge";
import Link from "next/link";
import { Trash2, Plus, Upload, FileText, CheckCircle2, Sparkles, X, Loader2 } from "lucide-react";
import POMessageThread from "./POMessageThread";

interface Context {
    projectId: string;
    projectName: string;
    vendors: any[];
    costCodes: any[];
}

export default function PurchaseOrderEditor({ context, initialData }: { context: Context, initialData?: any }) {
    const router = useRouter();
    const isEditing = !!initialData;
    
    const [status, setStatus] = useState(initialData?.status || "Draft");
    const [vendorId, setVendorId] = useState(initialData?.vendorId || (context.vendors[0]?.id || ""));
    const [notes, setNotes] = useState(initialData?.notes || "");
    const [terms, setTerms] = useState(initialData?.terms || "");
    const [memos, setMemos] = useState(initialData?.memos || "");
    
    // Line items
    const [items, setItems] = useState<any[]>(
        initialData?.items?.length > 0 
            ? initialData.items 
            : [{ id: "temp-1", description: "", quantity: 1, unitCost: 0, total: 0, costCodeId: null, order: 0 }]
    );

    const [isSaving, setIsSaving] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);
    const [isSending, setIsSending] = useState(false);
    const [isApproving, setIsApproving] = useState(false);
    const [isUploading, setIsUploading] = useState(false);

    // PDF extract state (new PO only)
    const [isDraggingOver, setIsDraggingOver] = useState(false);
    const [isExtracting, setIsExtracting] = useState(false);
    const [pendingFile, setPendingFile] = useState<File | null>(null);
    const [extractedVendorInfo, setExtractedVendorInfo] = useState<{
        name: string; email: string | null; phone: string | null; address: string | null;
    } | null>(null);
    const [pendingNewVendor, setPendingNewVendor] = useState<{
        name: string; email: string | null; phone: string | null; address: string | null;
    } | null>(null); // set when vendor didn't exist — will be created on save
    const fileInputRef = useRef<HTMLInputElement>(null);
    const isSavingRef = useRef(false); // sync guard against double-tap Save

    // Dynamic calculations
    const totalAmount = items.reduce((acc, curr) => acc + (Number(curr.total) || 0), 0);

    const handleItemChange = (index: number, field: string, value: any) => {
        const newItems = [...items];
        newItems[index][field] = value;
        
        if (field === "quantity" || field === "unitCost") {
            const qty = Number(newItems[index].quantity) || 0;
            const cost = Number(newItems[index].unitCost) || 0;
            newItems[index].total = qty * cost;
        }
        setItems(newItems);
    };

    const addItem = () => {
        setItems([
            ...items, 
            { id: `temp-${Math.random()}`, description: "", quantity: 1, unitCost: 0, total: 0, costCodeId: null, order: items.length }
        ]);
    };

    const removeItem = (index: number) => {
        const newItems = items.filter((_, i) => i !== index);
        setItems(newItems);
    };

    const processPdfFile = useCallback(async (file: File) => {
        if (!file.type.includes("pdf") && !file.name.toLowerCase().endsWith(".pdf")) {
            return toast.error("Please upload a PDF file");
        }
        if (file.size > 5 * 1024 * 1024) {
            return toast.error("File too large — max 5MB");
        }

        setIsExtracting(true);
        setPendingFile(file);
        toast.loading("Reading PDF with AI...", { id: "pdf-extract" });

        try {
            const arrayBuf = await file.arrayBuffer();
            // Chunk-loop avoids call-stack overflow on files > ~64KB
            const uint8 = new Uint8Array(arrayBuf);
            let binary = "";
            for (let i = 0; i < uint8.length; i += 8192) {
                binary += String.fromCharCode(...uint8.subarray(i, i + 8192));
            }
            const base64 = btoa(binary);

            const res = await fetch("/api/purchase-orders/extract-pdf", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ base64, filename: file.name, fileSize: file.size }),
            });

            const data = await res.json();
            if (!res.ok) {
                toast.error(data.error || "Extraction failed", { id: "pdf-extract" });
                setPendingFile(null);
                return;
            }

            toast.dismiss("pdf-extract");

            // Populate line items
            if (data.lineItems?.length > 0) {
                setItems(data.lineItems.map((item: any, i: number) => ({
                    id: `temp-${Math.random()}`,
                    description: item.description || "",
                    quantity: Number(item.quantity) || 1,
                    unitCost: Number(item.unitCost) || 0,
                    total: Number(item.total) || (Number(item.quantity) * Number(item.unitCost)) || 0,
                    costCodeId: null,
                    order: i,
                })));
            }

            // Populate notes/terms
            if (data.notes) setNotes(data.notes);
            if (data.terms) setTerms(data.terms);

            // Vendor matching
            if (data.vendorMatch?.matched && data.vendorMatch.vendorId) {
                setVendorId(data.vendorMatch.vendorId);
                setExtractedVendorInfo(data.vendor);
                setPendingNewVendor(null);
                toast.success(`Vendor matched: ${data.vendorMatch.vendorName}`);
            } else if (data.vendor?.name) {
                setExtractedVendorInfo(data.vendor);
                setPendingNewVendor(data.vendor);
                toast.success(`AI extracted ${data.lineItems?.length || 0} items — new vendor "${data.vendor.name}" will be created on save`);
            } else {
                toast.success(`AI extracted ${data.lineItems?.length || 0} line items`);
            }
        } catch (err: any) {
            toast.error("Failed to extract PDF — fill form manually", { id: "pdf-extract" });
            setPendingFile(null);
        } finally {
            setIsExtracting(false);
        }
    }, []);

    const handleDragOver = (e: React.DragEvent) => { e.preventDefault(); setIsDraggingOver(true); };
    const handleDragLeave = () => setIsDraggingOver(false);
    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault();
        setIsDraggingOver(false);
        const file = e.dataTransfer.files[0];
        if (file) processPdfFile(file);
    };
    const handleDropZoneClick = () => fileInputRef.current?.click();
    const handleDropZoneFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) processPdfFile(file);
        e.target.value = "";
    };

    const handleSave = async () => {
        if (isSavingRef.current) return; // guard against double-tap
        if (!vendorId && !pendingNewVendor) return toast.error("Please select a vendor");
        if (items.length === 0) return toast.error("Please add at least one line item");
        const hasEmptyNames = items.some(i => !i.description.trim());
        if (hasEmptyNames) return toast.error("All items must have a description");

        isSavingRef.current = true;
        setIsSaving(true);
        const submitData = {
            vendorId,
            status,
            notes,
            terms,
            memos,
            totalAmount,
            items: items.map((i, index) => ({
                id: i.id.startsWith('temp-') ? undefined : i.id, // Prisma handles temp creations differently usually, but we deleteMany up top
                description: i.description,
                quantity: Number(i.quantity) || 0,
                unitCost: Number(i.unitCost) || 0,
                total: Number(i.total) || 0,
                costCodeId: i.costCodeId || null,
                order: index
            }))
        };

        try {
            let res;
            if (isEditing) {
                res = await updatePurchaseOrder(initialData.id, submitData);
                toast.success("Purchase Order updated");
            } else {
                // If vendor wasn't matched, create it now
                let finalVendorId = vendorId;
                if (pendingNewVendor && !vendorId) {
                    const newVendor = await createVendor({
                        name: pendingNewVendor.name,
                        email: pendingNewVendor.email || undefined,
                        phone: pendingNewVendor.phone || undefined,
                        address: pendingNewVendor.address || undefined,
                    });
                    finalVendorId = newVendor.id;
                }

                res = await createPurchaseOrder(context.projectId, { ...submitData, vendorId: finalVendorId });

                // Upload the PDF if user dropped one
                if (pendingFile && res?.id) {
                    try {
                        const fd = new FormData();
                        fd.append("file", pendingFile);
                        await uploadPurchaseOrderFileFromBuffer(res.id, context.projectId, fd);
                    } catch {
                        // non-fatal — PO was created successfully
                        toast.error("PO created but PDF attachment failed — re-upload manually");
                    }
                }

                toast.success("Purchase Order created");
                router.replace(`/projects/${context.projectId}/purchase-orders/${res.id}`);
            }
        } catch (error: any) {
            toast.error(error.message || "Failed to save PO");
        } finally {
            isSavingRef.current = false;
            setIsSaving(false);
            setPendingNewVendor(null); // clear stale state after save attempt
        }
    };

    const handleDelete = async (e: React.MouseEvent) => {
        e.preventDefault();
        if (!isEditing || !window.confirm("Delete this Purchase Order permanently?")) return;
        setIsDeleting(true);
        try {
            await deletePurchaseOrder(initialData.id);
            toast.success("Purchase Order deleted");
            router.push(`/projects/${context.projectId}/purchase-orders`);
        } catch (error: any) {
            toast.error("Failed to delete");
            setIsDeleting(false);
        }
    };

    const handleSend = async () => {
        if (!isEditing) return toast.error("Please save the PO first");
        
        const vendor = context.vendors.find(v => v.id === vendorId);
        if (!vendor?.email) {
            const email = window.prompt("Vendor does not have an email saved. Enter email to send to:");
            if (!email) return;
            // Proceed to send with prompt email
            setIsSending(true);
            try {
                await sendPurchaseOrder(initialData.id, email, `Here is the purchase order for ${context.projectName}.`);
                toast.success("PO Sent to " + email);
                setStatus("Sent");
                router.refresh();
            } catch(e: any) {
                toast.error(e.message || "Failed to send");
            } finally { setIsSending(false); }
            return;
        }

        if (!window.confirm(`Send PO to ${vendor.email}?`)) return;
        setIsSending(true);
        try {
            await sendPurchaseOrder(initialData.id, vendor.email, `Here is the purchase order for ${context.projectName}.`);
            toast.success("PO Sent");
            setStatus("Sent");
            router.refresh();
        } catch(e: any) {
            toast.error(e.message || "Failed to send");
        } finally {
            setIsSending(false);
        }
    };

    const handleApprove = async () => {
        if (!isEditing) return toast.error("Please save the PO first");
        const sig = window.prompt("Type your name to digitally sign and approve this Purchase Order representing internal review:");
        if (!sig) return;

        setIsApproving(true);
        try {
            await approvePurchaseOrder(initialData.id, sig);
            toast.success("Purchase Order Approved");
            setStatus("Approved");
            router.refresh();
        } catch(e: any) {
            toast.error(e.message || "Failed to approve");
        } finally { setIsApproving(false); }
    };

    const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        if (!e.target.files || e.target.files.length === 0 || !isEditing) return;
        setIsUploading(true);
        try {
            const file = e.target.files[0];
            const data = new FormData();
            data.append("file", file);
            await uploadPurchaseOrderFile(initialData.id, data);
            toast.success("File uploaded successfully");
            router.refresh();
        } catch(err: any) {
            toast.error(err.message || "Failed to upload file");
        } finally {
            setIsUploading(false);
            e.target.value = '';
        }
    };

    const handleDeleteFile = async (fileId: string) => {
        if (!confirm("Remove this attachment?")) return;
        try {
            await deletePurchaseOrderFile(fileId);
            toast.success("Attachment removed");
            router.refresh();
        } catch(err: any) {
            toast.error(err.message || "Failed to delete attachment");
        }
    };

    return (
        <div className="flex flex-col h-full bg-slate-50">
            {/* Top Navigation / Action Bar */}
            <div className="bg-white border-b border-hui-border px-6 py-4 items-center flex justify-between shadow-sm z-10 sticky top-0">
                <div className="flex items-center gap-4">
                    <Link href={`/projects/${context.projectId}/purchase-orders`} className="text-slate-400 hover:text-hui-primary transition">
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" /></svg>
                    </Link>
                    <div>
                        <h1 className="text-xl font-bold text-hui-textMain flex items-center gap-2">
                            {initialData?.code || "New PO"}
                            <StatusBadge status={status} />
                        </h1>
                        <p className="text-sm text-hui-textLight">Project: {context.projectName}</p>
                    </div>
                </div>

                <div className="flex items-center gap-2">
                    {isEditing && (
                        <>
                            <button
                                onClick={handleDelete}
                                disabled={isDeleting}
                                className="hui-btn hui-btn-secondary text-red-600 border-red-200 hover:bg-red-50 disabled:opacity-50"
                            >
                                Delete
                            </button>
                            <a
                                href={`/api/pdf/purchase-orders/${initialData.id}?inline=true`}
                                target="_blank"
                                rel="noreferrer"
                                className="hui-btn hui-btn-secondary text-slate-600 hover:bg-slate-100"
                            >
                                Preview PDF
                            </a>
                            <a
                                href={`/api/pdf/purchase-orders/${initialData.id}`}
                                target="_blank"
                                rel="noreferrer"
                                className="hui-btn hui-btn-secondary text-slate-600 hover:bg-slate-100"
                            >
                                Download PDF
                            </a>
                        </>
                    )}
                    {isEditing && status !== "Draft" && (
                        <button
                            onClick={handleSend}
                            disabled={isSending}
                            className="hui-btn hui-btn-secondary bg-blue-50 text-blue-700 hover:bg-blue-100 border-blue-200"
                        >
                            {isSending ? "Sending..." : "Send via Email"}
                        </button>
                    )}
                    {isEditing && status !== "Approved" && (
                        <button
                            onClick={handleApprove}
                            disabled={isApproving || isSaving}
                            className="hui-btn hui-btn-secondary bg-emerald-50 text-emerald-700 hover:bg-emerald-100 border-emerald-200"
                        >
                            {isApproving ? "Approving..." : "Approve"}
                        </button>
                    )}
                    <button
                        onClick={handleSave}
                        disabled={isSaving}
                        className="hui-btn hui-btn-primary bg-amber-600 hover:bg-amber-700 border-amber-600 text-white disabled:opacity-50"
                    >
                        {isSaving ? "Saving..." : "Save"}
                    </button>
                </div>
            </div>

            {/* Editor Area */}
            <div className="flex-1 overflow-x-hidden overflow-y-auto">
                <div className="max-w-5xl mx-auto p-4 sm:p-6 lg:p-8 space-y-6 pb-32">
                    
                    {/* Metadata Card */}
                    <div className="hui-card p-6 shadow-sm border border-hui-border flex flex-col sm:flex-row gap-6">
                        <div className="flex-1">
                            <label className="block text-sm font-semibold text-slate-700 mb-1.5">Select Vendor</label>
                            <select 
                                value={vendorId}
                                onChange={(e) => setVendorId(e.target.value)}
                                className="hui-input w-full bg-slate-50 border-slate-200"
                            >
                                <option value="" disabled>-- Select Vendor --</option>
                                {context.vendors.map(v => (
                                    <option key={v.id} value={v.id}>{v.name}</option>
                                ))}
                            </select>
                        </div>
                        
                        <div className="flex-1">
                            <label className="block text-sm font-semibold text-slate-700 mb-1.5">Status Override</label>
                            <select 
                                value={status}
                                onChange={(e) => setStatus(e.target.value)}
                                className="hui-input w-full bg-slate-50 border-slate-200"
                            >
                                <option value="Draft">Draft</option>
                                <option value="Sent">Sent</option>
                                <option value="Received">Received</option>
                                <option value="Cancelled">Cancelled</option>
                            </select>
                        </div>
                        
                        <div className="w-48 bg-slate-50 rounded-xl p-4 flex flex-col justify-center items-end border border-slate-100">
                            <span className="text-xs font-semibold text-slate-400 uppercase tracking-widest mb-1">Total Amount</span>
                            <span className="text-2xl font-bold text-hui-textMain">
                                ${totalAmount.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                            </span>
                        </div>
                    </div>

                    {/* PDF Drop Zone — only shown on new PO */}
                    {!isEditing && (
                        <div>
                            <input
                                ref={fileInputRef}
                                type="file"
                                accept="application/pdf,.pdf"
                                className="hidden"
                                onChange={handleDropZoneFileChange}
                            />
                            {!pendingFile ? (
                                <div
                                    onDragOver={handleDragOver}
                                    onDragLeave={handleDragLeave}
                                    onDrop={handleDrop}
                                    onClick={handleDropZoneClick}
                                    className={`hui-card border-2 border-dashed cursor-pointer transition-all p-8 flex flex-col items-center gap-3 ${
                                        isDraggingOver
                                            ? "border-amber-400 bg-amber-50"
                                            : "border-slate-200 bg-white hover:border-amber-300 hover:bg-amber-50/30"
                                    }`}
                                >
                                    <div className="w-12 h-12 rounded-full bg-amber-100 flex items-center justify-center">
                                        <Sparkles className="w-6 h-6 text-amber-600" />
                                    </div>
                                    <div className="text-center">
                                        <p className="font-semibold text-slate-700">Drop a vendor PDF to auto-fill</p>
                                        <p className="text-sm text-slate-400 mt-1">Quote, invoice, or receipt — Claude will extract vendor & line items</p>
                                    </div>
                                    <span className="text-xs text-slate-400 bg-slate-100 rounded px-2 py-1">PDF · max 5MB · or click to browse</span>
                                </div>
                            ) : isExtracting ? (
                                <div className="hui-card border border-amber-200 bg-amber-50 p-6 flex items-center gap-4">
                                    <Loader2 className="w-6 h-6 text-amber-600 animate-spin shrink-0" />
                                    <div>
                                        <p className="font-semibold text-amber-800">Reading {pendingFile.name}…</p>
                                        <p className="text-sm text-amber-600">Claude is extracting vendor info and line items</p>
                                    </div>
                                </div>
                            ) : (
                                <div className="hui-card border border-emerald-200 bg-emerald-50 p-4 flex items-center justify-between gap-4">
                                    <div className="flex items-center gap-3">
                                        <div className="w-9 h-9 rounded-lg bg-emerald-100 flex items-center justify-center shrink-0">
                                            <FileText className="w-5 h-5 text-emerald-600" />
                                        </div>
                                        <div>
                                            <p className="text-sm font-semibold text-emerald-800">{pendingFile.name}</p>
                                            <p className="text-xs text-emerald-600">
                                                Will be saved as attachment when you click Save
                                                {pendingNewVendor && ` · New vendor "${pendingNewVendor.name}" will be created`}
                                            </p>
                                        </div>
                                    </div>
                                    <button
                                        onClick={() => { setPendingFile(null); setExtractedVendorInfo(null); setPendingNewVendor(null); }}
                                        className="text-emerald-500 hover:text-red-500 p-1.5 rounded transition shrink-0"
                                        title="Remove PDF"
                                    >
                                        <X className="w-4 h-4" />
                                    </button>
                                </div>
                            )}
                        </div>
                    )}

                    {/* Builder Table */}
                    <div className="hui-card shadow-sm border border-hui-border">
                        <div className="px-6 py-4 border-b border-hui-border bg-slate-50 flex items-center justify-between rounded-t-xl">
                            <div className="flex items-center gap-2">
                                <div className="w-8 h-8 rounded bg-hui-primary/10 flex items-center justify-center text-hui-primary">
                                    <svg className="w-4.5 h-4.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" /></svg>
                                </div>
                                <h2 className="text-base font-bold text-hui-textMain">Line Items</h2>
                            </div>
                        </div>

                        <div className="overflow-x-auto">
                            <table className="w-full text-left text-sm whitespace-nowrap">
                                <thead className="bg-slate-50 border-b border-hui-border text-[11px] font-bold text-slate-400 uppercase tracking-wider">
                                    <tr>
                                        <th className="px-6 py-3 w-8"></th>
                                        <th className="px-6 py-3 min-w-[300px]">Description</th>
                                        <th className="px-6 py-3 w-48">Cost Code</th>
                                        <th className="px-6 py-3 w-28 text-right">Quantity</th>
                                        <th className="px-6 py-3 w-36 text-right">Unit Cost</th>
                                        <th className="px-6 py-3 w-40 text-right">Total</th>
                                        <th className="px-6 py-3 w-16 text-right"></th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-100">
                                    {items.map((item, index) => (
                                        <tr key={index} className="hover:bg-slate-50/50 transition relative group">
                                            <td className="px-6 py-3 text-slate-300">
                                                <div className="cursor-grab hover:text-hui-primary">
                                                    <svg className="w-5 h-5 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 8h16M4 16h16" /></svg>
                                                </div>
                                            </td>
                                            <td className="px-6 py-3">
                                                <input 
                                                    type="text" 
                                                    value={item.description}
                                                    onChange={e => handleItemChange(index, "description", e.target.value)}
                                                    placeholder="Item name or description"
                                                    className="w-full bg-transparent border-0 border-b border-transparent hover:border-slate-200 focus:border-hui-primary focus:ring-0 px-2 py-1.5 transition placeholder-slate-300 focus:bg-white focus:shadow-[0_0_10px_rgba(0,0,0,0.05)] rounded-t text-sm font-medium"
                                                />
                                            </td>
                                            <td className="px-6 py-3">
                                                <select
                                                    value={item.costCodeId || ""}
                                                    onChange={e => handleItemChange(index, "costCodeId", e.target.value)}
                                                    className="w-full bg-transparent border-0 hover:bg-slate-50 focus:bg-white rounded px-2 py-1.5 text-sm text-slate-600 focus:ring-2 focus:ring-hui-primary/20 appearance-none"
                                                >
                                                    <option value="">-- Code --</option>
                                                    {context.costCodes.map(c => (
                                                        <option key={c.id} value={c.id}>{c.code} {c.name}</option>
                                                    ))}
                                                </select>
                                            </td>
                                            <td className="px-6 py-3 text-right">
                                                <input 
                                                    type="number" 
                                                    value={item.quantity}
                                                    onChange={e => handleItemChange(index, "quantity", e.target.value)}
                                                    className="w-full text-right bg-transparent border-0 border-b border-transparent hover:border-slate-200 focus:border-hui-primary focus:ring-0 px-2 py-1 transition tabular-nums focus:bg-white font-medium"
                                                    min="0"
                                                    step="0.01"
                                                />
                                            </td>
                                            <td className="px-6 py-3 text-right">
                                                <div className="relative">
                                                    <span className="absolute left-2 top-1.5 text-slate-400 font-medium">$</span>
                                                    <input 
                                                        type="number" 
                                                        value={item.unitCost}
                                                        onChange={e => handleItemChange(index, "unitCost", e.target.value)}
                                                        className="w-full text-right bg-transparent border-0 border-b border-transparent hover:border-slate-200 focus:border-hui-primary focus:ring-0 pl-6 pr-2 py-1 transition tabular-nums focus:bg-white font-medium"
                                                    />
                                                </div>
                                            </td>
                                            <td className="px-6 py-3 text-right font-semibold tabular-nums text-hui-textMain">
                                                ${(Number(item.total) || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}
                                            </td>
                                            <td className="px-6 py-3 text-right">
                                                <button 
                                                    onClick={() => removeItem(index)}
                                                    className="text-slate-300 hover:text-red-500 hover:bg-red-50 p-1.5 rounded transition opacity-0 group-hover:opacity-100 focus:opacity-100"
                                                >
                                                    <Trash2 className="w-4 h-4" />
                                                </button>
                                            </td>
                                        </tr>
                                    ))}
                                    
                                    {/* Add Button Row */}
                                    <tr>
                                        <td colSpan={7} className="px-6 py-3 bg-slate-50/50">
                                            <button 
                                                onClick={addItem}
                                                className="flex items-center gap-2 text-sm font-medium text-hui-primary hover:text-emerald-700 transition px-2 py-1 rounded hover:bg-emerald-50"
                                            >
                                                <Plus className="w-4 h-4" />
                                                Add Item
                                            </button>
                                        </td>
                                    </tr>

                                    <tr className="bg-slate-50">
                                        <td colSpan={5} className="px-6 py-4 text-right font-semibold text-hui-textMain border-t border-hui-border">
                                            Total
                                        </td>
                                        <td className="px-6 py-4 text-right font-bold text-lg tabular-nums text-hui-textMain border-t border-hui-border">
                                            ${totalAmount.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                                        </td>
                                        <td className="border-t border-hui-border"></td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>
                    </div>

                    {/* Memos & Notes */}
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                        <div className="hui-card p-6 shadow-sm border border-hui-border space-y-4">
                            <div>
                                <label className="block text-sm font-bold text-hui-textMain mb-2">Terms & Conditions</label>
                                <textarea 
                                    value={terms}
                                    onChange={e => setTerms(e.target.value)}
                                    className="hui-input w-full p-3 h-32 text-sm text-slate-600 resize-none font-sans"
                                    placeholder="Add payment terms, delivery instructions..."
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-bold text-hui-textMain mb-2">Internal Notes</label>
                                <textarea 
                                    value={notes}
                                    onChange={e => setNotes(e.target.value)}
                                    className="hui-input w-full p-3 h-20 text-sm bg-amber-50/50 border-amber-200 text-slate-600 resize-none font-sans placeholder-amber-200"
                                    placeholder="Internal memos (Not visible to vendor)"
                                />
                            </div>
                        </div>
                        
                        {/* Attachments & Expenses Panel */}
                        <div className="space-y-6">
                            {/* Attachments */}
                            <div className="hui-card shadow-sm border border-hui-border flex flex-col">
                                <div className="px-6 py-4 border-b border-hui-border bg-slate-50 flex items-center justify-between">
                                    <h3 className="font-bold text-hui-textMain flex items-center gap-2">
                                        <FileText className="w-4 h-4 text-slate-400" />
                                        Attachments
                                    </h3>
                                    {isEditing && (
                                        <label className="hui-btn hui-btn-secondary text-sm py-1.5 cursor-pointer">
                                            {isUploading ? "Uploading..." : <><Upload className="w-4 h-4 mr-1"/> Upload File</>}
                                            <input type="file" className="hidden" onChange={handleFileUpload} disabled={isUploading} />
                                        </label>
                                    )}
                                </div>
                                <div className="p-4 flex-1">
                                    {!initialData?.files?.length ? (
                                        <div className="text-sm text-slate-400 italic text-center py-4">No files attached</div>
                                    ) : (
                                        <ul className="space-y-2">
                                            {initialData.files.map((file: any) => (
                                                <li key={file.id} className="flex flex-col sm:flex-row sm:items-center justify-between p-3 rounded-lg border border-slate-100 bg-slate-50/50 hover:bg-slate-50 transition gap-2">
                                                    <div className="flex items-center gap-3 overflow-hidden">
                                                        <div className="w-8 h-8 rounded bg-blue-100 text-blue-600 flex items-center justify-center shrink-0">
                                                            <FileText className="w-4 h-4" />
                                                        </div>
                                                        <div className="overflow-hidden bg-transparent">
                                                            <a href={file.url} target="_blank" rel="noreferrer" className="text-sm font-medium text-blue-600 hover:underline truncate block">
                                                                {file.name}
                                                            </a>
                                                            <p className="text-xs text-slate-400">{(file.size / 1024 / 1024).toFixed(2)} MB • {new Date(file.createdAt).toLocaleDateString()}</p>
                                                        </div>
                                                    </div>
                                                    <button onClick={() => handleDeleteFile(file.id)} className="text-slate-400 hover:text-red-600 p-2 ml-auto shrink-0 transition" title="Remove">
                                                        <Trash2 className="w-4 h-4"/>
                                                    </button>
                                                </li>
                                            ))}
                                        </ul>
                                    )}
                                </div>
                            </div>
                            
                            {/* Linked Expenses */}
                            <div className="hui-card shadow-sm border border-hui-border flex flex-col">
                                <div className="px-6 py-4 border-b border-hui-border bg-slate-50 flex flex-col gap-2">
                                    <h3 className="font-bold text-hui-textMain flex items-center gap-2">
                                        <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                                        Linked Bills (Expenses)
                                    </h3>
                                    <p className="text-xs text-slate-500">Expenses tracking this PO for 3-way match.</p>
                                </div>
                                <div className="p-4 flex-1">
                                    {!initialData?.expenses?.length ? (
                                        <div className="text-sm text-slate-400 italic text-center py-4">No bills have been linked to this PO yet.</div>
                                    ) : (
                                        <div className="space-y-4">
                                            <ul className="space-y-2">
                                                {initialData.expenses.map((expense: any) => (
                                                    <li key={expense.id} className="flex items-center justify-between text-sm p-2 rounded bg-emerald-50/50 border border-emerald-100">
                                                        <div className="flex flex-col">
                                                            <span className="font-medium text-slate-700">{expense.description || "Vendor Bill"}</span>
                                                            <span className="text-xs text-slate-500">{new Date(expense.createdAt).toLocaleDateString()}</span>
                                                        </div>
                                                        <span className="font-bold text-hui-textMain font-mono">${(Number(expense.amount) || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}</span>
                                                    </li>
                                                ))}
                                            </ul>
                                            <div className="pt-3 border-t border-slate-100 flex items-center justify-between text-sm">
                                                <span className="text-slate-600 font-semibold">Total Billed:</span>
                                                <span className="font-bold text-emerald-600 font-mono">
                                                    ${initialData.expenses.reduce((acc: number, e: any) => acc + (Number(e.amount) || 0), 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}
                                                </span>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>

                    </div>
                    {/* Messaging / Gmail Sync Thread */}
                    {isEditing && (
                        <POMessageThread poId={initialData.id} messages={initialData.messages || []} />
                    )}
                </div>
            </div>
        </div>
    );
}
