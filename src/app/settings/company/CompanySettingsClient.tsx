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
        <form onSubmit={handleSubmit} className="bg-white rounded-lg shadow-sm border border-slate-200 overflow-hidden">
            <div className="p-6 space-y-6">

                {/* Basic Info */}
                <div>
                    <h2 className="text-lg font-medium text-slate-800 mb-4 border-b border-slate-100 pb-2">Basic Information</h2>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <div className="col-span-2">
                            <label className="block text-sm font-medium text-slate-700 mb-1">Company Name *</label>
                            <input
                                required
                                type="text"
                                name="companyName"
                                value={formData.companyName}
                                onChange={handleChange}
                                className="w-full border border-slate-300 rounded-md px-3 py-2 text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                            />
                        </div>

                        <div className="col-span-2">
                            <label className="block text-sm font-medium text-slate-700 mb-1">Address</label>
                            <textarea
                                name="address"
                                value={formData.address}
                                onChange={handleChange}
                                rows={2}
                                className="w-full border border-slate-300 rounded-md px-3 py-2 text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                            />
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-slate-700 mb-1">Public Phone</label>
                            <input
                                type="tel"
                                name="phone"
                                value={formData.phone}
                                onChange={handleChange}
                                className="w-full border border-slate-300 rounded-md px-3 py-2 text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                            />
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-slate-700 mb-1">Public Email</label>
                            <input
                                type="email"
                                name="email"
                                value={formData.email}
                                onChange={handleChange}
                                className="w-full border border-slate-300 rounded-md px-3 py-2 text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                            />
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-slate-700 mb-1">Website URL</label>
                            <input
                                type="url"
                                name="website"
                                value={formData.website}
                                onChange={handleChange}
                                placeholder="https://..."
                                className="w-full border border-slate-300 rounded-md px-3 py-2 text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                            />
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-slate-700 mb-1">Company Logo</label>
                            {formData.logoUrl && (
                                <div className="mb-3 relative w-32 h-32 border border-slate-200 rounded flex items-center justify-center p-2 bg-slate-50">
                                    <img src={formData.logoUrl} alt="Company Logo" className="max-w-full max-h-full object-contain" />
                                    <button
                                        type="button"
                                        onClick={() => setFormData({ ...formData, logoUrl: "" })}
                                        className="absolute -top-2 -right-2 bg-white rounded-full text-slate-400 hover:text-red-500 shadow border border-slate-100 p-0.5 transition"
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
                                className="block w-full text-sm text-slate-500 file:mr-4 file:py-2 file:px-4 file:rounded file:border-0 file:text-sm file:font-semibold file:bg-slate-50 file:text-slate-700 hover:file:bg-slate-100 transition cursor-pointer"
                            />
                            <p className="text-xs text-slate-500 mt-1">Select an image to display on estimates and invoices.</p>
                        </div>
                    </div>
                </div>

                {/* Notifications */}
                <div className="pt-2">
                    <h2 className="text-lg font-medium text-slate-800 mb-4 border-b border-slate-100 pb-2">Internal Notifications</h2>
                    <div>
                        <label className="block text-sm font-medium text-slate-700 mb-1">System Notification Email</label>
                        <p className="text-xs text-slate-500 mb-2">This email will receive alerts when a client views or signs an estimate.</p>
                        <input
                            type="email"
                            name="notificationEmail"
                            value={formData.notificationEmail}
                            onChange={handleChange}
                            placeholder="admin@mycompany.com"
                            className="w-full md:w-1/2 border border-slate-300 rounded-md px-3 py-2 text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                    </div>
                </div>

            </div>

            <div className="bg-slate-50 px-6 py-4 border-t border-slate-200 flex items-center justify-between">
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
                    className="px-6 py-2 bg-blue-600 text-white font-medium rounded-md shadow-sm hover:bg-blue-700 transition disabled:opacity-50"
                >
                    {isSaving ? "Saving..." : "Save Settings"}
                </button>
            </div>
        </form>
    );
}
