"use client";

import { useState } from "react";
import { toast } from "sonner";
import { taxIsAtSource } from "@/lib/expense-attribution";

/**
 * The bookkeeper's correction surface for the WA "tax paid at source" report
 * (Phase 3 §7).
 *
 * Until this existed the only way to answer "was this material installed at a
 * customer job?" was a hand-written PATCH, so the report had almost nothing to
 * count: nothing defaults `installedAtCustomer` any more, precisely because
 * defaulting it claimed a deduction nobody had looked at.
 *
 * It talks to `PATCH /api/expenses/[id]`, not the PUT — the PUT is guarded by
 * `assertExpenseMutableOutsideQbo` and every pipeline-booked expense carries a
 * `qbPurchaseId`, which is exactly the population this panel has to reach.
 */

export interface TaxPhaseExpense {
    id: string;
    vendor: string | null;
    description: string | null;
    amount: number;
    taxAmount: number | null;
    taxAtSource: boolean;
    installedAtCustomer: boolean | null;
    taxDeductibleBase: number | null;
    needsTaxReview: boolean;
    costCodeId: string | null;
}

export interface PhaseOption {
    id: string;
    code: string;
    name: string;
}

/** Mirrors the server's rule so the hint and the 400 can never disagree. */
const MAX_TAX_RATE = 0.12;

