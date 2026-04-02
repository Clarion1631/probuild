"use client";

import { useState } from "react";
import { saveCompanySettings } from "@/lib/actions";

export default function CompanySettingsClient({ initialData }: { initialData: any }) {
    const [formData, setFormData] = useState({
        companyName: initialData?.companyName || "",
        address: initialData?.address || "",
        phone: initialData?.phone || "",
        email: initialData?.email || "",
        website: initialData?.website || "",
        logoUrl: initialData?.logoUrl || "",
        notificationEmail: initialData?.notificationEmail || "",
        stripeEnabled: initialData?.stripeEnabled || false,
        enableCard: initialData?.enableCard ?? true,
        enableBankTransfer: initialData?.enableBankTransfer || false,
        enableAffirm: initialData?.enableAffirm || false,
        enableKlarna: initialData?.enableKlarna || false,
        passProcessingFee: initialData?.passProcessingFee || false,
        cardProcessingRate: initialData?.cardProcessingRate ?? 2.9,
        cardProcessingFlat: initialData?.cardProcessingFlat ?? 0.30,
    });

    const [isSaving, setIsSaving] = useState(false);
    const [message, setMessage] = useState({ type: "", text: "" });

    const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        const value = e.target.type === 'checkbox' ? (e.target as HTMLInputElement).checked : e.target.value;
        setFormData({ ...formData, [e.target.name]: value });
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setIsSaving(true);
        setMessage({ type: "", text: "" });

        try {
            await saveCompanySettings(formData);
            setMessage({ type: "success", text: "Company settings saved successfully." });
            setTimeout(() => setMessage({ type: "", text: "" }), 3000);
        } catch (error) {
            setMessage({ type: "error", text: "Failed to save settings." });
        } finally {
            setIsSaving(false);
        }
    };

    return (
        <form onSubmit={handleSubmit} className="hui-card flex flex-col">
            <div className="p-6 space-y-8">

                {/* Basic Info */}
                <div>
                    <h2 className="text-lg font-bold text-hui-textMain mb-6 border-b border-hui-border pb-2">Company Name & Contact</h2>
                    <p className="text-sm text-hui-textMuted mb-6">Manage your company's profile information. This data will be used on estimates, invoices, and the customer portal.</p>
                    <div className="space-y-6">
                        <div className="relative">
                            <input
                                required
                                id="companyName"
                                type="text"
                                name="companyName"
                                value={formData.companyName}
                                onChange={handleChange}
                                placeholder="Company Name"
                                className="hui-input peer w-full placeholder-transparent bg-white border border-hui-border rounded-md px-3 pb-2 pt-5 focus:outline-none focus:ring-1 focus:ring-hui-primary focus:border-hui-primary"
                            />
                            <label htmlFor="companyName" className="absolute left-3 -top-2 bg-white px-1 text-xs text-hui-textMuted transition-all peer-placeholder-shown:top-2 peer-placeholder-shown:text-sm peer-focus:-top-2 peer-focus:text-xs pointer-events-none">
                                Company Name *
                            </label>
                        </div>

                        <div className="relative">
                            <textarea
                                id="address"
                                name="address"
                                value={formData.address}
                                onChange={handleChange}
                                rows={2}
                                placeholder="Address"
                                className="hui-input peer w-full placeholder-transparent bg-white border border-hui-border rounded-md px-3 pb-2 pt-5 focus:outline-none focus:ring-1 focus:ring-hui-primary focus:border-hui-primary"
                            />
                            <label htmlFor="address" className="absolute left-3 -top-2 bg-white px-1 text-xs text-hui-textMuted transition-all peer-placeholder-shown:top-2 peer-placeholder-shown:text-sm peer-focus:-top-2 peer-focus:text-xs pointer-events-none">
                                Address
                            </label>
                        </div>

                        <div className="relative">
                            <input
                                id="phone"
                                type="tel"
                                name="phone"
                                value={formData.phone}
                                onChange={handleChange}
                                placeholder="Public Phone"
                                className="hui-input peer w-full placeholder-transparent bg-white border border-hui-border rounded-md px-3 pb-2 pt-5 focus:outline-none focus:ring-1 focus:ring-hui-primary focus:border-hui-primary"
                            />
                            <label htmlFor="phone" className="absolute left-3 -top-2 bg-white px-1 text-xs text-hui-textMuted transition-all peer-placeholder-shown:top-2 peer-placeholder-shown:text-sm peer-focus:-top-2 peer-focus:text-xs pointer-events-none">
                                Public Phone
                            </label>
                        </div>

                        <div className="relative">
                            <input
                                id="email"
                                type="email"
                                name="email"
                                value={formData.email}
                                onChange={handleChange}
                                placeholder="Public Email"
                                className="hui-input peer w-full placeholder-transparent bg-white border border-hui-border rounded-md px-3 pb-2 pt-5 focus:outline-none focus:ring-1 focus:ring-hui-primary focus:border-hui-primary"
                            />
                            <label htmlFor="email" className="absolute left-3 -top-2 bg-white px-1 text-xs text-hui-textMuted transition-all peer-placeholder-shown:top-2 peer-placeholder-shown:text-sm peer-focus:-top-2 peer-focus:text-xs pointer-events-none">
                                Public Email
                            </label>
                        </div>

                        <div className="relative">
                            <input
                                id="website"
                                type="url"
                                name="website"
                                value={formData.website}
                                onChange={handleChange}
                                placeholder="Website URL"
                                className="hui-input peer w-full placeholder-transparent bg-white border border-hui-border rounded-md px-3 pb-2 pt-5 focus:outline-none focus:ring-1 focus:ring-hui-primary focus:border-hui-primary"
                            />
                            <label htmlFor="website" className="absolute left-3 -top-2 bg-white px-1 text-xs text-hui-textMuted transition-all peer-placeholder-shown:top-2 peer-placeholder-shown:text-sm peer-focus:-top-2 peer-focus:text-xs pointer-events-none">
                                Website URL
                            </label>
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-hui-textMuted mb-1">Company Logo</label>
                            {formData.logoUrl && (
                                <div className="mb-3 relative w-32 h-32 border border-hui-border rounded flex items-center justify-center p-2 bg-hui-background">
                                    <img src={formData.logoUrl} alt="Company Logo" className="max-w-full max-h-full object-contain" />
                                    <button
                                        type="button"
                                        onClick={() => setFormData({ ...formData, logoUrl: "" })}
                                        className="absolute -top-2 -right-2 bg-white rounded-full text-slate-400 hover:text-red-500 shadow border border-hui-border p-0.5 transition"
                                    >
                                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                                    </button>
                                </div>
                            )}
                            <input
                                type="file"
                                accept="image/*"
                                onChange={(e) => {
                                    const file = e.target.files?.[0];
                                    if (file) {
                                        const reader = new FileReader();
                                        reader.onloadend = () => {
                                            setFormData({ ...formData, logoUrl: reader.result as string });
                                        };
                                        reader.readAsDataURL(file);
                                    }
                                }}
                                className="block w-full text-sm text-hui-textMuted file:mr-4 file:py-2 file:px-4 file:rounded file:border-0 file:text-sm file:font-semibold file:bg-hui-background file:text-hui-textMain hover:file:bg-slate-200 transition cursor-pointer"
                            />
                            <p className="text-xs text-hui-textMuted mt-1">Select an image to display on estimates and invoices.</p>
                        </div>
                    </div>
                </div>

                {/* Company Details */}
                <div>
                    <h2 className="text-lg font-bold text-hui-textMain mb-6 border-b border-hui-border pb-2">Company Details</h2>
                    <div className="space-y-6">
                        <div className="relative">
                            <input
                                id="bidLimit"
                                type="text"
                                placeholder="Bid Limit"
                                className="hui-input peer w-full placeholder-transparent bg-white border border-hui-border rounded-md px-3 pb-2 pt-5 focus:outline-none focus:ring-1 focus:ring-hui-primary focus:border-hui-primary"
                            />
                            <label htmlFor="bidLimit" className="absolute left-3 -top-2 bg-white px-1 text-xs text-hui-textMuted transition-all peer-placeholder-shown:top-2 peer-placeholder-shown:text-sm peer-focus:-top-2 peer-focus:text-xs pointer-events-none">
                                Bid Limit
                            </label>
                        </div>

                        <div className="relative">
                            <input
                                id="licenseNumber"
                                type="text"
                                placeholder="License Number"
                                className="hui-input peer w-full placeholder-transparent bg-white border border-hui-border rounded-md px-3 pb-2 pt-5 focus:outline-none focus:ring-1 focus:ring-hui-primary focus:border-hui-primary"
                            />
                            <label htmlFor="licenseNumber" className="absolute left-3 -top-2 bg-white px-1 text-xs text-hui-textMuted transition-all peer-placeholder-shown:top-2 peer-placeholder-shown:text-sm peer-focus:-top-2 peer-focus:text-xs pointer-events-none">
                                License Number
                            </label>
                        </div>
                    </div>
                </div>

                {/* Notifications */}
                <div>
                    <h2 className="text-lg font-bold text-hui-textMain mb-6 border-b border-hui-border pb-2">Internal Notifications</h2>
                    <div className="space-y-6">
                        <p className="text-xs text-hui-textMuted mb-2">This email will receive alerts when a client views or signs an estimate.</p>
                        <div className="relative">
                            <input
                                id="notificationEmail"
                                type="email"
                                name="notificationEmail"
                                value={formData.notificationEmail}
                                onChange={handleChange}
                                className="hui-input peer w-full placeholder-transparent bg-white border border-hui-border rounded-md px-3 pb-2 pt-5 focus:outline-none focus:ring-1 focus:ring-hui-primary focus:border-hui-primary"
                            />
                            <label htmlFor="notificationEmail" className="absolute left-3 -top-2 bg-white px-1 text-xs text-hui-textMuted transition-all peer-placeholder-shown:top-2 peer-placeholder-shown:text-sm peer-focus:-top-2 peer-focus:text-xs pointer-events-none">
                                System Notification Email
                            </label>
                        </div>
                    </div>
                </div>

                {/* Stripe Integrations */}
                <div>
                    <div className="flex items-center justify-between mb-6 border-b border-hui-border pb-2">
                        <div>
                            <h2 className="text-lg font-bold text-hui-textMain">Payment Integrations</h2>
                            <p className="text-xs text-hui-textMuted">Enable Stripe to collect payments directly from the client portal.</p>
                        </div>
                        <label className="flex items-center gap-2 cursor-pointer">
                            <span className="text-sm font-medium text-hui-textMain">Enable Stripe</span>
                            <div className="relative inline-block w-10 mr-2 align-middle select-none transition duration-200 ease-in">
                                <input
                                    type="checkbox"
                                    name="stripeEnabled"
                                    id="stripeEnabled"
                                    checked={formData.stripeEnabled}
                                    onChange={handleChange}
                                    className="toggle-checkbox absolute block w-5 h-5 rounded-full bg-white border border-gray-300 appearance-none cursor-pointer transition-transform duration-200 ease-in-out checked:translate-x-full checked:bg-white checked:border-hui-primary"
                                    style={{
                                        WebkitAppearance: 'none',
                                        MozAppearance: 'none'
                                    }}
                                />
                                <label
                                    htmlFor="stripeEnabled"
                                    className={`toggle-label block overflow-hidden h-5 rounded-full cursor-pointer border transition-colors duration-200 ease-in-out ${formData.stripeEnabled ? 'bg-hui-primary border-hui-primary' : 'bg-gray-300 border-gray-300'}`}
                                ></label>
                            </div>
                        </label>
                    </div>
                    
                    {formData.stripeEnabled && (
                        <div className="space-y-4 bg-hui-background border border-hui-border rounded-lg p-6">
                            <p className="text-sm text-hui-textMuted mb-4">Choose which payment methods clients can use. Fees shown are standard rates and may vary based on your Stripe account setup.</p>
                            
                            <div className="flex items-center justify-between py-3 border-b border-hui-border/50">
                                <div>
                                    <p className="text-sm font-semibold text-hui-textMain">Credit & Debit Cards</p>
                                    <p className="text-xs text-hui-textMuted">Standard capability. ~2.9% + 30¢ fee.</p>
                                </div>
                                <input type="checkbox" name="enableCard" checked={formData.enableCard} onChange={handleChange} className="w-4 h-4 text-hui-primary border-gray-300 rounded focus:ring-hui-primary" />
                            </div>

                            <div className="flex items-center justify-between py-3 border-b border-hui-border/50">
                                <div>
                                    <p className="text-sm font-semibold text-hui-textMain">ACH Bank Transfer</p>
                                    <p className="text-xs text-hui-textMuted">Best for large invoices. ~0.8% fee capped at $5.</p>
                                </div>
                                <input type="checkbox" name="enableBankTransfer" checked={formData.enableBankTransfer} onChange={handleChange} className="w-4 h-4 text-hui-primary border-gray-300 rounded focus:ring-hui-primary" />
                            </div>

                            <div className="flex items-center justify-between py-3 border-b border-hui-border/50">
                                <div>
                                    <p className="text-sm font-semibold text-hui-textMain">Affirm (Buy Now Pay Later)</p>
                                    <p className="text-xs text-hui-textMuted">Help clients finance. Fees absorbed by merchant (~3-5%).</p>
                                </div>
                                <input type="checkbox" name="enableAffirm" checked={formData.enableAffirm} onChange={handleChange} className="w-4 h-4 text-hui-primary border-gray-300 rounded focus:ring-hui-primary" />
                            </div>

                            <div className="flex items-center justify-between py-3">
                                <div>
                                    <p className="text-sm font-semibold text-hui-textMain">Klarna</p>
                                    <p className="text-xs text-hui-textMuted">Pay in 4 installments. Fees absorbed by merchant (~3-5%).</p>
                                </div>
                                <input type="checkbox" name="enableKlarna" checked={formData.enableKlarna} onChange={handleChange} className="w-4 h-4 text-hui-primary border-gray-300 rounded focus:ring-hui-primary" />
                            </div>

                            <div className="mt-4 pt-4 border-t border-hui-border/50 flex justify-end">
                                <a href="https://dashboard.stripe.com/" target="_blank" rel="noopener noreferrer" className="text-xs text-blue-600 hover:underline flex items-center gap-1">
                                    Manage Stripe Dashboard <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                                </a>
                            </div>
                        </div>
                    )}
                </div>

                {/* Payment Processing Fees */}
                {formData.stripeEnabled && (
                    <div>
                        <div className="flex items-center justify-between mb-6 border-b border-hui-border pb-2">
                            <div>
                                <h2 className="text-lg font-bold text-hui-textMain">Payment Processing Fees</h2>
                                <p className="text-xs text-hui-textMuted">Choose who pays the processing fees for online card payments.</p>
                            </div>
                        </div>

                        <div className="space-y-6">
                            <label className="flex items-start gap-3 cursor-pointer p-4 border border-hui-border rounded-lg bg-white hover:bg-slate-50 transition">
                                <input
                                    type="radio"
                                    name="passProcessingFee"
                                    checked={!formData.passProcessingFee}
                                    onChange={() => setFormData({ ...formData, passProcessingFee: false })}
                                    className="w-4 h-4 text-hui-primary border-gray-300 mt-1 focus:ring-hui-primary"
                                />
                                <div>
                                    <span className="block text-sm font-semibold text-hui-textMain">Deduct fee from my payout</span>
                                    <span className="block text-xs text-hui-textMuted mt-1">The client pays the exact invoice amount. Stripe deducts fees before depositing to your bank.</span>
                                </div>
                            </label>

                            <div className={`p-4 border rounded-lg transition-colors ${formData.passProcessingFee ? 'border-hui-primary bg-blue-50/30' : 'border-hui-border bg-white hover:bg-slate-50'}`}>
                                <label className="flex items-start gap-3 cursor-pointer w-full">
                                    <input
                                        type="radio"
                                        name="passProcessingFee"
                                        checked={formData.passProcessingFee}
                                        onChange={() => setFormData({ ...formData, passProcessingFee: true })}
                                        className="w-4 h-4 text-hui-primary border-gray-300 mt-1 focus:ring-hui-primary"
                                    />
                                    <div className="flex-1">
                                        <span className="block text-sm font-semibold text-hui-textMain">Client pays the processing fee (Recommended)</span>
                                        <span className="block text-xs text-hui-textMuted mt-1">A separate "Processing Fee" line item is added when the client chooses to pay by Credit Card. (Bank transfers remain free).</span>
                                        
                                        {formData.passProcessingFee && (
                                            <div className="mt-4 pt-4 border-t border-blue-100 flex items-center gap-4">
                                                <div className="flex items-center gap-2">
                                                    <span className="text-sm font-medium text-hui-textMain">Card Rate:</span>
                                                    <div className="relative w-24">
                                                        <input
                                                            type="number"
                                                            step="0.01"
                                                            name="cardProcessingRate"
                                                            value={formData.cardProcessingRate}
                                                            onChange={handleChange}
                                                            className="hui-input w-full pr-6 text-right"
                                                        />
                                                        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-sm text-hui-textMuted">%</span>
                                                    </div>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                </label>
                            </div>
                        </div>
                    </div>
                )}

            </div>

            <div className="bg-hui-background px-6 py-4 border-t border-hui-border flex items-center justify-between">
                <div>
                    {message.text && (
                        <span className={`text-sm ${message.type === 'error' ? 'text-red-600' : 'text-green-600'}`}>
                            {message.text}
                        </span>
                    )}
                </div>
                <button
                    type="submit"
                    disabled={isSaving}
                    className="hui-btn hui-btn-primary disabled:opacity-50"
                >
                    {isSaving ? "Saving..." : "Save Settings"}
                </button>
            </div>
        </form>
    );
}
