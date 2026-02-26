"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { toast } from "sonner";

type User = {
    id: string;
    name: string | null;
    email: string;
    role: string;
    hourlyRate: number;
    burdenRate: number;
    pinCode: string | null;
};

export default function TeamPage() {
    const [users, setUsers] = useState<User[]>([]);
    const [loading, setLoading] = useState(true);
    const [isAddingUser, setIsAddingUser] = useState(false);
    const [addForm, setAddForm] = useState<Partial<User>>({ role: 'EMPLOYEE' });

    useEffect(() => {
        fetchUsers();
    }, []);

    async function fetchUsers() {
        const res = await fetch('/api/users');
        if (res.ok) {
            const data = await res.json();
            setUsers(data);
        } else {
            console.error("Failed to fetch users");
        }
        setLoading(false);
    }

    const handleAddSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        const res = await fetch('/api/users', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(addForm)
        });

        if (res.ok) {
            setIsAddingUser(false);
            setAddForm({ role: 'EMPLOYEE', email: '' });
            toast.success("Team member invited successfully.");
            fetchUsers();
        } else {
            const data = await res.json();
            console.error("Add user failed:", data);
            toast.error(data.error || "Failed to add user");
        }
    };

    return (
        <div className="font-sans text-slate-900 h-full flex flex-col">
            <header className="bg-white border-b border-slate-200 px-8 py-4 flex items-center justify-between sticky top-0 z-10">
                <h1 className="text-xl font-bold text-slate-800">Team Members</h1>
                <button
                    onClick={() => setIsAddingUser(true)}
                    className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-md text-sm font-medium transition shadow-sm"
                >
                    + Add Team Member
                </button>
            </header>

            <div className="p-8 flex-1 overflow-y-auto w-full max-w-7xl mx-auto">
                <div className="mb-8">
                    <p className="text-slate-600">
                        {users.length} Free Seats used. To modify your team settings, chat with us.
                    </p>
                </div>

                {loading ? (
                    <div className="text-center py-20 text-slate-500">Loading team members...</div>
                ) : (
                    <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
                        <table className="w-full text-left border-collapse">
                            <thead>
                                <tr className="bg-slate-50 border-b border-slate-200 text-sm font-semibold text-slate-600 whitespace-nowrap">
                                    <th className="px-6 py-4 font-normal">Name</th>
                                    <th className="px-6 py-4 font-normal">Email</th>
                                    <th className="px-6 py-4 font-normal">Role</th>
                                    <th className="px-6 py-4 font-normal hidden sm:table-cell">Hourly Rate</th>
                                    <th className="px-6 py-4 font-normal text-right">Actions</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100 text-sm">
                                {users.map(user => (
                                    <tr key={user.id} className="hover:bg-slate-50 transition-colors group">
                                        <td className="px-6 py-4">
                                            <div className="font-medium text-slate-900">
                                                {user.name || 'Invited User'}
                                            </div>
                                        </td>
                                        <td className="px-6 py-4 text-slate-600">
                                            {user.email}
                                        </td>
                                        <td className="px-6 py-4 text-slate-600">
                                            {user.role === 'EMPLOYEE' ? 'Field Crew' :
                                                user.role === 'MANAGER' ? 'Manager' :
                                                    user.role === 'FINANCE' ? 'Finance' :
                                                        'Admin'}
                                        </td>
                                        <td className="px-6 py-4 text-slate-600 hidden sm:table-cell">
                                            ${(user.hourlyRate ?? 0).toFixed(2)}
                                        </td>
                                        <td className="px-6 py-4 text-right">
                                            <Link
                                                href={`/company/team-members/${user.id}`}
                                                className="text-blue-600 hover:text-blue-800 font-medium opacity-0 group-hover:opacity-100 transition-opacity"
                                            >
                                                Edit
                                            </Link>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                        {users.length === 0 && (
                            <div className="p-6 text-center text-slate-500">No team members found.</div>
                        )}
                    </div>
                )}
            </div>

            {/* Add User Modal */}
            {isAddingUser && (
                <div className="fixed inset-0 bg-slate-900/50 flex flex-col items-center justify-center z-50 p-4">
                    <div className="bg-white rounded-xl shadow-xl max-w-md w-full overflow-hidden">
                        <div className="px-6 py-4 border-b border-slate-200 flex justify-between items-center">
                            <h2 className="text-lg font-bold text-slate-800">Invite New Team Member</h2>
                            <button onClick={() => setIsAddingUser(false)} className="text-slate-400 hover:text-slate-600">
                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                            </button>
                        </div>
                        <form onSubmit={handleAddSubmit} className="p-6 space-y-4 text-sm">
                            <p className="text-slate-600 mb-2 leading-relaxed">
                                Enter the team member's role and email address. They will be able to log in using their Google account to access the platform.
                            </p>
                            <div>
                                <label className="block font-medium text-slate-700 mb-1">Email Address <span className="text-red-500">*</span></label>
                                <input required type="email" placeholder="email@company.com" className="w-full border-slate-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 px-3 py-2 border" value={addForm.email || ''} onChange={e => setAddForm({ ...addForm, email: e.target.value })} />
                            </div>
                            <div>
                                <label className="block font-medium text-slate-700 mb-1">Role</label>
                                <select className="w-full border-slate-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 px-3 py-2 border bg-white" value={addForm.role} onChange={e => setAddForm({ ...addForm, role: e.target.value })}>
                                    <option value="EMPLOYEE">Field Crew</option>
                                    <option value="MANAGER">Manager</option>
                                    <option value="FINANCE">Finance</option>
                                    <option value="ADMIN">Admin</option>
                                </select>
                            </div>

                            <div className="pt-4 flex justify-end gap-3 border-t border-slate-100 mt-6">
                                <button type="button" onClick={() => setIsAddingUser(false)} className="px-4 py-2 font-medium text-slate-700 hover:bg-slate-50 transition rounded-md">Cancel</button>
                                <button type="submit" className="px-4 py-2 bg-blue-600 text-white font-medium rounded-md hover:bg-blue-700 transition shadow-sm">Send Invite</button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
}
