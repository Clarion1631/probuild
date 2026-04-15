"use client";

import { useState } from "react";
import { formatCurrency } from "@/lib/utils";
import { internalBudget, bufferPercent, bufferColor, bufferBgColor } from "@/lib/budget-math";
import { toast } from "sonner";

const UNIT_SUGGESTIONS = ["hrs", "sqft", "lf", "ea", "lump sum", "units", "days"];

/** Returns a numeric markup %, defaulting to 25 when the value is empty/NaN. */
function effectiveMarkup(raw: string | number | null | undefined): number {
    const n = parseFloat(String(raw ?? ""));
    return Number.isFinite(n) ? n : 25;
}

interface BudgetStripProps {
    item: any;
    index: number;
    updateItem: (index: number, field: string, value: any) => void;
    contextType: "project" | "lead";
    onLinkPO: (itemId: string) => void;
    onCreatePO: (itemId: string) => void;
    onUnlinkPO: (itemId: string) => void;
    onViewPO: (poId: string) => void;
}

export default function BudgetStrip({
    item, index, updateItem, contextType, onLinkPO, onCreatePO, onUnlinkPO, onViewPO
}: BudgetStripProps) {
    const [showUnitDropdown, setShowUnitDropdown] = useState(false);
    const [showPOPopover, setShowPOPopover] = useState(false);

    const budgetQty = item.budgetQuantity ?? item.quantity ?? 0;
    const budgetRateVal = item.budgetRate ?? item.baseCost ?? "";
    const budget = internalBudget({
        budgetQuantity: item.budgetQuantity,
        quantity: parseFloat(item.quantity) || 0,
        budgetRate: item.budgetRate,
        baseCost: item.baseCost,
    });
    const buffer = bufferPercent({
        quantity: parseFloat(item.quantity) || 0,
        unitCost: item.unitCost || 0,
        budgetQuantity: item.budgetQuantity,
        budgetRate: item.budgetRate,
        baseCost: item.baseCost,
    });

    const po = item.purchaseOrder;
    const isLead = contextType === "lead";

    return (
        <div className="flex items-center gap-3 px-4 py-2 ml-14 mr-2 mb-1 rounded-lg bg-indigo-50/60 border-l-3 border-indigo-300 text-xs">
            {/* Budget Inputs */}
            <div className="flex items-center gap-1.5">
                <label className="text-indigo-400 font-medium whitespace-nowrap">Budget:</label>
                <input
                    type="number"
                    value={budgetQty}
                    onChange={e => updateItem(index, "budgetQuantity", e.target.value === "" ? null : parseFloat(e.target.value))}
                    onBlur={() => {}}
                    className="w-16 bg-white border border-indigo-200 rounded px-1.5 py-1 text-right text-xs focus:ring-1 ring-indigo-400 focus:outline-none"
                    placeholder="Qty"
                    step="any"
                />
                <div className="relative">
                    <input
                        type="text"
                        value={item.budgetUnit || ""}
                        onChange={e => updateItem(index, "budgetUnit", e.target.value || null)}
                        onFocus={() => setShowUnitDropdown(true)}
                        onBlur={() => setTimeout(() => setShowUnitDropdown(false), 150)}
                        className="w-16 bg-white border border-indigo-200 rounded px-1.5 py-1 text-xs focus:ring-1 ring-indigo-400 focus:outline-none"
                        placeholder="unit"
                    />
                    {showUnitDropdown && (
                        <div className="absolute top-full left-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-lg z-20 w-24">
                            {UNIT_SUGGESTIONS.filter(u => !item.budgetUnit || u.includes(item.budgetUnit.toLowerCase())).map(u => (
                                <button
                                    key={u}
                                    onMouseDown={e => { e.preventDefault(); updateItem(index, "budgetUnit", u); setShowUnitDropdown(false); }}
                                    className="w-full text-left px-2 py-1 text-xs hover:bg-indigo-50 transition"
                                >
                                    {u}
                                </button>
                            ))}
                        </div>
                    )}
                </div>
                <span className="text-indigo-300">@</span>
                <div className="relative">
                    <span className="absolute left-1.5 top-1 text-indigo-300">$</span>
                    <input
                        type="number"
                        value={budgetRateVal}
                        onChange={e => {
                            const val = e.target.value === "" ? null : e.target.value;
                            const rate = parseFloat(e.target.value) || 0;
                            const mp = effectiveMarkup(item.markupPercent);
                            updateItem(index, "budgetRate", val);
                            // Only sync baseCost when rate is meaningful; null means "not entered"
                            updateItem(index, "baseCost", rate > 0 ? val : null);
                            updateItem(index, "unitCost", (rate * (1 + mp / 100)).toFixed(2));
                        }}
                        className="w-20 bg-white border border-indigo-200 rounded pl-4 pr-1.5 py-1 text-right text-xs focus:ring-1 ring-indigo-400 focus:outline-none"
                        placeholder="Rate"
                        step="any"
                    />
                </div>
                <span className="text-indigo-300">=</span>
                <span className="font-semibold text-indigo-700 whitespace-nowrap">
                    {budget != null ? formatCurrency(budget) : "—"}
                </span>
            </div>

            {/* Divider */}
            <div className="w-px h-5 bg-indigo-200" />

            {/* Markup + Sell Price */}
            <div className="flex items-center gap-1.5">
                <label className="text-indigo-400 font-medium whitespace-nowrap">Markup:</label>
                <div className="relative">
                    <input
                        type="number"
                        value={item.markupPercent ?? 25}
                        onChange={e => {
                            const mp = effectiveMarkup(e.target.value);
                            const rate = parseFloat(budgetRateVal) || 0;
                            // Store null when cleared so ?? 25 fallback works consistently
                            updateItem(index, "markupPercent", e.target.value === "" ? null : e.target.value);
                            updateItem(index, "baseCost", rate > 0 ? rate.toString() : null);
                            updateItem(index, "unitCost", (rate * (1 + mp / 100)).toFixed(2));
                        }}
                        className="w-14 bg-white border border-indigo-200 rounded px-1.5 pr-4 py-1 text-right text-xs focus:ring-1 ring-indigo-400 focus:outline-none"
                        step="any"
                    />
                    <span className="absolute right-1.5 top-1 text-indigo-300 text-[10px]">%</span>
                </div>
                <span className="text-indigo-300">&rarr;</span>
                <span className="font-semibold text-indigo-700 whitespace-nowrap">
                    {formatCurrency((parseFloat(budgetRateVal) || 0) * (1 + effectiveMarkup(item.markupPercent) / 100))}
                </span>
            </div>

            {/* Divider */}
            <div className="w-px h-5 bg-indigo-200" />

            {/* Buffer % */}
            <div className={`px-2 py-0.5 rounded-full font-bold ${bufferBgColor(buffer)} ${bufferColor(buffer)}`}>
                {buffer != null ? `${buffer.toFixed(1)}%` : "—"}
            </div>

            {/* Divider */}
            <div className="w-px h-5 bg-indigo-200" />

            {/* PO Section */}
            <div className="flex items-center gap-2 ml-auto">
                {po ? (
                    <div className="relative">
                        <button
                            onClick={() => setShowPOPopover(!showPOPopover)}
                            className="flex items-center gap-1.5 bg-white border border-indigo-200 rounded-full px-2.5 py-0.5 text-xs font-medium text-indigo-700 hover:border-indigo-400 transition"
                        >
                            <span className="w-1.5 h-1.5 rounded-full bg-indigo-400" />
                            {po.code} — {po.vendor?.name || "Vendor"} — {formatCurrency(Number(po.totalAmount))}
                        </button>
                        {showPOPopover && (
                            <div className="absolute top-full right-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-lg z-30 w-40 py-1">
                                <button
                                    onClick={() => { onViewPO(po.id); setShowPOPopover(false); }}
                                    className="w-full text-left px-3 py-1.5 text-xs hover:bg-slate-50 transition flex items-center gap-2"
                                >
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3" /></svg>
                                    View PO
                                </button>
                                <button
                                    onClick={() => { onUnlinkPO(item.id); setShowPOPopover(false); }}
                                    className="w-full text-left px-3 py-1.5 text-xs text-red-600 hover:bg-red-50 transition flex items-center gap-2"
                                >
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
                                    Unlink
                                </button>
                            </div>
                        )}
                    </div>
                ) : isLead ? (
                    <span className="text-slate-400 italic text-[10px]" title="Convert to project to create purchase orders">
                        Requires project
                    </span>
                ) : (
                    <div className="flex items-center gap-1.5">
                        <button
                            onClick={() => onLinkPO(item.id)}
                            className="text-indigo-400 hover:text-indigo-600 font-medium transition"
                        >
                            Link PO
                        </button>
                        <span className="text-indigo-200">|</span>
                        <button
                            onClick={() => onCreatePO(item.id)}
                            className="text-indigo-400 hover:text-indigo-600 font-medium transition"
                        >
                            + Create PO
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}
