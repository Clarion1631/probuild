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
    });

    const [isSaving, setIsSaving] = useState(false);
    const [message, setMessage] = useState({ type: "", text: "" });

    const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        setFormData({ ...formData, [e.target.name]: e.target.value });
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
                                className="hui-input peer w-full placeholder-transparent bg-white"
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
                                className="hui-input peer w-full placeholder-transparent bg-white"
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
                                className="hui-input peer w-full placeholder-transparent bg-white"
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
                                className="hui-input peer w-full placeholder-transparent bg-white"
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
                                className="hui-input peer w-full placeholder-transparent bg-white"
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
                                className="hui-input peer w-full placeholder-transparent bg-white"
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
                                className="hui-input peer w-full placeholder-transparent bg-white"
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
                                placeholder="System Notification Email"
                                className="hui-input peer w-full placeholder-transparent bg-white"
                            />
                            <label htmlFor="notificationEmail" className="absolute left-3 -top-2 bg-white px-1 text-xs text-hui-textMuted transition-all peer-placeholder-shown:top-2 peer-placeholder-shown:text-sm peer-focus:-top-2 peer-focus:text-xs pointer-events-none">
                                System Notification Email
                            </label>
                        </div>
                    </div>
                </div>

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
