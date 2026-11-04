"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { addJobContact, updateJobContact, removeJobContact } from "@/lib/actions";

export interface JobContactRow {
    id: string;
    name: string;
    email: string | null;
    phone: string | null;
    isOwner: boolean;
    isPrimaryContact: boolean;
    roleNote: string | null;
}

interface JobContactsSectionProps {
    leadId?: string;
    projectId?: string;
    mainClient: { name: string; email: string | null; phone: string | null } | null;
    contacts: JobContactRow[];
}

type Draft = { name: string; email: string; phone: string; roleNote: string; isOwner: boolean; isPrimaryContact: boolean };
const EMPTY: Draft = { name: "", email: "", phone: "", roleNote: "", isOwner: false, isPrimaryContact: false };

export default function JobContactsSection({ leadId, projectId, mainClient, contacts }: JobContactsSectionProps) {
    const router = useRouter();
    // "new" = add form open, a contact id = editing that row, null = closed.
    const [editing, setEditing] = useState<string | null>(null);
    const [draft, setDraft] = useState<Draft>(EMPTY);
    const [saving, setSaving] = useState(false);

    const hasPrimary = contacts.some(c => c.isPrimaryContact);

    const openNew = () => { setDraft(EMPTY); setEditing("new"); };
    const openEdit = (c: JobContactRow) => {
        setDraft({
            name: c.name, email: c.email || "", phone: c.phone || "", roleNote: c.roleNote || "",
            isOwner: c.isOwner, isPrimaryContact: c.isPrimaryContact,
        });
        setEditing(c.id);
    };

    const save = async () => {
        if (!draft.name.trim()) { toast.error("Name is required"); return; }
        setSaving(true);
        try {
            if (editing === "new") {
                await addJobContact(leadId ? { leadId } : { projectId }, {
                    name: draft.name, email: draft.email, phone: draft.phone, roleNote: draft.roleNote,
                    isOwner: draft.isOwner, isPrimaryContact: draft.isPrimaryContact,
                });
                toast.success("Contact added");
            } else if (editing) {
                await updateJobContact(editing, {
                    name: draft.name, email: draft.email, phone: draft.phone, roleNote: draft.roleNote,
                    isOwner: draft.isOwner, isPrimaryContact: draft.isPrimaryContact,
                });
                toast.success("Contact updated");
            }
            setEditing(null);
            router.refresh();
        } catch (e: any) {
            toast.error(e.message || "Failed to save contact");
        } finally {
            setSaving(false);
        }
    };

    const remove = async (c: JobContactRow) => {
        if (!window.confirm(`Remove ${c.name} from this job?`)) return;
        try {
            await removeJobContact(c.id);
            toast.success("Contact removed");
            router.refresh();
        } catch (e: any) {
            toast.error(e.message || "Failed to remove contact");
        }
    };

    const badge = (text: string, cls: string) => (
        <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${cls}`}>{text}</span>
    );

    const form = (
        <div className="space-y-2 p-3 rounded-lg border border-slate-200 bg-slate-50">
            <input type="text" placeholder="Name" value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} className="hui-input w-full text-sm" />
            <input type="email" placeholder="Email" value={draft.email} onChange={e => setDraft({ ...draft, email: e.target.value })} className="hui-input w-full text-sm" />
            <input type="tel" placeholder="Phone" value={draft.phone} onChange={e => setDraft({ ...draft, phone: e.target.value })} className="hui-input w-full text-sm" />
            <input type="text" placeholder="Role note (optional)" value={draft.roleNote} onChange={e => setDraft({ ...draft, roleNote: e.target.value })} className="hui-input w-full text-sm" />
            <label className="flex items-center gap-2 text-xs text-slate-600">
                <input type="checkbox" checked={draft.isOwner} onChange={e => setDraft({ ...draft, isOwner: e.target.checked })} /> Owner
            </label>
            <label className="flex items-center gap-2 text-xs text-slate-600">
                <input type="checkbox" checked={draft.isPrimaryContact} onChange={e => setDraft({ ...draft, isPrimaryContact: e.target.checked })} /> Primary contact
            </label>
            <div className="flex justify-end gap-2">
                <button onClick={() => setEditing(null)} className="text-xs text-slate-500 hover:text-slate-700 transition font-medium">Cancel</button>
                <button onClick={save} disabled={saving} className="text-xs text-white bg-green-600 hover:bg-green-700 px-2.5 py-1 rounded transition font-medium disabled:opacity-50">
                    {saving ? "..." : "Save"}
                </button>
            </div>
        </div>
    );

    return (
        <div>
            <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-bold text-hui-textMain">Contacts</h3>
                {editing !== "new" && (
                    <button onClick={openNew} className="text-xs text-green-600 hover:text-green-700 font-semibold hover:underline transition">Add</button>
                )}
            </div>

            <div className="space-y-2">
                {mainClient && (
                    <div className="py-2 border-b border-slate-50">
                        <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="text-sm font-medium text-hui-textMain">{mainClient.name}</span>
                            {badge("Main client", "bg-green-100 text-green-700")}
                            {!hasPrimary && badge("Primary contact", "bg-blue-100 text-blue-700")}
                        </div>
                        {mainClient.email && <p className="text-xs text-slate-500">{mainClient.email}</p>}
                        {mainClient.phone && <p className="text-xs text-slate-500">{mainClient.phone}</p>}
                        <p className="text-[11px] text-slate-400 mt-0.5">Main client: estimates, contracts and invoices go here.</p>
                    </div>
                )}

                {contacts.map(c => (
                    editing === c.id ? <div key={c.id}>{form}</div> : (
                        <div key={c.id} className="py-2 border-b border-slate-50">
                            <div className="flex items-center justify-between gap-2">
                                <div className="flex items-center gap-1.5 flex-wrap min-w-0">
                                    <span className="text-sm font-medium text-hui-textMain">{c.name}</span>
                                    {c.isOwner && badge("Owner", "bg-amber-100 text-amber-700")}
                                    {c.isPrimaryContact && badge("Primary contact", "bg-blue-100 text-blue-700")}
                                </div>
                                <div className="flex gap-2 shrink-0">
                                    <button onClick={() => openEdit(c)} className="text-xs text-green-600 hover:text-green-700 font-semibold hover:underline transition">Edit</button>
                                    <button onClick={() => remove(c)} className="text-xs text-red-500 hover:text-red-700 font-semibold hover:underline transition">Remove</button>
                                </div>
                            </div>
                            {c.email && <p className="text-xs text-slate-500">{c.email}</p>}
                            {c.phone && <p className="text-xs text-slate-500">{c.phone}</p>}
                            {c.roleNote && <p className="text-xs text-slate-400 italic">{c.roleNote}</p>}
                        </div>
                    )
                ))}

                {editing === "new" && form}
            </div>

            <p className="text-[11px] text-slate-400 mt-3">Contacts don&apos;t get portal access, signing or invoices.</p>
        </div>
    );
}
