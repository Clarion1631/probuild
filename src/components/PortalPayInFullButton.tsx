"use client";

import { useState } from "react";
import { ensureEstimatePayInFullSchedule } from "@/lib/actions";
import { formatCurrency } from "@/lib/utils";

export default function PortalPayInFullButton({
    estimateId,
    displayAmount,
    settings,
}: {
    estimateId: string;
    displayAmount: number;  // display only — authoritative amount comes from server
    settings?: any;
}) {
    const [isLoading, setIsLoading] = useState(false);

    const handlePay = async () => {
        setIsLoading(true);
        try {
            const scheduleId = await ensureEstimatePayInFullSchedule(estimateId);

            const res = await fetch("/api/payments/create-session", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    paymentScheduleId: scheduleId,
                    estimateId,
                    selectedMethod: "card",
                }),
            });

            if (!res.ok) {
                const text = await res.text();
                throw new Error(text || "Payment failed to initiate");
            }

            const { url } = await res.json();
            if (url) {
                window.location.href = url;
            } else {
                throw new Error("No URL returned from Stripe");
            }
        } catch (error: any) {
            console.error(error);
            alert(`Unable to process payment right now:\n\n${error.message || error}`);
            setIsLoading(false);
        }
    };

    return (
        <div className="px-10 pb-8">
            <div className="border border-indigo-200 rounded-lg bg-indigo-50 px-6 py-5 flex flex-wrap items-center justify-between gap-4">
                <div>
                    <p className="text-sm font-semibold text-indigo-900">Ready to pay?</p>
                    <p className="text-xs text-indigo-700 mt-0.5">Secure checkout via Stripe — card or bank transfer accepted.</p>
                </div>
                <div className="flex items-center gap-4">
                    <span className="text-lg font-bold text-indigo-900">{formatCurrency(displayAmount)}</span>
                    <button
                        onClick={handlePay}
                        disabled={isLoading}
                        className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold rounded-lg shadow-sm transition flex items-center gap-2"
                    >
                        {isLoading ? (
                            <>
                                <svg className="animate-spin h-4 w-4 text-white" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                                Connecting to Stripe...
                            </>
                        ) : (
                            "Pay in Full"
                        )}
                    </button>
                </div>
            </div>
        </div>
    );
}
