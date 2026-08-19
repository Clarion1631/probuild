"use client";

import { useState } from "react";
import { formatCurrency } from "@/lib/utils";
import {
    internalBudget, bufferPercent, bufferColor, bufferBgColor,
    marginPatchForInput, marginPatchForRate, marginIsUnrepresentable,
    marginIsStale, marginIsSettable, rawMarginPct, DEFAULT_MARGIN_PCT, MAX_MARGIN_PCT,
} from "@/lib/budget-math";

const UNIT_SUGGESTIONS = ["hrs", "sqft", "lf", "ea", "lump sum", "units", "days"];

interface BudgetStripProps {
    item: any;
    updateItem: (itemId: string, patch: Record<string, any>) => void;
    contextType: "project" | "lead";
    onLinkPO: (itemId: string) => void;
    onCreatePO: (itemId: string) => void;
    onUnlinkPO: (itemId: string, poId: string) => void;
    onViewPO: (poId: string) => void;
}

export default function BudgetStrip({
    item, updateItem, contextType, onLinkPO, onCreatePO, onUnlinkPO, onViewPO
}: BudgetStripProps) {
    const [showUnitDropdown, setShowUnitDropdown] = useState(false);
    const [openPopoverPoId, setOpenPopoverPoId] = useState<string | null>(null);

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

    const links = item.purchaseOrderLinks ?? [];
    const isLead = contextType === "lead";
    const isPoLocked = links.length > 0;
    const sellPrice = parseFloat(item.unitCost) || 0;
    // A margin with no sell price to be a share of can't be stored honestly — the rate write is
    // skipped and markupPercent ends up describing nothing (the gap #331 surfaced but left open).
    const marginInputDisabled = isPoLocked || !marginIsSettable(sellPrice);

    // The rate is whatever the user typed — we never rewrite it to make the margin true. When the
    // pair can't be expressed as a storable margin, say so on the row instead of letting the
    // clamped markupPercent quietly claim otherwise.
    // `|| 0` would fold an unparseable stored rate into the exempt "no budget" value and hide it.
    // Blank is genuinely no budget; anything else keeps whatever it parses to, NaN included.
    const rateText = budgetRateVal == null ? "" : String(budgetRateVal).trim();
    const currentRate = rateText === "" ? 0 : parseFloat(rateText);
    const storedMargin = item.markupPercent == null ? null : parseFloat(item.markupPercent);
    const unrepresentable = marginIsUnrepresentable(currentRate, sellPrice);
    // A stale margin is one this editor can no longer create — it flags rows saved before the
    // sell-price input started re-deriving. Editing either side of the row repairs it.
    const stale = !unrepresentable && marginIsStale(storedMargin, currentRate, sellPrice);
    const marginLies = unrepresentable || stale;
    const marginWarning = !marginLies
        ? null
        : stale
            ? `Saved margin (${storedMargin!.toFixed(2)}%) doesn't match this cost — ${formatCurrency(currentRate)} against ${formatCurrency(sellPrice)} is ${rawMarginPct(currentRate, sellPrice)!.toFixed(2)}%. Re-enter the rate or the margin to fix it.`
            : currentRate < 0 || !Number.isFinite(currentRate)
                ? "Budget cost isn't a valid amount — the margin can't be derived from it."
                // Guard non-finite BEFORE the comparison branches: against an Infinity sell price
                // both `<= 0` and `currentRate > sellPrice` read false, which used to fall through
                // to the "under 1% of sell price" message.
                : !Number.isFinite(sellPrice) || sellPrice <= 0
                    ? "Budget cost is set but this line has no valid sell price — the margin below is meaningless."
                    : currentRate > sellPrice
                        ? `Cost exceeds sell price — this line loses ${formatCurrency(currentRate - sellPrice)}/unit. Margin can't go below 0%.`
                        : `Cost is under 1% of the sell price — margin is capped at ${MAX_MARGIN_PCT}%.`;

    return (
        <div className={`ml-14 mr-2 mb-1 rounded-lg bg-indigo-50/60 border-l-3 text-xs ${marginWarning ? "border-red-400" : "border-indigo-300"}`}>
        <div className="flex items-center gap-3 px-4 py-2">
            {/* PO lock indicator — budget is committed, AI/Reset will skip this row */}
            {isPoLocked && (
                <span
                    className="flex items-center justify-center w-5 h-5 text-slate-500 flex-shrink-0"
                    title={`Budget protected by PO${links.length ? ` ${links.map((l: any) => l.purchaseOrder.code).join(", ")}` : ""}`}
                >
                    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="3" y="11" width="18" height="11" rx="2" />
                        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                    </svg>
                </span>
            )}

            {/* Budget Inputs */}
            <div className="flex items-center gap-1.5">
                <label className="text-indigo-400 font-medium whitespace-nowrap">Budget:</label>
                <input
                    type="number"
                    value={budgetQty}
                    onChange={e => updateItem(item.id, { budgetQuantity: e.target.value === "" ? null : parseFloat(e.target.value) })}
                    onBlur={() => {}}
                    className="w-16 bg-white border border-indigo-200 rounded px-1.5 py-1 text-right text-xs focus:ring-1 ring-indigo-400 focus:outline-none"
                    placeholder="Qty"
                    step="any"
                />
                <div className="relative">
                    <input
                        type="text"
                        value={item.budgetUnit || ""}
                        onChange={e => updateItem(item.id, { budgetUnit: e.target.value || null })}
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
                                    onMouseDown={e => { e.preventDefault(); updateItem(item.id, { budgetUnit: u }); setShowUnitDropdown(false); }}
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
                            // Budget-side edit: update budget fields only. Customer price (unitCost)
                            // is the source of truth — we derive margin from it, never the reverse.
                            // The rate is persisted EXACTLY as typed — clamping it here would
                            // silently rewrite a cost the user entered. The margin always follows
                            // the rate (marginPatchForRate), and when the pair can't be expressed
                            // as a margin the row warns instead. Previously the `r > 0 && price > 0`
                            // guard skipped the margin write entirely, stranding the old margin
                            // next to a rate that no longer implied it.
                            const val = e.target.value === "" ? null : e.target.value;
                            const r = parseFloat(e.target.value) || 0;
                            const price = parseFloat(item.unitCost) || 0;
                            updateItem(item.id, {
                                budgetRate: val,
                                baseCost: r > 0 ? val : null,
                                ...marginPatchForRate(r, price),
                            });
                        }}
                        aria-invalid={marginLies || undefined}
                        className={`w-20 bg-white border rounded pl-4 pr-1.5 py-1 text-right text-xs focus:ring-1 focus:outline-none ${marginLies ? "border-red-400 ring-red-400" : "border-indigo-200 ring-indigo-400"}`}
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

            {/* Margin + Sell Price */}
            <div className="flex items-center gap-1.5">
                <label className="text-indigo-400 font-medium whitespace-nowrap">Margin:</label>
                <div className="relative">
                    <input
                        type="number"
                        value={item.markupPercent ?? DEFAULT_MARGIN_PCT}
                        min={0}
                        max={MAX_MARGIN_PCT}
                        onChange={e => {
                            // Margin edit: recompute budgetRate from the preserved sell price.
                            // unitCost is never written — customer pricing stays locked.
                            // `stored` and `derivedFrom` come out of one normalization so the margin
                            // we persist is always the margin the rate was derived from.
                            // One patch or none: the margin and the rate derived from it are never
                            // written apart. Persisting the margin while the rate write was skipped
                            // for want of a sell price is the defect this closes — null here means
                            // the margin can't describe anything, and the input is disabled to match.
                            const patch = marginPatchForInput(e.target.value, parseFloat(item.unitCost) || 0);
                            if (patch) updateItem(item.id, patch);
                        }}
                        disabled={marginInputDisabled}
                        title={
                            isPoLocked
                                ? undefined
                                : marginInputDisabled
                                    ? "Enter a sell price before setting a margin — a margin is a share of the sell price."
                                    : undefined
                        }
                        className="w-14 bg-white border border-indigo-200 rounded px-1.5 pr-4 py-1 text-right text-xs focus:ring-1 ring-indigo-400 focus:outline-none disabled:opacity-60 disabled:cursor-not-allowed"
                        step="any"
                    />
                    <span className="absolute right-1.5 top-1 text-indigo-300 text-[10px]">%</span>
                </div>
                <span className="text-indigo-300">&rarr;</span>
                <span className="font-semibold text-indigo-700 whitespace-nowrap">
                    {formatCurrency(sellPrice)}
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
            <div className="flex items-center gap-2 ml-auto flex-wrap justify-end">
                {links.map((link: any) => {
                    const linkPo = link.purchaseOrder;
                    return (
                        <div key={linkPo.id} className="relative">
                            <button
                                onClick={() => setOpenPopoverPoId(openPopoverPoId === linkPo.id ? null : linkPo.id)}
                                className="flex items-center gap-1.5 bg-white border border-indigo-200 rounded-full px-2.5 py-0.5 text-xs font-medium text-indigo-700 hover:border-indigo-400 transition"
                            >
                                <span className="w-1.5 h-1.5 rounded-full bg-indigo-400" />
                                {linkPo.code} — {linkPo.vendor?.name || "Vendor"} — {formatCurrency(Number(linkPo.totalAmount))}
                            </button>
                            {openPopoverPoId === linkPo.id && (
                                <div className="absolute top-full right-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-lg z-30 w-40 py-1">
                                    <button
                                        onClick={() => { onViewPO(linkPo.id); setOpenPopoverPoId(null); }}
                                        className="w-full text-left px-3 py-1.5 text-xs hover:bg-slate-50 transition flex items-center gap-2"
                                    >
                                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3" /></svg>
                                        View PO
                                    </button>
                                    <button
                                        onClick={() => { onUnlinkPO(item.id, linkPo.id); setOpenPopoverPoId(null); }}
                                        className="w-full text-left px-3 py-1.5 text-xs text-red-600 hover:bg-red-50 transition flex items-center gap-2"
                                    >
                                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
                                        Unlink
                                    </button>
                                </div>
                            )}
                        </div>
                    );
                })}
                {isLead ? (
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

            {/* Cost/sell incoherence. Shown, never silently corrected — the rate is a number the
                user typed, and markupPercent floors at 0, so this row's stored margin does not
                describe its stored cost. Plain text, not a tooltip: hover is unreliable here. */}
            {marginWarning && (
                <div role="alert" className="flex items-start gap-1.5 px-4 pb-2 -mt-0.5 text-[11px] font-medium text-red-600">
                    <svg className="w-3.5 h-3.5 flex-shrink-0 mt-px" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 9v4M12 17h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
                    </svg>
                    <span>{marginWarning}</span>
                </div>
            )}
        </div>
    );
}
