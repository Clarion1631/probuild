"use client";

import { MergeFieldEditor } from "./MergeFieldEditor";
import { MERGE_FIELD_CATEGORIES } from "@/lib/merge-fields";

interface ContractWysiwygEditorProps {
    value: string;
    onChange: (html: string) => void;
}

export function ContractWysiwygEditor({ value, onChange }: ContractWysiwygEditorProps) {
    const dataCategories = MERGE_FIELD_CATEGORIES.filter(c => c.category !== "Signing");
    return (
        <MergeFieldEditor
            value={value}
            onChange={onChange}
            mergeFieldCategories={dataCategories}
            signingSection={true}
        />
    );
}
