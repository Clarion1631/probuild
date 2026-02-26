"use client";

import { useState, useEffect } from "react";

type Client = {
    id: string;
    name: string;
    initials: string;
    email: string | null;
    companyName: string | null;
    primaryPhone: string | null;
    additionalEmail: string | null;
    additionalPhone: string | null;
    addressLine1: string | null;
    addressLine2: string | null;
    city: string | null;
    state: string | null;
    zipCode: string | null;
    country: string | null;
    internalNotes: string | null;
    projects?: { id: string; name: string; status: string; viewedAt: string; }[];
    leads?: { id: string; name: string; stage: string; targetRevenue: number | null; }[];
};

export default function ClientsPage() {
    const [clients, setClients] = useState<Client[]>([]);
    const [loading, setLoading] = useState(true);

    // Modal states
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [editingClient, setEditingClient] = useState<Client | null>(null);
    const [formData, setFormData] = useState<Partial<Client>>({});
    const [activeTab, setActiveTab] = useState<'details' | 'projects' | 'leads'>('details');

    const [isSaving, setIsSaving] = useState(false);

    useEffect(() => {
        fetchClients();
    }, []);

    async function fetchClients() {
        try {
            const res = await fetch('/api/clients');
            if (res.ok) {
                const data = await res.json();
                setClients(data);
            }
        } catch (error) {
            console.error("Failed to fetch clients", error);
        } finally {
            setLoading(false);
        }
    }

    const handleOpenAddModal = () => {
        setEditingClient(null);
        setFormData({});
        setActiveTab('details');
        setIsModalOpen(true);
    };

    const handleOpenEditModal = (client: Client) => {
        setEditingClient(client);
        setFormData({ ...client });
        setActiveTab('details');
        setIsModalOpen(true);
    };

    const handleCloseModal = () => {
        setIsModalOpen(false);
        setEditingClient(null);
        setFormData({});
    };

    const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
        const { name, value } = e.target;
        setFormData(prev => ({ ...prev, [name]: value }));
    };

    const handleSave = async (e: React.FormEvent) => {
        e.preventDefault();
        setIsSaving(true);

        try {
            const isEdit = !!editingClient;
            const url = isEdit ? `/api/clients/\${editingClient.id}` : '/api/clients';
            const method = isEdit ? 'PUT' : 'POST';

            const res = await fetch(url, {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(formData),
            });

            if (res.ok) {
                handleCloseModal();
                fetchClients();
            } else {
                const errorData = await res.json();
                alert(errorData.error || "Failed to save client");
            }
        } catch (error) {
            console.error("Save error", error);
            alert("An error occurred while saving.");
        } finally {
            setIsSaving(false);
        }
    };

    const handleDelete = async (id: string, name: string) => {
        if (!confirm(`Are you sure you want to delete \${name}?`)) return;

        try {
            const res = await fetch(`/api/clients/\${id}`, { method: 'DELETE' });
            if (res.ok) {
                fetchClients();
            } else {
                alert("Failed to delete client");
            }
        } catch (error) {
            console.error("Delete error", error);
        }
    };

    return (
        <>
            <div className="flex-1 bg-slate-50 min-h-screen">
                <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
                    <div className="flex justify-between items-center mb-8">
                        <div>
                            <h1 className="text-2xl font-bold text-slate-900">Clients</h1>
                            <p className="text-sm text-slate-500 mt-1">Manage your clients and their contact details.</p>
                        </div>
                        <button
                            onClick={handleOpenAddModal}
                            className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-md text-sm font-medium transition shadow-sm"
                        >
                            + Add Client
                        </button>
                    </div>

                    <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
                        {loading ? (
                            <div className="p-8 text-center text-slate-500">Loading clients...</div>
                        ) : clients.length === 0 ? (
                            <div className="p-12 text-center flex flex-col items-center">
                                <div className="w-16 h-16 bg-slate-100 rounded-full flex items-center justify-center mb-4">
                                    <svg className="w-8 h-8 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" /></svg>
                                </div>
                                <h3 className="text-lg font-medium text-slate-900 mb-1">No clients yet</h3>
                                <p className="text-slate-500 mb-6">Add your first client to get started managing their projects and details.</p>
                                <button
                                    onClick={handleOpenAddModal}
                                    className="bg-blue-50 text-blue-700 hover:bg-blue-100 px-4 py-2 rounded-md text-sm font-medium transition"
                                >
                                    Create Client
                                </button>
                            </div>
                        ) : (
                            <table className="min-w-full divide-y divide-slate-200">
                                <thead className="bg-slate-50">
                                    <tr>
                                        <th scope="col" className="px-6 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">
                                            Client Name
                                        </th>
                                        <th scope="col" className="px-6 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">
                                            Company
                                        </th>
                                        <th scope="col" className="px-6 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">
                                            Contact Info
                                        </th>
                                        <th scope="col" className="px-6 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">
                                            Projects
                                        </th>
                                        <th scope="col" className="relative px-6 py-3">
                                            <span className="sr-only">Actions</span>
                                        </th>
                                    </tr>
                                </thead>
                                <tbody className="bg-white divide-y divide-slate-200">
                                    {clients.map((client) => (
                                        <tr key={client.id} className="hover:bg-slate-50 transition-colors">
                                            <td className="px-6 py-4 whitespace-nowrap">
                                                <div className="flex items-center">
                                                    <div className="flex-shrink-0 h-10 w-10">
                                                        <div className="h-10 w-10 rounded-full bg-blue-100 flex items-center justify-center text-blue-700 font-bold text-sm">
                                                            {client.initials || '?'}
                                                        </div>
                                                    </div>
                                                    <div className="ml-4">
                                                        <div className="text-sm font-medium text-slate-900">{client.name}</div>
                                                        <div className="text-sm text-slate-500">Viewed just now</div>
                                                    </div>
                                                </div>
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap">
                                                <div className="text-sm text-slate-900">{client.companyName || '-'}</div>
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap">
                                                <div className="text-sm text-slate-900">{client.email || '-'}</div>
                                                <div className="text-sm text-slate-500">{client.primaryPhone || '-'}</div>
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-500">
                                                <div className="flex flex-col gap-1">
                                                    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-50 text-blue-700">
                                                        {client.projects?.length || 0} Projects
                                                    </span>
                                                    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-50 text-green-700">
                                                        {client.leads?.length || 0} Leads
                                                    </span>
                                                </div>
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                                                <button
                                                    onClick={() => handleOpenEditModal(client)}
                                                    className="text-blue-600 hover:text-blue-900 mr-4"
                                                >
                                                    Edit
                                                </button>
                                                <button
                                                    onClick={() => handleDelete(client.id, client.name)}
                                                    className="text-red-600 hover:text-red-900"
                                                >
                                                    Delete
                                                </button>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        )}
                    </div>
                </div>
            </div>

            {isModalOpen && (
                <div className="fixed inset-0 bg-slate-900/40 z-50 flex items-center justify-center p-4">
                    <div className="bg-white rounded-xl shadow-2xl max-w-3xl w-full max-h-[90vh] overflow-hidden flex flex-col">
                        <div className="px-6 py-4 border-b border-slate-200 flex flex-col sm:flex-row justify-between items-start sm:items-center bg-white sticky top-0 z-10">
                            <h2 className="text-xl font-bold text-slate-800 mb-4 sm:mb-0">
                                {editingClient ? 'Edit Client' : 'Add Client'}
                            </h2>
                            {editingClient && (
                                <div className="flex bg-slate-100 p-1 rounded-lg">
                                    <button
                                        onClick={() => setActiveTab('details')}
                                        className={`px-4 py-1.5 text-sm font-medium rounded-md transition \${activeTab === 'details' ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500 hover:text-slate-700'}`}
                                    >
                                        Client Details
                                    </button>
                                    <button
                                        onClick={() => setActiveTab('projects')}
                                        className={`px-4 py-1.5 text-sm font-medium rounded-md transition \${activeTab === 'projects' ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500 hover:text-slate-700'}`}
                                    >
                                        Projects ({editingClient.projects?.length || 0})
                                    </button>
                                    <button
                                        onClick={() => setActiveTab('leads')}
                                        className={`px-4 py-1.5 text-sm font-medium rounded-md transition \${activeTab === 'leads' ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500 hover:text-slate-700'}`}
                                    >
                                        Leads ({editingClient.leads?.length || 0})
                                    </button>
                                </div>
                            )}
                            {!editingClient && (
                                <button onClick={handleCloseModal} className="text-slate-400 hover:text-slate-600 sm:ml-auto">
                                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                                </button>
                            )}
                        </div>

                        <div className="p-6 overflow-y-auto bg-slate-50 flex-1">
                            {activeTab === 'details' && (
                                <form id="client-form" onSubmit={handleSave} className="space-y-8">

                                    {/* Contact Details Section */}
                                    <div className="bg-white p-5 rounded-lg border border-slate-200 shadow-sm">
                                        <h3 className="text-md font-semibold text-slate-800 mb-4 flex items-center">
                                            Contact Details
                                            <svg className="ml-2 w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" /></svg>
                                        </h3>
                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                            <div>
                                                <label className="block text-xs text-slate-500 mb-1">Full Name*</label>
                                                <input required name="name" type="text" value={formData.name || ''} onChange={handleInputChange} className="w-full border-slate-300 border rounded-md px-3 py-2 text-sm focus:ring-1 focus:ring-blue-500 focus:outline-none" />
                                            </div>
                                            <div>
                                                <label className="block text-xs text-slate-500 mb-1">Company Name</label>
                                                <input name="companyName" type="text" value={formData.companyName || ''} onChange={handleInputChange} className="w-full border-slate-300 border rounded-md px-3 py-2 text-sm focus:ring-1 focus:ring-blue-500 focus:outline-none" />
                                            </div>
                                            <div>
                                                <label className="block text-xs text-slate-500 mb-1">Primary Email Address</label>
                                                <input name="email" type="email" value={formData.email || ''} onChange={handleInputChange} className="w-full border-slate-300 border rounded-md px-3 py-2 text-sm focus:ring-1 focus:ring-blue-500 focus:outline-none" />
                                            </div>
                                            <div>
                                                <label className="block text-xs text-slate-500 mb-1">Primary Phone Number</label>
                                                <input name="primaryPhone" type="tel" value={formData.primaryPhone || ''} onChange={handleInputChange} className="w-full border-slate-300 border rounded-md px-3 py-2 text-sm focus:ring-1 focus:ring-blue-500 focus:outline-none" />
                                            </div>
                                            <div>
                                                <label className="block text-xs text-slate-500 mb-1">Additional Email Address</label>
                                                <input name="additionalEmail" type="email" value={formData.additionalEmail || ''} onChange={handleInputChange} className="w-full border-slate-300 border rounded-md px-3 py-2 text-sm focus:ring-1 focus:ring-blue-500 focus:outline-none" />
                                            </div>
                                            <div>
                                                <label className="block text-xs text-slate-500 mb-1">Additional Phone Number</label>
                                                <input name="additionalPhone" type="tel" value={formData.additionalPhone || ''} onChange={handleInputChange} className="w-full border-slate-300 border rounded-md px-3 py-2 text-sm focus:ring-1 focus:ring-blue-500 focus:outline-none" />
                                            </div>
                                        </div>
                                    </div>

                                    {/* Address Section */}
                                    <div className="bg-white p-5 rounded-lg border border-slate-200 shadow-sm">
                                        <h3 className="text-md font-semibold text-slate-800 mb-4 flex items-center">
                                            Address
                                            <svg className="ml-2 w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" /></svg>
                                        </h3>
                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                            <div>
                                                <label className="block text-xs text-slate-500 mb-1">Address Line 1</label>
                                                <input name="addressLine1" type="text" value={formData.addressLine1 || ''} onChange={handleInputChange} className="w-full border-slate-300 border rounded-md px-3 py-2 text-sm focus:ring-1 focus:ring-blue-500 focus:outline-none" />
                                            </div>
                                            <div>
                                                <label className="block text-xs text-slate-500 mb-1">Address Line 2</label>
                                                <input name="addressLine2" type="text" value={formData.addressLine2 || ''} onChange={handleInputChange} className="w-full border-slate-300 border rounded-md px-3 py-2 text-sm focus:ring-1 focus:ring-blue-500 focus:outline-none" />
                                            </div>
                                            <div>
                                                <label className="block text-xs text-slate-500 mb-1">City</label>
                                                <input name="city" type="text" value={formData.city || ''} onChange={handleInputChange} className="w-full border-slate-300 border rounded-md px-3 py-2 text-sm focus:ring-1 focus:ring-blue-500 focus:outline-none" />
                                            </div>
                                            <div>
                                                <label className="block text-xs text-slate-500 mb-1">State</label>
                                                <input name="state" type="text" value={formData.state || ''} onChange={handleInputChange} className="w-full border-slate-300 border rounded-md px-3 py-2 text-sm focus:ring-1 focus:ring-blue-500 focus:outline-none" />
                                            </div>
                                            <div>
                                                <label className="block text-xs text-slate-500 mb-1">Zip Code</label>
                                                <input name="zipCode" type="text" value={formData.zipCode || ''} onChange={handleInputChange} className="w-full border-slate-300 border rounded-md px-3 py-2 text-sm focus:ring-1 focus:ring-blue-500 focus:outline-none" />
                                            </div>
                                            <div>
                                                <label className="block text-xs text-slate-500 mb-1">Country</label>
                                                <input name="country" type="text" value={formData.country || ''} onChange={handleInputChange} className="w-full border-slate-300 border rounded-md px-3 py-2 text-sm focus:ring-1 focus:ring-blue-500 focus:outline-none" />
                                            </div>
                                        </div>
                                    </div>

                                    {/* Additional Info Section */}
                                    <div className="bg-white p-5 rounded-lg border border-slate-200 shadow-sm">
                                        <h3 className="text-md font-semibold text-slate-800 mb-4 flex items-center">
                                            Additional Info
                                            <svg className="ml-2 w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" /></svg>
                                        </h3>
                                        <div>
                                            <label className="block text-xs text-slate-500 mb-1">Internal Notes</label>
                                            <textarea name="internalNotes" rows={4} value={formData.internalNotes || ''} onChange={handleInputChange} className="w-full border-slate-300 border rounded-md px-3 py-2 text-sm focus:ring-1 focus:ring-blue-500 focus:outline-none resize-none" placeholder="Notes..." />
                                        </div>
                                    </div>
                                </form>
                            )}

                            {activeTab === 'projects' && (
                                <div>
                                    <h3 className="text-lg font-bold text-slate-800 mb-4">Associated Projects</h3>
                                    {!editingClient?.projects?.length ? (
                                        <div className="text-center p-8 bg-white rounded-lg border border-slate-200">
                                            <p className="text-slate-500">No projects associated with this client.</p>
                                        </div>
                                    ) : (
                                        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
                                            <table className="min-w-full divide-y divide-slate-200">
                                                <thead className="bg-slate-50">
                                                    <tr>
                                                        <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">Project Name</th>
                                                        <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">Status</th>
                                                    </tr>
                                                </thead>
                                                <tbody className="bg-white divide-y divide-slate-200">
                                                    {editingClient.projects.map(project => (
                                                        <tr key={project.id}>
                                                            <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-slate-900">{project.name}</td>
                                                            <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-500">{project.status}</td>
                                                        </tr>
                                                    ))}
                                                </tbody>
                                            </table>
                                        </div>
                                    )}
                                </div>
                            )}

                            {activeTab === 'leads' && (
                                <div>
                                    <h3 className="text-lg font-bold text-slate-800 mb-4">Associated Leads</h3>
                                    {!editingClient?.leads?.length ? (
                                        <div className="text-center p-8 bg-white rounded-lg border border-slate-200">
                                            <p className="text-slate-500">No leads associated with this client.</p>
                                        </div>
                                    ) : (
                                        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
                                            <table className="min-w-full divide-y divide-slate-200">
                                                <thead className="bg-slate-50">
                                                    <tr>
                                                        <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">Lead Name</th>
                                                        <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">Stage</th>
                                                        <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">Target Rev</th>
                                                    </tr>
                                                </thead>
                                                <tbody className="bg-white divide-y divide-slate-200">
                                                    {editingClient.leads.map(lead => (
                                                        <tr key={lead.id}>
                                                            <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-slate-900">{lead.name}</td>
                                                            <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-500">{lead.stage}</td>
                                                            <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-500">${lead.targetRevenue?.toLocaleString() || '0'}</td>
                                                        </tr>
                                                    ))}
                                                </tbody>
                                            </table>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>

                        <div className="px-6 py-4 border-t border-slate-200 bg-white flex justify-end gap-3 rounded-b-xl shrink-0">
                            <button
                                type="button"
                                onClick={handleCloseModal}
                                disabled={isSaving}
                                className="px-4 py-2 text-sm font-medium text-slate-700 hover:text-slate-900 transition"
                            >
                                Cancel
                            </button>
                            <button
                                type="submit"
                                form="client-form"
                                disabled={isSaving}
                                className="bg-slate-900 text-white px-6 py-2 rounded font-medium text-sm hover:bg-slate-800 transition shadow-sm disabled:opacity-70 flex items-center"
                            >
                                {isSaving ? 'Saving...' : 'Save'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}
