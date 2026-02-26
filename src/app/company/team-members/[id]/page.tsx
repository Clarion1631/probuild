"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, Save } from "lucide-react";
import { toast } from "sonner";
import Link from "next/link";

interface User {
    id: string;
    name: string | null;
    email: string;
    role: string;
    hourlyRate: number;
    burdenRate: number;
    pinCode: string | null;
}

export default function TeamMemberEditPage({ params }: { params: { id: string } }) {
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

    useEffect(() => {
        fetchUser();
    }, [params.id]);

    const fetchUser = async () => {
        setLoading(true);
        try {
            const res = await fetch('/api/users'); // We can filter client side or add a specific GET /api/users/[id] later if needed. For now, find from list.
            if (res.ok) {
                const users: User[] = await res.json();
                const found = users.find(u => u.id === params.id);
                if (found) {
                    setUser(found);
                    const names = (found.name || "").split(" ");
                    setFirstName(names[0] || "");
                    setLastName(names.slice(1).join(" ") || "");
                    setRole(found.role);
                    setHourlyRate(found.hourlyRate);
                    setBurdenRate(found.burdenRate);
                    setPinCode(found.pinCode || "");
                } else {
                    toast.error("User not found");
                    router.push("/company/team-members");
                }
            }
        } catch (error) {
            console.error(error);
            toast.error("Failed to load user");
        } finally {
            setLoading(false);
        }
    };

    const handleSave = async () => {
        setSaving(true);
        try {
            const fullName = `${firstName} ${lastName}`.trim();
            const res = await fetch(`/api/users/${params.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: fullName,
                    role,
                    hourlyRate,
                    burdenRate,
                    pinCode
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

    if (loading) return <div className="p-8">Loading...</div>;
    if (!user) return null;

    // Permissions logic mapping based on role
    const getPermissions = (currentRole: string) => {
        const isAdmin = currentRole === 'ADMIN';
        const isManager = currentRole === 'MANAGER';
        const isFinance = currentRole === 'FINANCE';
        return {
            adminOnly: isAdmin,
            managerUp: isAdmin || isManager,
            financeUp: isAdmin || isFinance || isManager, // simplified for UI demo
        };
    };

    const perms = getPermissions(role);

    return (
        <div className="flex flex-col h-full overflow-y-auto bg-white">
            <div className="border-b p-6">
                <Link href="/company/team-members" className="flex items-center text-slate-500 hover:text-slate-800 text-sm font-medium mb-4 transition-colors">
                    <ChevronLeft className="w-4 h-4 mr-1" />
                    Back to Team Members
                </Link>
                <div className="flex items-center justify-between">
                    <h1 className="text-2xl font-semibold text-slate-800">Edit "{user.email}"</h1>
                    <button
                        onClick={handleSave}
                        disabled={saving}
                        className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-md font-medium text-sm hover:bg-blue-700 transition disabled:opacity-50"
                    >
                        <Save className="w-4 h-4" />
                        {saving ? "Saving..." : "Save Changes"}
                    </button>
                </div>
            </div>

            <div className="p-8 max-w-4xl space-y-8">
                {/* Name Section */}
                <div>
                    <h2 className="text-lg font-semibold text-slate-800 mb-4">Name</h2>
                    <div className="grid grid-cols-2 gap-6">
                        <div>
                            <label className="block text-sm font-medium text-slate-700 mb-1">First Name</label>
                            <input
                                type="text"
                                value={firstName}
                                onChange={(e) => setFirstName(e.target.value)}
                                className="w-full border border-slate-300 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-slate-700 mb-1">Last Name</label>
                            <input
                                type="text"
                                value={lastName}
                                onChange={(e) => setLastName(e.target.value)}
                                className="w-full border border-slate-300 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                            />
                        </div>
                    </div>
                </div>

                {/* Role Section */}
                <div>
                    <h2 className="text-lg font-semibold text-slate-800 mb-4">Role</h2>
                    <div className="w-64">
                        <select
                            value={role}
                            onChange={(e) => setRole(e.target.value)}
                            className="w-full border border-slate-300 rounded-md px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                        >
                            <option value="ADMIN">Admin</option>
                            <option value="MANAGER">Manager</option>
                            <option value="FINANCE">Finance</option>
                            <option value="EMPLOYEE">Field Crew</option>
                        </select>
                    </div>
                </div>

                {/* Permissions Display (Read-Only Matrix based on Role) */}
                <div className="bg-slate-50 border border-slate-200 rounded-lg p-6">
                    <h3 className="text-sm font-semibold text-slate-800 mb-4 uppercase tracking-wider">Administrative Permissions (Auto-assigned)</h3>
                    <div className="grid grid-cols-2 gap-y-4 gap-x-8 text-sm text-slate-700">
                        <label className="flex items-center gap-3">
                            <input type="checkbox" checked={perms.adminOnly} readOnly className="rounded text-blue-600 pointer-events-none opacity-80" />
                            Accounting Integrations
                        </label>
                        <label className="flex items-center gap-3">
                            <input type="checkbox" checked={perms.adminOnly} readOnly className="rounded text-blue-600 pointer-events-none opacity-80" />
                            Business Document Setup
                        </label>
                        <label className="flex items-center gap-3">
                            <input type="checkbox" checked={perms.managerUp} readOnly className="rounded text-blue-600 pointer-events-none opacity-80" />
                            Manage Team Members
                        </label>
                        <label className="flex items-center gap-3">
                            <input type="checkbox" checked={perms.managerUp} readOnly className="rounded text-blue-600 pointer-events-none opacity-80" />
                            Manage Subcontractors
                        </label>
                        <label className="flex items-center gap-3">
                            <input type="checkbox" checked={perms.financeUp} readOnly className="rounded text-blue-600 pointer-events-none opacity-80" />
                            Financial Reports
                        </label>
                        <label className="flex items-center gap-3">
                            <input type="checkbox" checked={perms.financeUp} readOnly className="rounded text-blue-600 pointer-events-none opacity-80" />
                            Time, Expenses, and Rates
                        </label>
                    </div>
                </div>

                {/* Rates & App Access */}
                <div className="grid grid-cols-2 gap-8">
                    <div>
                        <h2 className="text-lg font-semibold text-slate-800 mb-4">Labor Cost Rates</h2>
                        <div className="space-y-4">
                            <div>
                                <label className="block text-sm font-medium text-slate-700 mb-1">Hourly Rate ($)</label>
                                <input
                                    type="number"
                                    value={hourlyRate}
                                    onChange={(e) => setHourlyRate(parseFloat(e.target.value) || 0)}
                                    className="w-full border border-slate-300 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-slate-700 mb-1">Burden Rate ($) / hr</label>
                                <input
                                    type="number"
                                    value={burdenRate}
                                    onChange={(e) => setBurdenRate(parseFloat(e.target.value) || 0)}
                                    className="w-full border border-slate-300 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                                />
                            </div>
                        </div>
                    </div>

                    <div>
                        <h2 className="text-lg font-semibold text-slate-800 mb-4">Mobile App Access</h2>
                        <div className="space-y-4">
                            <div>
                                <label className="block text-sm font-medium text-slate-700 mb-1">Mobile PIN Code</label>
                                <input
                                    type="text"
                                    maxLength={6}
                                    placeholder="e.g. 1234"
                                    value={pinCode}
                                    onChange={(e) => setPinCode(e.target.value.replace(/\D/g, ''))}
                                    className="w-full border border-slate-300 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                                />
                                <p className="text-xs text-slate-500 mt-1">Used by Field Crew to log in to the native mobile app.</p>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Danger Zone */}
                <div className="pt-8 border-t mt-12 pb-12">
                    <div className="flex gap-4">
                        <button className="px-4 py-2 border border-slate-300 text-slate-700 rounded-md font-medium text-sm hover:bg-slate-50 transition">
                            Disable Team Member
                        </button>
                        <button className="px-4 py-2 bg-red-600 text-white rounded-md font-medium text-sm hover:bg-red-700 transition">
                            Delete Team Member
                        </button>
                    </div>
                </div>

            </div>
        </div>
    );
}
