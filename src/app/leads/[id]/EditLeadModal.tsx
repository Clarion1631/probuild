import { useState } from "react";
import { updateLeadInfo } from "@/lib/actions";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import GoogleMapsAutocomplete from "@/components/GoogleMapsAutocomplete";

export default function EditLeadModal({ isOpen, onClose, lead, client }: { isOpen: boolean, onClose: () => void, lead: any, client: any }) {
    const router = useRouter();
    const [saving, setSaving] = useState(false);

    // Initial state based on lead and client props
    const [formData, setFormData] = useState({
        name: lead.name || "",
        clientName: client?.name || "",
        location: lead.location || "",
        source: lead.source || "Manually created lead",
        stage: lead.stage || "New",
        tags: lead.tags || "",
        targetRevenue: lead.targetRevenue || "",
        expectedProfit: lead.expectedProfit || "",
        projectType: lead.projectType || "",
        expectedStartDate: lead.expectedStartDate ? new Date(lead.expectedStartDate).toISOString().split('T')[0] : "",
        message: lead.message || "",
        // Adding dummy payment fields to mimic the UI screenshot functionality
        acceptCreditCard: true,
        acceptBankTransfer: true,
        acceptBNPL: false
    });

    if (!isOpen) return null;

    const handleChange = (e: any) => {
        const { name, value, type, checked } = e.target;
        setFormData(prev => ({
            ...prev,
            [name]: type === "checkbox" ? checked : value
        }));
    };

    const handleSave = async () => {
        setSaving(true);
        try {
            await updateLeadInfo(lead.id, formData);
            toast.success("Lead updated successfully!");
            router.refresh();
            onClose();
        } catch (error: any) {
            toast.error(error.message || "Failed to update lead");
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
            <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col">
                <div className="p-6 border-b border-slate-100 flex items-center justify-between">
                    <h2 className="text-xl font-bold text-slate-800">Edit Lead</h2>
                    <button onClick={onClose} className="text-slate-400 hover:text-slate-600 transition">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto p-6 space-y-6">
                    {/* Top Section */}
                    <div className="space-y-4">
                        <div className="relative">
                            <label className="absolute -top-2 left-3 bg-white px-1 text-[11px] font-semibold text-slate-500">Lead Name *</label>
                            <input name="name" value={formData.name} onChange={handleChange} className="w-full border border-slate-300 rounded-lg px-4 py-2.5 text-sm outline-none focus:border-slate-800 transition" />
                        </div>
                        <div className="relative mt-4">
                            <label className="absolute -top-2 left-3 bg-white px-1 text-[11px] font-semibold text-slate-500">Client Name *</label>
                            <input name="clientName" value={formData.clientName} onChange={handleChange} className="w-full border border-slate-300 rounded-lg px-4 py-2.5 text-sm outline-none focus:border-slate-800 transition" />
                        </div>
                    </div>

                    {/* Read-only Client Details Box */}
                    <div className="bg-[#f9f8f6] rounded-lg p-5">
                        <h3 className="text-sm font-bold text-slate-800 mb-4">Client Details</h3>
                        <div className="grid grid-cols-2 gap-4 mb-4">
                            <div>
                                <label className="text-xs text-slate-500 block mb-1">Email Address</label>
                                <div className="text-sm text-slate-800">{client?.email || "-"}</div>
                            </div>
                            <div>
                                <label className="text-xs text-slate-500 block mb-1">Primary Phone Number</label>
                                <div className="text-sm text-slate-800">{client?.primaryPhone || "-"}</div>
                            </div>
                        </div>
                        <div>
                            <label className="text-xs text-slate-500 block mb-1">Address</label>
                            <div className="text-sm text-slate-800">{client?.addressLine1 ? `${client.addressLine1}, ${client.city || ''}, ${client.state || ''}` : "-"}</div>
                        </div>
                    </div>

                    {/* Middle Section */}
                    <div className="space-y-4">
                        <div className="relative">
                            <label className="absolute -top-2 left-3 bg-white px-1 text-[11px] font-semibold text-slate-500 z-10">Lead Address</label>
                            <GoogleMapsAutocomplete 
                                value={formData.location} 
                                onChange={(val) => setFormData(p => ({ ...p, location: val }))}
                                className="w-full border border-slate-300 rounded-lg px-4 py-2.5 text-sm outline-none focus:border-slate-800 transition" 
                            />
                        </div>

                        <div className="grid grid-cols-2 gap-4 pt-2">
                            <div className="relative">
                                <label className="absolute -top-2 left-3 bg-white px-1 text-[11px] font-semibold text-slate-500">Lead Source</label>
                                <select name="source" value={formData.source} onChange={handleChange} className="w-full border border-slate-300 rounded-lg px-4 py-2.5 text-sm outline-none focus:border-slate-800 transition appearance-none bg-transparent">
                                    <option value="Manually created lead">Manually created lead</option>
                                    <option value="My website">My website</option>
                                    <option value="Client referral">Client referral</option>
                                    <option value="Houzz">Houzz</option>
                                </select>
                            </div>
                            <div className="relative">
                                <label className="absolute -top-2 left-3 bg-white px-1 text-[11px] font-semibold text-slate-500">Lead Stage</label>
                                <select name="stage" value={formData.stage} onChange={handleChange} className="w-full border border-slate-300 rounded-lg px-4 py-2.5 text-sm outline-none focus:border-slate-800 transition appearance-none bg-transparent">
                                    <option value="New">New</option>
                                    <option value="Followed Up">Followed Up</option>
                                    <option value="Connected">Connected</option>
                                    <option value="Meeting Scheduled">Meeting Scheduled</option>
                                    <option value="Estimate Sent">Estimate Sent</option>
                                    <option value="Won">Won</option>
                                    <option value="Closed">Closed</option>
                                </select>
                            </div>
                        </div>

                        <div className="pt-2">
                            <input name="tags" value={formData.tags} onChange={handleChange} placeholder="Add Tags" className="w-full border border-slate-300 rounded-lg px-4 py-2.5 text-sm outline-none focus:border-slate-800 transition" />
                        </div>

                        <div className="grid grid-cols-2 gap-4 pt-2">
                            <input name="targetRevenue" value={formData.targetRevenue} onChange={handleChange} placeholder="Estimated Revenue" type="number" className="w-full border border-slate-300 rounded-lg px-4 py-2.5 text-sm outline-none focus:border-slate-800 transition" />
                            <input name="expectedProfit" value={formData.expectedProfit} onChange={handleChange} placeholder="Estimated Profit" type="number" className="w-full border border-slate-300 rounded-lg px-4 py-2.5 text-sm outline-none focus:border-slate-800 transition" />
                        </div>

                        <div className="grid grid-cols-2 gap-4 pt-2">
                            <input placeholder="Estimated Budget" className="w-full border border-slate-300 rounded-lg px-4 py-2.5 text-sm outline-none focus:border-slate-800 transition" />
                            <div className="relative">
                                <select name="projectType" value={formData.projectType} onChange={handleChange} className="w-full border border-slate-300 rounded-lg px-4 py-2.5 text-sm outline-none focus:border-slate-800 transition appearance-none bg-transparent text-slate-500">
                                    <option value="">Project Type</option>
                                    <option value="Kitchen Remodeling">Kitchen Remodeling</option>
                                    <option value="Bathroom Remodeling">Bathroom Remodeling</option>
                                    <option value="Full Home">Full Home</option>
                                </select>
                            </div>
                        </div>

                        <div className="pt-2">
                            <input type="date" name="expectedStartDate" value={formData.expectedStartDate} onChange={handleChange} className="w-1/2 border border-slate-300 rounded-lg px-4 py-2.5 text-sm outline-none focus:border-slate-800 transition text-slate-500" />
                        </div>

                        <div className="pt-2">
                            <textarea name="message" value={formData.message} onChange={handleChange} rows={3} placeholder="Description" className="w-full border border-slate-300 rounded-lg px-4 py-2.5 text-sm outline-none focus:border-slate-800 transition resize-none"></textarea>
                        </div>
                    </div>

                    {/* Payment Settings Simulator */}
                    <div className="pt-4 border-t border-slate-100">
                        <button className="flex items-center justify-between w-full pb-4 shrink-0 text-slate-800 font-bold">
                            Payment Methods
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 9l6 6 6-6"/></svg>
                        </button>
                        
                        <div className="space-y-4">
                            <div className="flex items-center justify-between p-4 border border-slate-200 rounded-lg">
                                <div className="flex gap-4 items-center">
                                    <div className="w-10 h-10 bg-[#f4ebd0] text-[#8e815b] rounded flex items-center justify-center shrink-0">
                                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="5" width="20" height="14" rx="2" ry="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>
                                    </div>
                                    <div>
                                        <div className="font-bold text-sm text-slate-800">Credit or Debit Card</div>
                                        <div className="text-xs text-slate-500">3% transaction fee, 0.5% platform fee</div>
                                    </div>
                                </div>
                                <div className="flex items-center gap-3">
                                    <div className={`w-11 h-6 flex items-center rounded-full p-1 cursor-pointer transition-colors ${formData.acceptCreditCard ? 'bg-slate-800' : 'bg-slate-300'}`} onClick={() => setFormData(p => ({...p, acceptCreditCard: !p.acceptCreditCard}))}>
                                        <div className={`bg-white w-4 h-4 rounded-full shadow-md transform transition-transform ${formData.acceptCreditCard ? 'translate-x-5' : ''}`} />
                                    </div>
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 9l6 6 6-6"/></svg>
                                </div>
                            </div>
                            
                            <div className="flex items-center justify-between p-4 border border-slate-200 rounded-lg">
                                <div className="flex gap-4 items-center">
                                    <div className="w-10 h-10 bg-[#f4ebd0] text-[#8e815b] rounded flex items-center justify-center shrink-0">
                                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="4" y="4" width="16" height="16" rx="2"/><line x1="4" y1="10" x2="20" y2="10"/><line x1="12" y1="14" x2="12" y2="20"/></svg>
                                    </div>
                                    <div>
                                        <div className="font-bold text-sm text-slate-800">Bank Transfer</div>
                                        <div className="text-xs text-slate-500">0.6% transaction fee, 0.4% platform fee • <span className="text-green-600 font-medium">Capped at $100.00 ✓</span></div>
                                    </div>
                                </div>
                                <div className="flex items-center gap-3">
                                    <div className={`w-11 h-6 flex items-center rounded-full p-1 cursor-pointer transition-colors ${formData.acceptBankTransfer ? 'bg-slate-800' : 'bg-slate-300'}`} onClick={() => setFormData(p => ({...p, acceptBankTransfer: !p.acceptBankTransfer}))}>
                                        <div className={`bg-white w-4 h-4 rounded-full shadow-md transform transition-transform ${formData.acceptBankTransfer ? 'translate-x-5' : ''}`} />
                                    </div>
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 9l6 6 6-6"/></svg>
                                </div>
                            </div>

                        </div>
                    </div>
                </div>

                <div className="p-4 border-t border-slate-100 flex justify-end gap-3 bg-white rounded-b-xl shrink-0">
                    <button onClick={onClose} className="px-5 py-2 text-sm font-semibold text-slate-800 hover:bg-slate-100 rounded-lg transition">Cancel</button>
                    <button onClick={handleSave} disabled={saving} className="px-6 py-2 text-sm font-bold text-white bg-slate-800 hover:bg-slate-900 rounded-lg shadow-sm transition disabled:opacity-50">
                        {saving ? "Saving..." : "Save"}
                    </button>
                </div>
            </div>
        </div>
    );
}
