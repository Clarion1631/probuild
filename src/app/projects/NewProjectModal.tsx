"use client";

import { useState } from "react";
import { createProject } from "@/lib/actions";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import ClientCombobox from "@/components/ClientCombobox";
import GoogleMapsAutocomplete from "@/components/GoogleMapsAutocomplete";

const DEFAULT_STATUS_OPTIONS = ["Open", "In Progress", "Paid, Ready to Start", "Done", "Closed"];

export default function NewProjectModal({
    onClose,
    statusOptions = DEFAULT_STATUS_OPTIONS,
}: {
    onClose: () => void;
    statusOptions?: string[];
}) {
    const router = useRouter();
    const [isSubmitting, setIsSubmitting] = useState(false);

    // Customer: when an existing client is picked we keep its id so we tie the
    // project to that exact contact (no duplicate). If the name is later edited
    // away from the picked client, we fall back to find-or-create by name.
    const [selectedClient, setSelectedClient] = useState<{ id: string; name: string } | null>(null);
    const [clientEmail, setClientEmail] = useState("");
    const [clientPhone, setClientPhone] = useState("");

    // Job site address -> project.location (and new-client address)
    const [jobSiteLocation, setJobSiteLocation] = useState("");
    const [jobSiteAddr, setJobSiteAddr] = useState("");
    const [jobSiteCity, setJobSiteCity] = useState("");
    const [jobSiteState, setJobSiteState] = useState("");
    const [jobSiteZip, setJobSiteZip] = useState("");

    async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
        e.preventDefault();
        setIsSubmitting(true);
        try {
            const formData = new FormData(e.currentTarget);
            const clientName = ((formData.get("clientName") as string) || "").trim();

            // Use the picked client's id only if the name field still matches it.
            const useExisting =
                selectedClient && selectedClient.name.trim().toLowerCase() === clientName.toLowerCase();

            const result = await createProject({
                name: (formData.get("name") as string) || "",
                clientId: useExisting ? selectedClient!.id : undefined,
                clientName: useExisting ? undefined : clientName,
                clientEmail: clientEmail || undefined,
                clientPhone: clientPhone || undefined,
                location: jobSiteLocation || undefined,
                addressLine1: jobSiteAddr || undefined,
                city: jobSiteCity || undefined,
                state: jobSiteState || undefined,
                zipCode: jobSiteZip || undefined,
                projectType: (formData.get("projectType") as string) || undefined,
                status: (formData.get("status") as string) || undefined,
            });

            if (result?.id) {
                toast.success("Project created");
                router.push(`/projects/${result.id}`);
                onClose();
            }
        } catch (err: any) {
            toast.error(err?.message || "Failed to create project");
        } finally {
            setIsSubmitting(false);
        }
    }

    return (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
            <div className="bg-white rounded-lg p-6 w-[500px] shadow-xl max-h-[90vh] overflow-y-auto">
                <h2 className="text-xl font-bold text-hui-textMain mb-1">Create New Project</h2>
                <p className="text-sm text-hui-textMuted mb-4">
                    Pick an existing customer (for a repeat client) or type a new name.
                </p>
                <form onSubmit={handleSubmit} className="space-y-4">
                    <div>
                        <label className="block text-sm text-hui-textMuted mb-1">Project Name</label>
                        <input name="name" required type="text" className="hui-input w-full" placeholder="e.g. Master Bath Remodel" />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="block text-sm text-hui-textMuted mb-1">Customer</label>
                            <ClientCombobox
                                name="clientName"
                                onSelect={(client) => {
                                    setSelectedClient({ id: client.id, name: client.name });
                                    setClientEmail(client.email || "");
                                    setClientPhone(client.primaryPhone || "");
                                }}
                            />
                        </div>
                        <div>
                            <label className="block text-sm text-hui-textMuted mb-1">Customer Email</label>
                            <input type="email" value={clientEmail} onChange={e => setClientEmail(e.target.value)} className="hui-input w-full" placeholder="Optional" />
                        </div>
                    </div>
                    <div>
                        <label className="block text-sm text-hui-textMuted mb-1">Customer Phone</label>
                        <input type="text" value={clientPhone} onChange={e => setClientPhone(e.target.value)} className="hui-input w-full" placeholder="Optional" />
                    </div>

                    <div>
                        <label className="block text-sm text-hui-textMuted mb-1">Job Site Address</label>
                        <GoogleMapsAutocomplete
                            value={jobSiteLocation}
                            onChange={(val) => {
                                setJobSiteLocation(val);
                                setJobSiteAddr(""); setJobSiteCity(""); setJobSiteState(""); setJobSiteZip("");
                            }}
                            onPlaceDetails={(d) => {
                                setJobSiteAddr(d.address || "");
                                setJobSiteCity(d.city || "");
                                setJobSiteState(d.state || "");
                                setJobSiteZip(d.zip || "");
                            }}
                            className="hui-input w-full"
                        />
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="block text-sm text-hui-textMuted mb-1">Project Type</label>
                            <input name="projectType" type="text" className="hui-input w-full" placeholder="e.g. Kitchen" />
                        </div>
                        <div>
                            <label className="block text-sm text-hui-textMuted mb-1">Status</label>
                            <select name="status" defaultValue="In Progress" className="hui-input w-full">
                                {statusOptions.map(s => (
                                    <option key={s} value={s}>{s}</option>
                                ))}
                            </select>
                        </div>
                    </div>

                    <div className="flex justify-end gap-3 mt-6 pt-4 border-t border-hui-border">
                        <button type="button" onClick={onClose} className="hui-btn hui-btn-secondary border-hui-border">Cancel</button>
                        <button type="submit" disabled={isSubmitting} className="hui-btn hui-btn-primary">
                            {isSubmitting ? "Creating..." : "Create Project"}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
