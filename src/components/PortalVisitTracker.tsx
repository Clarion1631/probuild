"use client";

import { useEffect, useRef } from "react";
import { logPortalVisit } from "@/lib/actions";

interface PortalVisitTrackerProps {
    projectId: string;
    clientName: string;
}

export default function PortalVisitTracker({ projectId, clientName }: PortalVisitTrackerProps) {
    const logged = useRef(false);

    useEffect(() => {
        if (!logged.current) {
            logged.current = true;
            logPortalVisit(projectId, clientName);
        }
    }, [projectId, clientName]);

    return null;
}
