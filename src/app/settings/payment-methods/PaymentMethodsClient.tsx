"use client";
import { useState, useTransition } from "react";
import { saveCompanySettings } from "@/lib/actions";
import { toast } from "sonner";

const PAYMENT_METHODS = [
    {
        key: "enableCard",
        label: "Credit & Debit Cards",
        description: "Visa, Mastercard, Amex. Standard rate: 2.9% + 30¢",
        icon: "💳",
    },
    {
        key: "enableBankTransfer",
        label: "Bank Transfer (ACH)",
        description: "Best for large invoices. ~0.8% fee capped at $5.",
        icon: "🏦",
    },
    {
        key: "enableAffirm",
        label: "Affirm (Buy Now, Pay Later)",
        description: "Clients pay in installments. You get paid upfront.",
        icon: "📅",
    },
    {
        key: "enableKlarna",
        label: "Klarna",
        description: "Flexible payment options for clients.",
        icon: "🌸",
    },
];

export default function PaymentMethodsClient({ initialSettings }: { initialSettings: any }) {
    const [data, setData] = useState({
        stripeEnabled: initialSettings?.stripeEnabled ?? false,
        enableCard: initialSettings?.enableCard ?? true,
        enableBankTransfer: initialSettings?.enableBankTransfer ?? false,
        enableAffirm: initialSettings?.enableAffirm ?? false,
        enableKlarna: initialSettings?.enableKlarna ?? false,
        passProcessingFee: initialSettings?.passProcessingFee ?? false,
        cardProcessingRate: initialSettings?.cardProcessingRate ?? 2.9,
        cardProcessingFlat: initialSettings?.cardProcessingFlat ?? 0.30,
    });
    const [isPending, startTransition] = useTransition();

    const handleSave = () => {
        startTransition(async () => {
            try {
                await saveCompanySettings(data as any);
                toast.success("Payment settings saved");
            } catch {
                toast.error("Failed to save settings");
            }
        });
    };

    return (
        <div className="space-y-6">
            {/* Stripe Enable */}
            <div className="hui-card p-6">
                <div className="flex items-start justify-between gap-4">
                    <div>
                        <h2 className="text-base font-semibold text-hui-textMain">Stripe Integration</h2>
                        <p className="text-sm text-hui-textMuted mt-0.5">Enable Stripe to collect payments directly from the client portal.</p>
                    </div>
                    <button
                        type="button"
                        role="switch"
                        aria-checked={data.stripeEnabled}
                        onClick={() => setData(prev => ({ ...prev, stripeEnabled: !prev.stripeEnabled }))}
                        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-hui-primary focus:ring-offset-2 ${data.stripeEnabled ? "bg-hui-primary" : "bg-slate-300"}`}
                    >
                        <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform ${data.stripeEnabled ? "translate-x-6" : "translate-x-1"}`} />
                    </button>
                </div>
                {data.stripeEnabled && (
                    <a href="https://dashboard.stripe.com/" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 mt-3 text-xs text-blue-600 hover:underline">
                        Open Stripe Dashboard
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                    </a>
                )}
            </div>

            {/* Payment Methods */}
            {data.stripeEnabled && (
                <div className="hui-card p-6">
                    <h2 className="text-base font-semibold text-hui-textMain mb-1">Accepted Payment Methods</h2>
                    <p className="text-sm text-hui-textMuted mb-4">Choose which payment methods clients can use.</p>
                    <div className="divide-y divide-hui-border">
                        {PAYMENT_METHODS.map((method) => (
                            <label key={method.key} className="flex items-center justify-between py-3 cursor-pointer">
                                <div className="flex items-center gap-3">
                                    <span className="text-xl">{method.icon}</span>
                                    <div>
                                        <div className="text-sm font-medium text-hui-textMain">{method.label}</div>
                                        <div className="text-xs text-hui-textMuted">{method.description}</div>
                                    </div>
                                </div>
                                <button
                                    type="button"
                                    role="switch"
                                    aria-checked={!!data[method.key as keyof typeof data]}
                                    onClick={() => setData(prev => ({ ...prev, [method.key]: !prev[method.key as keyof typeof prev] }))}
                                    className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-hui-primary focus:ring-offset-2 ${data[method.key as keyof typeof data] ? "bg-hui-primary" : "bg-slate-300"}`}
                                >
                                    <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform ${data[method.key as keyof typeof data] ? "translate-x-6" : "translate-x-1"}`} />
                                </button>
                            </label>
                        ))}
                    </div>
                </div>
            )}

            {/* Processing Fees */}
            {data.stripeEnabled && (
                <div className="hui-card p-6">
                    <h2 className="text-base font-semibold text-hui-textMain mb-1">Processing Fees</h2>
                    <p className="text-sm text-hui-textMuted mb-4">Choose who pays the card processing fee.</p>
                    <div className="space-y-3">
                        <label className="flex items-start gap-3 p-3 rounded-lg border border-hui-border cursor-pointer hover:bg-slate-50">
                            <input type="radio" name="feeMode" checked={!data.passProcessingFee} onChange={() => setData(prev => ({ ...prev, passProcessingFee: false }))} className="mt-0.5" />
                            <div>
                                <div className="text-sm font-medium text-hui-textMain">Deduct fee from my payout</div>
                                <div className="text-xs text-hui-textMuted mt-0.5">Client pays the exact invoice amount. Stripe deducts fees before depositing to your bank.</div>
                            </div>
                        </label>
                        <label className="flex items-start gap-3 p-3 rounded-lg border border-hui-border cursor-pointer hover:bg-slate-50">
                            <input type="radio" name="feeMode" checked={data.passProcessingFee} onChange={() => setData(prev => ({ ...prev, passProcessingFee: true }))} className="mt-0.5" />
                            <div>
                                <div className="text-sm font-medium text-hui-textMain">Client pays the processing fee (Recommended)</div>
                                <div className="text-xs text-hui-textMuted mt-0.5">A "Processing Fee" line item is added when the client pays by card.</div>
                                {data.passProcessingFee && (
                                    <div className="flex items-center gap-3 mt-3">
                                        <div className="flex flex-col gap-1">
                                            <label className="text-xs text-hui-textMuted">Card Rate (%)</label>
                                            <input type="number" step="0.1" min="0" max="10" value={data.cardProcessingRate} onChange={e => setData(prev => ({ ...prev, cardProcessingRate: parseFloat(e.target.value) }))} className="hui-input w-24 text-sm py-1" />
                                        </div>
                                        <div className="flex flex-col gap-1">
                                            <label className="text-xs text-hui-textMuted">Flat Fee ($)</label>
                                            <input type="number" step="0.01" min="0" value={data.cardProcessingFlat} onChange={e => setData(prev => ({ ...prev, cardProcessingFlat: parseFloat(e.target.value) }))} className="hui-input w-24 text-sm py-1" />
                                        </div>
                                    </div>
                                )}
                            </div>
                        </label>
                    </div>
                </div>
            )}

            <button onClick={handleSave} disabled={isPending} className="hui-btn hui-btn-primary">
                {isPending ? "Saving..." : "Save Payment Settings"}
            </button>
        </div>
    );
}
