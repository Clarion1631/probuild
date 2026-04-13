"use client";

import { useState, useEffect, use } from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, Save } from "lucide-react";
import { toast } from "sonner";
import Link from "next/link";

interface UserPermission {
    manageTeamMembers: boolean;
    manageSubs: boolean;
    manageVendors: boolean;
    companySettings: boolean;
    costCodesCategories: boolean;
    schedules: boolean;
    estimates: boolean;
    invoices: boolean;
    contracts: boolean;
    floorPlans: boolean;
    changeOrders: boolean;
    financialReports: boolean;
    timeClock: boolean;
    dailyLogs: boolean;
    files: boolean;
    takeoffs: boolean;
}

interface User {
    id: string;
    name: string | null;
    email: string;
    role: string;
    hourlyRate: number;
    burdenRate: number;
    hasPin: boolean;
    permissions: UserPermission | null;
}

const DEFAULT_PERMISSIONS: UserPermission = {
    manageTeamMembers: false,
    manageSubs: false,
    manageVendors: false,
    companySettings: false,
    costCodesCategories: true,
    schedules: true,
    estimates: false,
    invoices: false,
    contracts: false,
    floorPlans: true,
    changeOrders: false,
    financialReports: false,
    timeClock: true,
    dailyLogs: true,
    files: true,
    takeoffs: false,
};

