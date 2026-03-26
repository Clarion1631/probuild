"use client";

import { useState } from "react";

export default function PortalPayButton({ 
    paymentScheduleId, 
    invoiceId, 
    amount, 
    label,
    settings 
}: { 
    paymentScheduleId: string, 
    invoiceId: string, 
    amount: number, 
    label: string,
    settings?: any
}) {
    const [isLoading, setIsLoading] = useState(false);
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [selectedMethod, setSelectedMethod] = useState<string>("card");

    // Fee calculations
    const passFee = settings?.passProcessingFee === true;
    const rate = settings?.cardProcessingRate ?? 2.9;
    const flat = settings?.cardProcessingFlat ?? 0.30;
    
    // Add processing fee if passFee is true and they select a method that adds fees (cards, affirm, klarna all act like cards here for fees)
    const isFeeMethod = selectedMethod !== 'us_bank_account';
    const feeAmount = (passFee && isFeeMethod) ? ((amount * (rate / 100)) + flat) : 0;
    const totalAmount = amount + feeAmount;

    // Default to card initially, or whatever is enabled
    // Only one method might be enabled, handle that if necessary.

    const handlePay = async (method: string) => {
        setIsLoading(true);
        try {
            const res = await fetch("/api/payments/create-session", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ 
                    paymentScheduleId, 
                    invoiceId,
                    selectedMethod: method
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

    const handleButtonClick = () => {
        // If settings aren't provided or only one method or no pass fee, we could skip.
        // But let's show the modal if multiple methods OR fees are involved.
        if (!settings || (!settings.enableBankTransfer && !settings.enableAffirm && !settings.enableKlarna && !settings.passProcessingFee)) {
            // Just go straight to card checkout if nothing else is configured
            handlePay("card");
        } else {
            setIsModalOpen(true);
        }
    };

    return (
        <>
            <button
                onClick={handleButtonClick}
                className="flex-shrink-0 w-full sm:w-auto px-4 py-2 bg-hui-primary hover:bg-hui-primaryHover text-white text-sm font-medium rounded-md shadow-sm transition-colors flex items-center justify-center gap-2"
            >
                {label} - ${(amount).toLocaleString()}
            </button>

            {isModalOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
                    <div className="bg-white rounded-xl shadow-2xl w-full max-w-md overflow-hidden flex flex-col animate-in zoom-in-95 duration-200">
                        <div className="p-6 border-b border-gray-100 flex items-center justify-between">
                            <h3 className="text-xl font-bold text-hui-textMain">Choose Payment Method</h3>
                            <button onClick={() => !isLoading && setIsModalOpen(false)} className="text-gray-400 hover:text-gray-600 transition">
                                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                            </button>
                        </div>
                        
                        <div className="p-6 space-y-4">
                            {settings?.enableCard !== false && (
                                <label className={`flex items-start gap-3 p-4 border rounded-lg cursor-pointer transition-all ${selectedMethod === 'card' ? 'border-hui-primary bg-hui-primary/5 ring-1 ring-hui-primary' : 'border-gray-200 hover:border-gray-300 bg-white'}`}>
                                    <input type="radio" name="payment_method" value="card" checked={selectedMethod === 'card'} onChange={() => setSelectedMethod('card')} className="mt-1 w-4 h-4 text-hui-primary focus:ring-hui-primary" />
                                    <div className="flex-1">
                                        <div className="flex justify-between items-center mb-1">
                                            <span className="font-semibold text-gray-900">Credit / Debit Card</span>
                                            <div className="flex gap-1">
                                                <svg className="h-5" viewBox="0 0 38 24" fill="none"><rect width="38" height="24" rx="4" fill="#1434CB"/><path d="M14.63 7.846l-1.397 8.35h-2.288l1.4-8.35h2.285zm9.58 8.125c-1.126.04-2.197-.246-2.9-.68l.3-1.636c.642.348 1.442.585 2.194.595.698 0 1.056-.25 1.056-.708 0-.422-.432-.61-1.378-1.01-1.258-.51-1.78-.962-1.78-1.95 0-.96.862-2.022 2.766-2.022.956.01 1.764.195 2.302.433l-.32 1.638c-.463-.207-1.137-.414-1.848-.423-.623 0-1.026.248-1.026.68 0 .445.498.6 1.444 1.034 1.18.528 1.708 1.01 1.708 1.966 0 1.144-.99 1.996-2.52 2.05h.002zM32.89 7.848l-2.094 5.92-.355-1.57c-.432-1.554-1.758-3.08-3.136-3.877l2.008 7.874h2.428l3.636-8.347h-2.486zm-16.733 0l-1.777 5.76-1.536-4.904c-.168-.696-.65-.845-1.178-.856h-4.305v.232c.866.195 1.75.514 2.307.822l2.67 7.294h2.417l3.83-8.35h-2.428z" fill="#fff"/></svg>
                                            </div>
                                        </div>
                                        {passFee ? (
                                            <p className="text-xs text-gray-500">Includes a {rate}% + ${flat.toFixed(2)} processing fee.</p>
                                        ) : (
                                            <p className="text-xs text-gray-500">Pay securely with any major card.</p>
                                        )}
                                    </div>
                                </label>
                            )}

                            {settings?.enableBankTransfer && (
                                <label className={`flex items-start gap-3 p-4 border rounded-lg cursor-pointer transition-all ${selectedMethod === 'us_bank_account' ? 'border-hui-primary bg-hui-primary/5 ring-1 ring-hui-primary' : 'border-gray-200 hover:border-gray-300 bg-white'}`}>
                                    <input type="radio" name="payment_method" value="us_bank_account" checked={selectedMethod === 'us_bank_account'} onChange={() => setSelectedMethod('us_bank_account')} className="mt-1 w-4 h-4 text-hui-primary focus:ring-hui-primary" />
                                    <div className="flex-1">
                                        <div className="flex justify-between items-center mb-1">
                                            <span className="font-semibold text-gray-900">ACH Bank Transfer</span>
                                            <svg className="w-5 h-5 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" /></svg>
                                        </div>
                                        {passFee ? (
                                            <p className="text-xs text-green-600 font-medium">Free — Avoid processing fees!</p>
                                        ) : (
                                            <p className="text-xs text-gray-500">Direct, secure bank transfer.</p>
                                        )}
                                    </div>
                                </label>
                            )}

                            {/* Additional methods like Affirm/Klarna can be added here if needed */}
                        </div>

                        <div className="bg-gray-50 p-6 space-y-3">
                            <div className="flex justify-between text-sm text-gray-600">
                                <span>Milestone Amount</span>
                                <span>${amount.toFixed(2)}</span>
                            </div>
                            {passFee && isFeeMethod && (
                                <div className="flex justify-between text-sm text-gray-600 border-b border-gray-200 pb-3">
                                    <span>Processing Fee ({rate}%)</span>
                                    <span>${feeAmount.toFixed(2)}</span>
                                </div>
                            )}
                            <div className="flex justify-between text-lg font-bold text-gray-900 pt-1">
                                <span>Total to Pay</span>
                                <span>${totalAmount.toFixed(2)}</span>
                            </div>

                            <button
                                onClick={() => handlePay(selectedMethod)}
                                disabled={isLoading}
                                className="w-full mt-4 bg-hui-primary hover:bg-hui-primaryHover text-white py-3 rounded-lg font-bold transition flex items-center justify-center gap-2"
                            >
                                {isLoading ? (
                                    <>
                                        <svg className="animate-spin h-5 w-5 text-white" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                                        Connecting securely to Stripe...
                                    </>
                                ) : (
                                    `Continue to Checkout`
                                )}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}
