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

    const [buckets, setBuckets] = useState<any[]>([]);
    const [selectedBucket, setSelectedBucket] = useState<string>("");

    useEffect(() => {
        // Fetch projects for assignment
        fetch('/api/projects') // Assuming there is an endpoint or we can server-side render this
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
                    setSelectedBucket(active.budgetBucketId || "");
                }
            })
            .catch(e => console.error("Could not fetch time entries", e));
    }, []);

    useEffect(() => {
        if (!selectedProject) {
            setBuckets([]);
            setSelectedBucket("");
            return;
        }

        // Fetch buckets for project
        fetch(`/api/projects/${selectedProject}/buckets`)
            .then(res => res.json())
            .then(data => {
                if (Array.isArray(data)) {
                    setBuckets(data);
                }
            })
            .catch(e => console.error("Could not fetch buckets", e));

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
            // Can decide to block clock in if location is required
        }

        if (status === "Clocked Out") {
            if (!selectedProject) {
                setError("Please select a project before clocking in.");
                return;
            }

            // Clock In
            try {
                const res = await fetch('/api/time-entries', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        projectId: selectedProject,
                        budgetBucketId: selectedBucket || null,
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
            // Clock Out
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
                setSelectedBucket("");
            } catch (err: any) {
                setError(err.message);
            }
        }
    };

    return (
        <div className="max-w-xl mx-auto py-12 px-6">
            <h1 className="text-3xl font-bold mb-8">Time Clock</h1>

            <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-8 text-center">
                <div className={`text-sm font-semibold mb-6 \${status === 'Clocked In' ? 'text-green-600' : 'text-slate-500'}`}>
                    Status: {status}
                </div>

                {status === "Clocked Out" && (
                    <div className="mb-8 text-left">
                        <label className="block text-sm font-medium text-slate-700 mb-2">Project</label>
                        <select
                            value={selectedProject}
                            onChange={(e) => setSelectedProject(e.target.value)}
                            className="w-full border border-slate-300 rounded-lg px-4 py-2 focus:ring-2 focus:ring-blue-500 focus:outline-none"
                        >
                            <option value="">Select a Project...</option>
                            {projects.map(p => (
                                <option key={p.id} value={p.id}>{p.name}</option>
                            ))}
                        </select>

                        {buckets.length > 0 && (
                            <div className="mt-4">
                                <label className="block text-sm font-medium text-slate-700 mb-2">Phase / Bucket (Optional)</label>
                                <select
                                    value={selectedBucket}
                                    onChange={(e) => setSelectedBucket(e.target.value)}
                                    className="w-full border border-slate-300 rounded-lg px-4 py-2 focus:ring-2 focus:ring-blue-500 focus:outline-none"
                                >
                                    <option value="">Select a Phase...</option>
                                    {buckets.map(b => (
                                        <option key={b.id} value={b.id}>{b.name}</option>
                                    ))}
                                </select>
                            </div>
                        )}
                    </div>
                )}

                {error && (
                    <div className="mb-6 p-4 bg-red-50 text-red-600 rounded-lg text-sm text-left">
                        {error}
                    </div>
                )}

                <button
                    onClick={handleClockInOut}
                    className={`w-full py-6 rounded-2xl text-2xl font-bold text-white shadow-lg transition transform hover:scale-105 active:scale-95
                        \${status === 'Clocked In' ? 'bg-red-500 hover:bg-red-600 shadow-red-200' : 'bg-green-500 hover:bg-green-600 shadow-green-200'}
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
