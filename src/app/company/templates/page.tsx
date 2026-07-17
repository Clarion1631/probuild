"use client";
export const dynamic = "force-dynamic";

import DocumentTemplateManager from "@/components/DocumentTemplateManager";

export default function TemplatesPage() {
    return (
        <DocumentTemplateManager
            showTypeSelector={true}
            title="Document Templates"
            description="Manage terms & conditions, contracts, and disclaimers"
        />
    );
}
