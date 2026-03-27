"use client";

import ProjectChat from "@/components/ProjectChat";

interface PortalChatSectionProps {
    projectId: string;
    clientName: string;
    clientEmail: string;
}

export default function PortalChatSection({ projectId, clientName, clientEmail }: PortalChatSectionProps) {
    return (
        <ProjectChat
            projectId={projectId}
            perspective="CLIENT"
            currentUserName={clientName}
            currentUserEmail={clientEmail}
        />
    );
}
