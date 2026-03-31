"use client";

import { useEffect } from "react";
import { markSubcontractorProjectViewed } from "@/lib/subcontractor-actions";

export default function ProjectViewTracker({ projectId, subcontractorId }: { projectId: string; subcontractorId: string }) {
    useEffect(() => {
        let mounted = true;
        
        async function track() {
            try {
                // Ensure we only mark it viewed once
                await markSubcontractorProjectViewed(projectId, subcontractorId);
            } catch (e) {
                console.error("Failed to track project view", e);
            }
        }
        
        if (mounted) {
            track();
        }

        return () => { mounted = false; };
    }, [projectId, subcontractorId]);

    return null;
}
