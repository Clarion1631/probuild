"use client";
import { useState, useTransition } from "react";
import { createClient, updateClient } from "@/lib/actions";
import { toast } from "sonner";
import Link from "next/link";

interface Client {
    id: string;
    name: string;
    email: string | null;
    primaryPhone: string | null;
    companyName: string | null;
    city: string | null;
    state: string | null;
    projects: { id: string }[];
    leads: { id: string }[];
}

interface Props {
    clients: Client[];
}

const EMPTY_FORM = { name: "", email: "", primaryPhone: "", companyName: "", city: "", state: "" };

export default function ContactsClient({ clients: initialClients }: Props) {
    const [clients, setClients] = useState<Client[]>(initialClients as Client[]);
    const [showAdd, setShowAdd] = useState(false);
    const [editId, setEditId] = useState<string | null>(null);
    const [form, setForm] = useState(EMPTY_FORM);
    const [isPending, startTransition] = useTransition();
    const [search, setSearch] = useState("");

    const filtered = clients.filter(c =>
        c.name.toLowerCase().includes(search.toLowerCase()) ||
        (c.email || "").toLowerCase().includes(search.toLowerCase())
    );

    function startEdit(c: Client) {
        setEditId(c.id);
        setForm({ name: c.name, email: c.email ?? "", primaryPhone: c.primaryPhone ?? "", companyName: c.companyName ?? "", city: c.city ?? "", state: c.state ?? "" });
    }

    function handleSaveNew() {
        if (!form.name.trim()) return;
        startTransition(async () => {
            try {
                const created = await createClient(form);
                setClients(prev => [{ ...created, projects: [], leads: [] } as Client, ...prev]);
                setShowAdd(false);
                setForm(EMPTY_FORM);
                toast.success("Contact added");
            } catch {
                toast.error("Failed to add contact");
            }
        });
    }

    function handleSaveEdit() {
        if (!editId || !form.name.trim()) return;
        startTransition(async () => {
            try {
                await updateClient(editId, form);
                setClients(prev => prev.map(c => c.id === editId ? { ...c, ...form } : c));
                setEditId(null);
                toast.success("Contact updated");
            } catch {
                toast.error("Failed to update contact");
            }
        });
    }

    return (
        <div className="max-w-4xl mx-auto py-8 px-6 space-y-6">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold text-hui-textMain">Contacts</h1>
                    <p className="text-sm text-hui-textMuted mt-1">Manage clients and contacts for your company.</p>
                </div>
                <button onClick={() => { setShowAdd(true); setForm(EMPTY_FORM); }} className="hui-btn hui-btn-primary text-sm">+ Add Contact</button>
            </div>

            <input
                type="text"
                placeholder="Search contacts..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="hui-input w-full"
            />

            {/* Add form */}
            {showAdd && (
                <div className="hui-card p-4 space-y-3">
                    <h3 className="text-sm font-semibold text-hui-textMain">New Contact</h3>
                    <div className="grid grid-cols-2 gap-3">
                        <input placeholder="Full name *" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} className="hui-input" />
                        <input placeholder="Company name" value={form.companyName} onChange={e => setForm(f => ({ ...f, companyName: e.target.value }))} className="hui-input" />
                        <input placeholder="Email" type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} className="hui-input" />
                        <input placeholder="Phone" value={form.primaryPhone} onChange={e => setForm(f => ({ ...f, primaryPhone: e.target.value }))} className="hui-input" />
                        <input placeholder="City" value={form.city} onChange={e => setForm(f => ({ ...f, city: e.target.value }))} className="hui-input" />
                        <input placeholder="State" value={form.state} onChange={e => setForm(f => ({ ...f, state: e.target.value }))} className="hui-input" />
                    </div>
                    <div className="flex gap-2 justify-end">
                        <button onClick={() => setShowAdd(false)} className="hui-btn hui-btn-secondary text-sm">Cancel</button>
                        <button onClick={handleSaveNew} disabled={isPending || !form.name.trim()} className="hui-btn hui-btn-primary text-sm disabled:opacity-50">
                            {isPending ? "Saving…" : "Save"}
                        </button>
                    </div>
                </div>
            )}

            {/* Table */}
            <div className="hui-card overflow-hidden">
                <table className="w-full text-sm">
                    <thead>
                        <tr className="text-left text-xs text-hui-textMuted uppercase tracking-wide border-b border-hui-border bg-hui-surface">
                            <th className="px-4 py-3">Name</th>
                            <th className="px-4 py-3">Email</th>
                            <th className="px-4 py-3">Phone</th>
                            <th className="px-4 py-3">Location</th>
                            <th className="px-4 py-3 text-center">Projects</th>
                            <th className="px-4 py-3 text-center">Leads</th>
                            <th className="px-4 py-3" />
                        </tr>
                    </thead>
                    <tbody>
                        {filtered.length === 0 && (
                            <tr>
                                <td colSpan={7} className="px-4 py-10 text-center text-hui-textMuted text-sm">
                                    {search ? "No contacts match your search." : "No contacts yet. Add one above."}
                                </td>
                            </tr>
                        )}
                        {filtered.map(c => (
                            <tr key={c.id} className="border-b border-hui-border last:border-0 hover:bg-hui-surface/50">
                                {editId === c.id ? (
                                    <>
                                        <td className="px-4 py-2" colSpan={4}>
                                            <div className="grid grid-cols-3 gap-2">
                                                <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} className="hui-input text-sm" placeholder="Name" />
                                                <input value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} className="hui-input text-sm" placeholder="Email" />
                                                <input value={form.primaryPhone} onChange={e => setForm(f => ({ ...f, primaryPhone: e.target.value }))} className="hui-input text-sm" placeholder="Phone" />
                                            </div>
                                        </td>
                                        <td className="px-4 py-2 text-center" />
                                        <td className="px-4 py-2 text-center" />
                                        <td className="px-4 py-2">
                                            <div className="flex gap-2">
                                                <button onClick={handleSaveEdit} disabled={isPending} className="hui-btn hui-btn-primary text-xs disabled:opacity-50">Save</button>
                                                <button onClick={() => setEditId(null)} className="hui-btn hui-btn-secondary text-xs">Cancel</button>
                                            </div>
                                        </td>
                                    </>
                                ) : (
                                    <>
                                        <td className="px-4 py-3 font-medium text-hui-textMain">{c.name}</td>
                                        <td className="px-4 py-3 text-hui-textMuted">{c.email ?? "—"}</td>
                                        <td className="px-4 py-3 text-hui-textMuted">{c.primaryPhone ?? "—"}</td>
                                        <td className="px-4 py-3 text-hui-textMuted">{[c.city, c.state].filter(Boolean).join(", ") || "—"}</td>
                                        <td className="px-4 py-3 text-center text-hui-textMuted">{c.projects.length}</td>
                                        <td className="px-4 py-3 text-center text-hui-textMuted">{c.leads.length}</td>
                                        <td className="px-4 py-3">
                                            <button onClick={() => startEdit(c)} className="text-xs text-hui-primary hover:underline">Edit</button>
                                        </td>
                                    </>
                                )}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