function money(value: number): string {
    return value.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

export default function TaxPhaseModal({
    expense,
    phases,
    onClose,
    onSaved,
}: {
    expense: TaxPhaseExpense;
    phases: PhaseOption[];
    onClose: () => void;
    onSaved: () => void;
}) {
    const [installed, setInstalled] = useState<"unknown" | "yes" | "no">(
        expense.installedAtCustomer === null ? "unknown" : expense.installedAtCustomer ? "yes" : "no",
    );
    const [taxAmount, setTaxAmount] = useState<string>(
        expense.taxAmount === null ? "" : String(expense.taxAmount),
    );
    const [base, setBase] = useState<string>(
        expense.taxDeductibleBase === null ? "" : String(expense.taxDeductibleBase),
    );
    const [costCodeId, setCostCodeId] = useState<string>(expense.costCodeId ?? "");
    // Only meaningful on a flagged row: the explicit "I have re-checked these
    // figures" the server requires before it will clear the flag.
    const [reviewAck, setReviewAck] = useState(false);
    const [saving, setSaving] = useState(false);

    const parsedTax = taxAmount.trim() === "" ? null : Number(taxAmount);
    const effectiveTax = parsedTax ?? 0;
    // SIGNED. A return or vendor credit is a negative expense: its tax and its
    // deductible portion are negative too, and the server refuses a figure
    // pointing the other way. The inputs follow the receipt rather than
    // assuming every expense is money going out.
    const isCredit = expense.amount < 0;
    const taxCeiling = Math.round(Math.abs(expense.amount) * MAX_TAX_RATE * 100) / 100;
    const baseCeiling = Math.round(Math.abs(expense.amount - effectiveTax) * 100) / 100;

    async function save() {
        // Only what actually changed. The endpoint refuses unknown keys, and
        // sending a field back unchanged would stamp provenance on it for no
        // reason.
        const body: Record<string, unknown> = {};
        const nextInstalled = installed === "unknown" ? null : installed === "yes";
        if (nextInstalled !== expense.installedAtCustomer) body.installedAtCustomer = nextInstalled;
        if (parsedTax !== expense.taxAmount) {
            body.taxAmount = parsedTax;
            // `taxAtSource` is the factual "tax was charged here"; it follows
            // the figure rather than being a second thing to get wrong. SIGNED:
            // a return carries negative tax and the fact still holds.
            body.taxAtSource = taxIsAtSource(parsedTax);
        }
        const nextBase = base.trim() === "" ? null : Number(base);
        if (nextBase !== expense.taxDeductibleBase) body.taxDeductibleBase = nextBase;
        const nextCode = costCodeId || null;
        if (nextCode !== expense.costCodeId) body.costCodeId = nextCode;

        // ACKNOWLEDGING A REVIEW SENDS THE FIGURES, CHANGED OR NOT.
        //
        // The flag says the whole classification is in doubt because the gross
        // moved underneath it, so "I did not edit that field" is not the same
        // as "I checked it". The server refuses an ack that does not carry both
        // numbers, which is what makes the confirmation mean something.
        if (expense.needsTaxReview && reviewAck) {
            body.taxReviewAck = true;
            body.taxAmount = parsedTax;
            body.taxAtSource = taxIsAtSource(parsedTax);
            body.taxDeductibleBase = nextBase;
        }

        if (Object.keys(body).length === 0) {
            onClose();
            return;
        }

        setSaving(true);
        try {
            const res = await fetch(`/api/expenses/${expense.id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                // The server's message is the useful one — it names the ceiling
                // it refused against.
                toast.error(data?.error || "Could not save the tax details.");
                return;
            }
            toast.success("Tax and phase updated");
            onSaved();
        } catch {
            toast.error("Could not reach the server.");
        } finally {
            setSaving(false);
        }
    }

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="hui-card w-full max-w-lg max-h-[90vh] overflow-y-auto p-6 space-y-5 bg-white">
                <div>
                    <h2 className="text-lg font-bold text-hui-textMain">Tax &amp; phase</h2>
                    <p className="text-sm text-hui-textMuted mt-1">
                        {expense.vendor || "Expense"} · {money(expense.amount)}
                    </p>
                    {expense.needsTaxReview && (
                        <div className="mt-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2 space-y-2">
                            <p>
                                QuickBooks changed this purchase&apos;s total after someone recorded its tax, so
                                these figures are in doubt. Please re-check them.
                            </p>
                            <label className="flex items-start gap-2 font-medium">
                                <input
                                    type="checkbox"
                                    className="mt-0.5"
                                    checked={reviewAck}
                                    onChange={event => setReviewAck(event.target.checked)}
                                />
                                <span>
                                    I have re-checked the tax and the deductible amount below. Until this is
                                    ticked the receipt stays out of the excise report.
                                </span>
                            </label>
                        </div>
                    )}
                </div>

                <div className="space-y-2">
                    <span className="text-xs text-hui-textMuted font-medium uppercase tracking-wider">
                        Installed at a customer job?
                    </span>
                    <div className="flex gap-2">
                        {([
                            ["yes", "Yes — resold to the client"],
                            ["no", "No — shop / consumable"],
                            ["unknown", "Not reviewed"],
                        ] as const).map(([value, label]) => (
                            <button
                                key={value}
                                type="button"
                                onClick={() => setInstalled(value)}
                                className={`hui-btn text-sm flex-1 ${installed === value ? "hui-btn-primary" : "hui-btn-secondary"}`}
                            >
                                {label}
                            </button>
                        ))}
                    </div>
                    <p className="text-xs text-hui-textMuted">
                        Only an explicit <strong>Yes</strong> is claimed on the excise return. &quot;Not
                        reviewed&quot; is never deducted.
                    </p>
                </div>

                <label className="block space-y-1">
                    <span className="text-xs text-hui-textMuted font-medium uppercase tracking-wider">
                        Sales tax on the receipt
                    </span>
                    <input
                        type="number"
                        step="0.01"
                        // Signed: a credit's tax is negative, and the server
                        // refuses a figure pointing against the amount.
                        {...(isCredit ? { max: 0 } : { min: 0 })}
                        className="hui-input w-full"
                        value={taxAmount}
                        onChange={event => setTaxAmount(event.target.value)}
                        placeholder="0.00"
                    />
                    <span className="text-xs text-hui-textMuted">
                        {isCredit
                            ? `This is a refund, so enter the tax as a negative, down to -${money(taxCeiling)} (12% of the receipt).`
                            : `Up to ${money(taxCeiling)} (12% of the receipt).`}{" "}
                        Leave blank if the read was wrong and you don&apos;t know the figure.
                    </span>
                </label>

                <label className="block space-y-1">
                    <span className="text-xs text-hui-textMuted font-medium uppercase tracking-wider">
                        Deduction base <span className="normal-case font-normal">(mixed receipts only)</span>
                    </span>
                    <input
                        type="number"
                        step="0.01"
                        {...(isCredit ? { max: 0 } : { min: 0 })}
                        className="hui-input w-full"
                        value={base}
                        onChange={event => setBase(event.target.value)}
                        placeholder={`whole pre-tax total — ${isCredit ? "-" : ""}${money(baseCeiling)}`}
                    />
                    <span className="text-xs text-hui-textMuted">
                        Leave blank and the whole pre-tax total is recorded for you (
                        {isCredit ? `-${money(baseCeiling)}` : money(baseCeiling)}). Set it when only part of
                        the receipt was resold to the client; it must point the same way as the receipt and
                        cannot exceed that amount.
                    </span>
                </label>

                <label className="block space-y-1">
                    <span className="text-xs text-hui-textMuted font-medium uppercase tracking-wider">
                        Phase
                    </span>
                    <select
                        className="hui-input w-full"
                        value={costCodeId}
                        onChange={event => setCostCodeId(event.target.value)}
                    >
                        <option value="">— no phase —</option>
                        {phases.map(phase => (
                            <option key={phase.id} value={phase.id}>
                                {phase.code} — {phase.name}
                            </option>
                        ))}
                    </select>
                    <span className="text-xs text-hui-textMuted">
                        Only this project&apos;s phases. Choosing one marks it as your decision, so no
                        automatic pass will change it.
                    </span>
                </label>

                <div className="flex justify-end gap-2 pt-2">
                    <button type="button" className="hui-btn hui-btn-secondary text-sm" onClick={onClose} disabled={saving}>
                        Cancel
                    </button>
                    <button type="button" className="hui-btn hui-btn-primary text-sm" onClick={save} disabled={saving}>
                        {saving ? "Saving…" : "Save"}
                    </button>
                </div>
            </div>
        </div>
    );
}
