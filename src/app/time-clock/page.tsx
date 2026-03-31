export const dynamic = "force-dynamic";
"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";

export default function TimeClockPage() {
    const router = useRouter();
    const [status, setStatus] = useState<"Clocked Out" | "Clocked In">("Clocked Out");
    const [currentTimeEntryId, setCurrentTimeEntryId] = useState<string | null>(null);
    const [location, setLocation] = useState<{ lat: number, lng: number } | null>(null);
    const [error, setError] = useState<string>("");

    const [projects, setProjects] = useState<any[]>([]);
    const [selectedProject, setSelectedProject] = useState<string>("");

    const [costCodes, setCostCodes] = useState<any[]>([]);
    const [selectedCostCode, setSelectedCostCode] = useState<string>("");

    useEffect(() => {
        // Fetch only projects the current user is assigned to
        fetch('/api/projects?assigned=true')
            .then(res => res.json())
            .then(data => {
                if (Array.isArray(data)) {
                    setProjects(data);
                }
            })
            .catch(e => console.error("Could not fetch projects", e));

        // Fetch active time entry
        fetch('/api/time-entries')
            .then(res => res.json())
            .then(data => {
                const active = data.find((te: any) => !te.endTime);
                if (active) {
                    setStatus("Clocked In");
                    setCurrentTimeEntryId(active.id);
                    setSelectedProject(active.projectId);
                    setSelectedCostCode(active.costCodeId || "");
                }
            })
            .catch(e => console.error("Could not fetch time entries", e));
    }, []);

    useEffect(() => {
        if (!selectedProject) {
            setCostCodes([]);
            setSelectedCostCode("");
            return;
        }

        // Fetch cost codes used in the selected project's estimates
        fetch(`/api/projects/${selectedProject}/cost-codes`)
            .then(res => res.json())
            .then(data => {
                if (Array.isArray(data)) {
                    setCostCodes(data);
                }
            })
            .catch(e => console.error("Could not fetch cost codes", e));

    }, [selectedProject]);

    const getLocation = (): Promise<{ lat: number, lng: number }> => {
        return new Promise((resolve, reject) => {
            if (!navigator.geolocation) {
                reject("Geolocation is not supported by your browser");
            } else {
                navigator.geolocation.getCurrentPosition((position) => {
                    resolve({
                        lat: position.coords.latitude,
                        lng: position.coords.longitude
                    });
                }, () => {
                    reject("Unable to retrieve your location");
                });
            }
        });
    };

    const handleClockInOut = async () => {
        setError("");
        let loc = null;
        try {
            loc = await getLocation();
            setLocation(loc);
        } catch (e: any) {
            setError(e);
        }

        if (status === "Clocked Out") {
            if (!selectedProject) {
                setError("Please select a project before clocking in.");
                return;
            }

            try {
                const res = await fetch('/api/time-entries', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        projectId: selectedProject,
                        costCodeId: selectedCostCode || null,
                        latitude: loc?.lat,
                        longitude: loc?.lng
                    })
                });
                const data = await res.json();
                if (data.error) throw new Error(data.error);

                setStatus("Clocked In");
                setCurrentTimeEntryId(data.id);
            } catch (err: any) {
                setError(err.message);
            }
        } else {
            try {
                if (!currentTimeEntryId) return;

                const res = await fetch('/api/time-entries', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        id: currentTimeEntryId,
                        latitude: loc?.lat,
                        longitude: loc?.lng
                    })
                });
                const data = await res.json();
                if (data.error) throw new Error(data.error);

                setStatus("Clocked Out");
                setCurrentTimeEntryId(null);
                setSelectedProject("");
                setSelectedCostCode("");
            } catch (err: any) {
                setError(err.message);
            }
        }
    };

    const typeColors: Record<string, string> = {
        Labor: "text-blue-600",
        Material: "text-amber-600",
        Subcontractor: "text-purple-600",
        Equipment: "text-green-600",
    };

    return (
        <div className="max-w-xl mx-auto py-12 px-6">
            <h1 className="text-2xl font-bold text-hui-textMain mb-8">Time Clock</h1>

            <div className="hui-card p-8 text-center">
                <div className={`text-sm font-semibold mb-6 ${status === 'Clocked In' ? 'text-green-600' : 'text-slate-500'}`}>
                    Status: {status}
                </div>

                {status === "Clocked Out" && (
                    <div className="mb-8 text-left space-y-4">
                        <div>
                            <label className="block text-sm font-medium text-slate-700 mb-2">Project</label>
                            <select
                                value={selectedProject}
                                onChange={(e) => setSelectedProject(e.target.value)}
                                className="hui-input"
                            >
                                <option value="">Select a Project...</option>
                                {projects.map(p => (
                                    <option key={p.id} value={p.id}>{p.name}</option>
                                ))}
                            </select>
                            {projects.length === 0 && (
                                <p className="text-xs text-amber-600 mt-1">No projects assigned to you. Ask your manager to assign you.</p>
                            )}
                        </div>

                        {costCodes.length > 0 && (
                            <div>
                                <label className="block text-sm font-medium text-slate-700 mb-2">Phase / Cost Code</label>
                                <select
                                    value={selectedCostCode}
                                    onChange={(e) => setSelectedCostCode(e.target.value)}
                                    className="hui-input"
                                >
                                    <option value="">Select a Phase...</option>
                                    {costCodes.map(cc => (
                                        <option key={cc.id} value={cc.id}>
                                            {cc.code} — {cc.name}
                                        </option>
                                    ))}
                                </select>
                            </div>
                        )}
                    </div>
                )}

                {status === "Clocked In" && selectedProject && (
                    <div className="mb-6 text-left">
                        <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                            <div className="text-sm text-green-800 font-medium">
                                Currently working on: {projects.find(p => p.id === selectedProject)?.name || "Unknown Project"}
                            </div>
                            {selectedCostCode && (
                                <div className="text-xs text-green-700 mt-1">
                                    Phase: {costCodes.find(cc => cc.id === selectedCostCode)?.name || ""}
                                </div>
                            )}
                        </div>
                    </div>
                )}

                {error && (
                    <div className="mb-6 p-4 bg-red-50 text-red-600 rounded-lg text-sm text-left">
                        {error}
                    </div>
                )}

                <button
                    onClick={handleClockInOut}
                    className={`hui-btn w-full py-4 text-lg font-bold
                        ${status === 'Clocked In' ? 'bg-red-500 hover:bg-red-600 text-white' : 'hui-btn-green'}
                    `}
                >
                    {status === 'Clocked In' ? 'Clock Out' : 'Clock In'}
                </button>

                {location && (
                    <div className="mt-6 text-xs text-slate-400">
                        Location captured: {location.lat.toFixed(4)}, {location.lng.toFixed(4)}
                    </div>
                )}
            </div>
        </div>
    );
}

