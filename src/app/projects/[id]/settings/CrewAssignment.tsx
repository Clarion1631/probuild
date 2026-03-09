"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function CrewAssignment({
    projectId,
    currentCrew,
    allEmployees
}: {
    projectId: string,
    currentCrew: any[],
    allEmployees: any[]
}) {
    const router = useRouter();
    const [assignedIds, setAssignedIds] = useState<string[]>(currentCrew.map(c => c.id));
    const [isSaving, setIsSaving] = useState(false);
    const [message, setMessage] = useState("");

    const toggleAssignment = (employeeId: string) => {
        if (assignedIds.includes(employeeId)) {
            setAssignedIds(assignedIds.filter(id => id !== employeeId));
        } else {
            setAssignedIds([...assignedIds, employeeId]);
        }
    };

    const handleSave = async () => {
        setIsSaving(true);
        setMessage("");
        try {
            const res = await fetch(`/api/projects/${projectId}/crew`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ crewIds: assignedIds })
            });
            if (!res.ok) throw new Error("Failed to save crew");

            setMessage("Crew updated successfully");
            router.refresh();
        } catch (error: any) {
            setMessage(error.message);
        } finally {
            setIsSaving(false);
            setTimeout(() => setMessage(""), 3000);
        }
    };

    return (
        <div>
            <div className="space-y-3 max-h-96 overflow-y-auto mb-6 p-4 border border-slate-100 rounded-lg bg-slate-50">
                {allEmployees.map(emp => (
                    <label key={emp.id} className="flex items-center space-x-3 bg-white p-3 rounded-md shadow-sm border border-slate-200 cursor-pointer hover:bg-blue-50 transition">
                        <input
                            type="checkbox"
                            checked={assignedIds.includes(emp.id)}
                            onChange={() => toggleAssignment(emp.id)}
                            className="w-5 h-5 text-blue-600 rounded border-slate-300 focus:ring-blue-500"
                        />
                        <div>
                            <div className="font-medium text-slate-800">{emp.name || emp.email}</div>
                            <div className="text-xs text-slate-500">{emp.email}</div>
                        </div>
                    </label>
                ))}
                {allEmployees.length === 0 && (
                    <div className="text-slate-500 text-sm py-4 text-center">No employees found in the system.</div>
                )}
            </div>

            <div className="flex items-center gap-4">
                <button
                    onClick={handleSave}
                    disabled={isSaving}
                    className="bg-blue-600 text-white px-6 py-2 rounded shadow text-sm font-medium hover:bg-blue-700 transition disabled:opacity-50"
                >
                    {isSaving ? "Saving..." : "Save Assignments"}
                </button>
                {message && (
                    <span className={`text-sm \${message.includes("success") ? "text-green-600" : "text-red-600"}`}>
                        {message}
                    </span>
                )}
            </div>
        </div>
    );
}