export default function TeamMemberEditPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = use(params);
    const router = useRouter();
    const [user, setUser] = useState<User | null>(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    // Form state
    const [firstName, setFirstName] = useState("");
    const [lastName, setLastName] = useState("");
    const [role, setRole] = useState("EMPLOYEE");
    const [hourlyRate, setHourlyRate] = useState(0);
    const [burdenRate, setBurdenRate] = useState(0);
    const [pinCode, setPinCode] = useState("");
    const [permissions, setPermissions] = useState<UserPermission>(DEFAULT_PERMISSIONS);

    useEffect(() => {
        fetchUser();
    }, [id]);

    const fetchUser = async () => {
        setLoading(true);
        try {
            const res = await fetch(`/api/users/${id}`);
            if (res.ok) {
                const { user: found } = await res.json();
                if (found) {
                    setUser(found);
                    const names = (found.name || "").split(" ");
                    setFirstName(names[0] || "");
                    setLastName(names.slice(1).join(" ") || "");
                    setRole(found.role);
                    setHourlyRate(found.hourlyRate ?? 0);
                    setBurdenRate(found.burdenRate ?? 0);
                    if (found.permissions) {
                        setPermissions({ ...DEFAULT_PERMISSIONS, ...found.permissions });
                    }
                } else {
                    toast.error("User not found");
                    router.push("/company/team-members");
                }
            } else {
                toast.error("Failed to load user");
            }
        } catch (error) {
            console.error(error);
            toast.error("Failed to load user");
        } finally {
            setLoading(false);
        }
    };

    const togglePermission = (key: keyof UserPermission) => {
        setPermissions(prev => ({ ...prev, [key]: !prev[key] }));
    };

    const handleSave = async () => {
        setSaving(true);
        try {
            const fullName = `${firstName} ${lastName}`.trim();
            const res = await fetch(`/api/users/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    userInfo: { name: fullName, role, hourlyRate, burdenRate },
                    permissions,
                    pinCode,
                })
            });

            if (res.ok) {
                toast.success("Team member updated successfully");
                router.push("/company/team-members");
            } else {
                const data = await res.json();
                toast.error(data.error || "Failed to update member");
            }
        } catch (error) {
            console.error(error);
            toast.error("An error occurred while saving");
        } finally {
            setSaving(false);
        }
    };

    const handleDisable = async () => {
        if (!confirm(`Disable ${user?.email}? They will lose access until re-enabled.`)) return;
        try {
            const res = await fetch(`/api/users/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userInfo: { status: "DISABLED" } })
            });
            if (res.ok) {
                toast.success("Team member disabled");
                router.push("/company/team-members");
            } else {
                const data = await res.json();
                toast.error(data.error || "Failed to disable member");
            }
        } catch {
            toast.error("An error occurred");
        }
    };

    const handleDelete = async () => {
        if (!confirm(`Are you sure you want to delete ${user?.email}? This action cannot be undone.`)) {
            return;
        }

        try {
            const res = await fetch(`/api/users/${id}`, {
                method: 'DELETE',
            });

            if (res.ok) {
                toast.success("Team member deleted successfully");
                router.push("/company/team-members");
            } else {
                const data = await res.json();
                toast.error(data.error || "Failed to delete member");
            }
        } catch (error) {
            console.error(error);
            toast.error("An error occurred while deleting");
        }
    };

    if (loading) return <div className="p-8">Loading...</div>;
    if (!user) return null;

    const adminPerms: { key: keyof UserPermission; label: string }[] = [
        { key: "manageTeamMembers", label: "Manage Team Members" },
        { key: "manageSubs", label: "Manage Subcontractors" },
        { key: "manageVendors", label: "Manage Vendors" },
        { key: "companySettings", label: "Company Settings" },
        { key: "costCodesCategories", label: "Cost Codes & Categories" },
        { key: "financialReports", label: "Financial Reports" },
    ];

    const projectPerms: { key: keyof UserPermission; label: string }[] = [
        { key: "schedules", label: "Schedules" },
        { key: "estimates", label: "Estimates" },
        { key: "invoices", label: "Invoices" },
        { key: "contracts", label: "Contracts" },
        { key: "floorPlans", label: "Floor Plans" },
        { key: "changeOrders", label: "Change Orders" },
        { key: "timeClock", label: "Time Clock" },
        { key: "dailyLogs", label: "Daily Logs" },
        { key: "files", label: "Files" },
        { key: "takeoffs", label: "Takeoffs" },
    ];

    return (
        <div className="flex flex-col h-full overflow-y-auto bg-hui-background">
            <div className="border-b border-hui-border p-6 bg-white">
                <Link href="/company/team-members" className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-hui-textMain bg-white border border-hui-border rounded-md hover:bg-slate-50 transition shadow-sm w-fit mb-4">
                    <ChevronLeft className="w-4 h-4 mr-1" />
                    Back to Team Members
                </Link>
                <div className="flex items-center justify-between">
                    <h1 className="text-2xl font-semibold text-hui-textMain">Edit "{user.email}"</h1>
                    <button
                        onClick={handleSave}
                        disabled={saving}
                        className="hui-btn hui-btn-primary flex items-center gap-2"
                    >
                        <Save className="w-4 h-4" />
                        {saving ? "Saving..." : "Save Changes"}
                    </button>
                </div>
            </div>

            <div className="p-8 max-w-4xl space-y-8">
                {/* Name Section */}
                <div className="hui-card p-6">
                    <h2 className="text-lg font-semibold text-hui-textMain mb-4">Name</h2>
                    <div className="grid grid-cols-2 gap-6">
                        <div>
                            <label className="block text-sm font-medium text-hui-textMain mb-1">First Name</label>
                            <input
                                type="text"
                                value={firstName}
                                onChange={(e) => setFirstName(e.target.value)}
                                className="hui-input w-full"
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-hui-textMain mb-1">Last Name</label>
                            <input
                                type="text"
                                value={lastName}
                                onChange={(e) => setLastName(e.target.value)}
                                className="hui-input w-full"
                            />
                        </div>
                    </div>
                </div>

                {/* Role Section */}
                <div className="hui-card p-6">
                    <h2 className="text-lg font-semibold text-hui-textMain mb-4">Role</h2>
                    <div className="w-64">
                        <select
                            value={role}
                            onChange={(e) => setRole(e.target.value)}
                            className="hui-input w-full cursor-pointer"
                        >
                            <option value="ADMIN">Admin</option>
                            <option value="MANAGER">Manager</option>
                            <option value="FINANCE">Finance</option>
                            <option value="FIELD_CREW">Field Crew</option>
                        </select>
                    </div>
                </div>

                {/* Administrative Permissions */}
                <div className="hui-card p-6">
                    <h3 className="text-sm font-semibold text-hui-textMain mb-4 uppercase tracking-wider">Administrative Permissions</h3>
                    <div className="grid grid-cols-2 gap-y-4 gap-x-8 text-sm text-hui-textMain">
                        {adminPerms.map(({ key, label }) => (
                            <label key={key} className="flex items-center gap-3 cursor-pointer select-none">
                                <input
                                    type="checkbox"
                                    checked={permissions[key]}
                                    onChange={() => togglePermission(key)}
                                    className="rounded text-blue-600 cursor-pointer"
                                />
                                {label}
                            </label>
                        ))}
                    </div>
                </div>

                {/* Project-Level Permissions */}
                <div className="hui-card p-6">
                    <h3 className="text-sm font-semibold text-hui-textMain mb-4 uppercase tracking-wider">Project Access</h3>
                    <div className="grid grid-cols-2 gap-y-4 gap-x-8 text-sm text-hui-textMain">
                        {projectPerms.map(({ key, label }) => (
                            <label key={key} className="flex items-center gap-3 cursor-pointer select-none">
                                <input
                                    type="checkbox"
                                    checked={permissions[key]}
                                    onChange={() => togglePermission(key)}
                                    className="rounded text-blue-600 cursor-pointer"
                                />
                                {label}
                            </label>
                        ))}
                    </div>
                </div>

                {/* Rates & App Access */}
                <div className="grid grid-cols-2 gap-8">
                    <div className="hui-card p-6">
                        <h2 className="text-lg font-semibold text-hui-textMain mb-4">Labor Cost Rates</h2>
                        <div className="space-y-4">
                            <div>
                                <label className="block text-sm font-medium text-hui-textMain mb-1">Hourly Rate ($)</label>
                                <input
                                    type="number"
                                    value={hourlyRate}
                                    onChange={(e) => setHourlyRate(parseFloat(e.target.value) || 0)}
                                    className="hui-input w-full"
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-hui-textMain mb-1">Burden Rate ($) / hr</label>
                                <input
                                    type="number"
                                    value={burdenRate}
                                    onChange={(e) => setBurdenRate(parseFloat(e.target.value) || 0)}
                                    className="hui-input w-full"
                                />
                            </div>
                        </div>
                    </div>

                    <div className="hui-card p-6">
                        <h2 className="text-lg font-semibold text-hui-textMain mb-4">Mobile App Access</h2>
                        <div className="space-y-4">
                            <div>
                                <label className="block text-sm font-medium text-hui-textMain mb-1">Mobile PIN Code</label>
                                <input
                                    type="text"
                                    maxLength={6}
                                    placeholder="e.g. 1234"
                                    value={pinCode}
                                    onChange={(e) => setPinCode(e.target.value.replace(/\D/g, ''))}
                                    className="hui-input w-full"
                                />
                                <p className="text-xs text-hui-textMuted mt-1">Used by Field Crew to log in to the native mobile app.</p>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Danger Zone */}
                <div className="pt-8 border-t border-hui-border mt-12 pb-12">
                    <div className="flex gap-4">
                        <button
                            type="button"
                            onClick={handleDisable}
                            className="hui-btn hui-btn-secondary"
                        >
                            Disable Team Member
                        </button>
                        <button
                            type="button"
                            onClick={handleDelete}
                            className="bg-red-600 text-white px-4 py-2 rounded-md font-medium text-sm hover:opacity-90 transition"
                        >
                            Delete Team Member
                        </button>
                    </div>
                </div>

            </div>
        </div>
    );
}
