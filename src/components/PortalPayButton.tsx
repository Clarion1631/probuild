"use client";

import { useState } from "react";

export default function PortalPayButton({ paymentScheduleId, invoiceId, amount, label }: { paymentScheduleId: string, invoiceId: string, amount: number, label: string }) {
    const [isLoading, setIsLoading] = useState(false);

    const handlePay = async () => {
        setIsLoading(true);
        try {
            const res = await fetch("/api/payments/create-session", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ paymentScheduleId, invoiceId }),
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
        <button
            onClick={handlePay}
            disabled={isLoading}
            className="flex-shrink-0 w-full sm:w-auto px-4 py-2 bg-hui-primary hover:bg-hui-primaryHover text-white text-sm font-medium rounded-md shadow-sm transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
        >
            {isLoading ? (
                <>
                    <svg className="animate-spin h-4 w-4 text-white" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                    Processing...
                </>
            ) : (
                <>
                    {label} - ${(amount).toLocaleString()}
                </>
            )}
        </button>
    );
}
