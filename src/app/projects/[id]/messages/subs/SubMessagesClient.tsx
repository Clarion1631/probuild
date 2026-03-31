"use client";

import { useState } from "react";
import ProjectChat from "@/components/ProjectChat";

interface Subcontractor {
    id: string;
    companyName: string;
    contactName: string | null;
}

export default function SubMessagesClient({
    projectId,
    projectName,
    subcontractors,
    currentUserName,
    currentUserEmail,
}: {
    projectId: string;
    projectName: string;
    subcontractors: Subcontractor[];
    currentUserName: string;
    currentUserEmail?: string;
}) {
    const [selectedSubId, setSelectedSubId] = useState<string>(subcontractors[0]?.id || "");

    return (
        <div className="max-w-3xl mx-auto py-6 px-4">
            <div className="mb-6">
                <h1 className="text-2xl font-bold text-hui-textMain">Subcontractor Messages</h1>
                <p className="text-sm text-hui-textMuted mt-1">
                    Conversation with subcontractors for <span className="font-medium">{projectName}</span>
                </p>
            </div>

            {subcontractors.length === 0 ? (
                <div className="hui-card p-8 flex flex-col justify-center items-center text-center">
                    <p className="font-medium text-hui-textMain">No subcontractors</p>
                    <p className="text-sm text-hui-textMuted">No active subcontractors are assigned to or available for this project.</p>
                </div>
            ) : (
                <div className="flex flex-col gap-4">
                    <div className="flex items-center gap-3">
                        <label className="text-sm font-medium text-hui-textMain shrink-0">Select Subcontractor:</label>
                        <select 
                            className="hui-input flex-1" 
                            value={selectedSubId} 
                            onChange={(e) => setSelectedSubId(e.target.value)}
                        >
                            {subcontractors.map((sub) => (
                                <option key={sub.id} value={sub.id}>
                                    {sub.companyName} {sub.contactName ? `(${sub.contactName})` : ''}
                                </option>
                            ))}
                        </select>
                    </div>

                    {selectedSubId && (
                        <ProjectChat
                            key={selectedSubId} // Force remount on changed sub to flush state
                            projectId={projectId}
                            perspective="TEAM"
                            subcontractorId={selectedSubId}
                            currentUserName={currentUserName}
                            currentUserEmail={currentUserEmail}
                        />
                    )}
                </div>
            )}
        </div>
    );
}
