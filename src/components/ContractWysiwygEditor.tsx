"use client";

import { useEditor, EditorContent } from "@tiptap/react";
import { Node } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import { useState, useRef, useEffect } from "react";

// ─── MERGE FIELDS ───
export const MERGE_FIELDS = [
    {
        category: "Client", icon: "👤",
        fields: [
            { key: "client_name", label: "Name", example: "John Doe" },
            { key: "client_email", label: "Email", example: "john@example.com" },
            { key: "client_phone", label: "Phone", example: "(555) 123-4567" },
            { key: "client_address", label: "Address", example: "123 Main St, Los Angeles, CA 90001" },
        ]
    },
    {
        category: "Company", icon: "🏢",
        fields: [
            { key: "company_name", label: "Name", example: "Golden Touch Remodeling" },
            { key: "company_address", label: "Address", example: "456 Business Ave" },
            { key: "company_phone", label: "Phone", example: "(555) 987-6543" },
            { key: "company_email", label: "Email", example: "info@company.com" },
        ]
    },
    {
        category: "Project", icon: "📋",
        fields: [
            { key: "project_name", label: "Name", example: "Kitchen Remodel" },
            { key: "location", label: "Location", example: "123 Main St, Los Angeles" },
            { key: "estimate_total", label: "Estimate Total", example: "$45,000" },
        ]
    },
    {
        category: "Date", icon: "📅",
        fields: [
            { key: "date", label: "Today's Date", example: "March 10, 2026" },
            { key: "year", label: "Year", example: "2026" },
        ]
    },
    {
        category: "Signing", icon: "✍️",
        fields: [
            { key: "SIGNATURE_BLOCK", label: "Signature", example: "[ Click to Sign ]" },
            { key: "INITIAL_BLOCK", label: "Initials", example: "[ Click to Initial ]" },
            { key: "DATE_BLOCK", label: "Signed Date", example: "3/27/2026" },
        ]
    },
];

const FIELD_LABEL_MAP: Record<string, string> = {};
MERGE_FIELDS.forEach(cat => cat.fields.forEach(f => { FIELD_LABEL_MAP[f.key] = f.label; }));

const SIGNING_KEYS = new Set(["SIGNATURE_BLOCK", "INITIAL_BLOCK", "DATE_BLOCK"]);

// ─── HTML CONVERSION ───
// Before loading into Tiptap: wrap {{key}} in data-merge-field span so Tiptap can parse them
function htmlToEditorContent(html: string): string {
    return html.replace(/\{\{(\w+)\}\}/g, (_, key) =>
        `<span data-merge-field="${key}">{{${key}}}</span>`
    );
}

// After getting HTML from Tiptap: strip wrapper spans, restore {{key}}
function editorContentToHtml(html: string): string {
    // <span data-merge-field="key" ...>anything</span> → {{key}}
    return html.replace(/<span[^>]*data-merge-field="(\w+)"[^>]*>[^<]*<\/span>/g, "{{$1}}");
}

// ─── CUSTOM MERGE FIELD NODE ───
const MergeFieldNode = Node.create({
    name: "mergeField",
    group: "inline",
    inline: true,
    atom: true, // cursor treats it as a single unit

    addAttributes() {
        return {
            key: { default: null },
        };
    },

    parseHTML() {
        return [{
            tag: "span[data-merge-field]",
            getAttrs: (el) => ({
                key: (el as HTMLElement).getAttribute("data-merge-field"),
            }),
        }];
    },

    renderHTML({ node }) {
        const key = node.attrs.key as string;
        const label = FIELD_LABEL_MAP[key] || key;
        const isSigning = SIGNING_KEYS.has(key);

        const style = isSigning
            ? "background:#fff1f2;color:#be185d;border:1px solid #fecdd3;padding:1px 8px;border-radius:4px;font-size:0.75rem;font-weight:600;white-space:nowrap;font-style:normal;"
            : "background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe;padding:1px 8px;border-radius:4px;font-size:0.75rem;font-weight:600;white-space:nowrap;font-style:normal;";

        return ["span", { "data-merge-field": key, style, contenteditable: "false" }, `⟨${label}⟩`];
    },
});

// ─── COMPONENT ───
interface ContractWysiwygEditorProps {
    value: string;
    onChange: (html: string) => void;
}

export function ContractWysiwygEditor({ value, onChange }: ContractWysiwygEditorProps) {
    const [openDropdown, setOpenDropdown] = useState<string | null>(null);
    const toolbarRef = useRef<HTMLDivElement>(null);
    const lastEmittedRef = useRef(value);

    const editor = useEditor({
        extensions: [
            StarterKit,
            Underline,
            MergeFieldNode,
        ],
        content: htmlToEditorContent(value),
        onUpdate: ({ editor }) => {
            const html = editorContentToHtml(editor.getHTML());
            lastEmittedRef.current = html;
            onChange(html);
        },
        editorProps: {
            attributes: {
                class: "prose prose-sm max-w-none focus:outline-none p-6 min-h-full font-sans text-slate-800",
            },
        },
        immediatelyRender: false,
    });

    // Sync when value is updated externally (e.g. contract opens with existing body)
    useEffect(() => {
        if (editor && value !== lastEmittedRef.current) {
            editor.commands.setContent(htmlToEditorContent(value), { emitUpdate: false });
            lastEmittedRef.current = value;
        }
    }, [value, editor]);

    // Close dropdown on click-outside
    useEffect(() => {
        if (!openDropdown) return;
        const handler = (e: MouseEvent) => {
            if (toolbarRef.current && !toolbarRef.current.contains(e.target as globalThis.Node)) {
                setOpenDropdown(null);
            }
        };
        document.addEventListener("mousedown", handler);
        return () => document.removeEventListener("mousedown", handler);
    }, [openDropdown]);

    const insertMergeField = (key: string) => {
        if (!editor) return;
        if (SIGNING_KEYS.has(key)) {
            // Signing blocks go on their own paragraph
            editor.chain().focus()
                .insertContent({
                    type: "paragraph",
                    content: [{ type: "mergeField", attrs: { key } }],
                })
                .run();
        } else {
            editor.chain().focus()
                .insertContent({ type: "mergeField", attrs: { key } })
                .run();
        }
        setOpenDropdown(null);
    };

    const dataCategories = MERGE_FIELDS.filter(c => c.category !== "Signing");
    const signingCategory = MERGE_FIELDS.find(c => c.category === "Signing")!;

    return (
        <div className="flex flex-col flex-1 overflow-hidden">
            {/* Insert Toolbar */}
            <div ref={toolbarRef} className="bg-slate-50 border-b border-slate-200 px-6 py-2.5 shrink-0">
                <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider shrink-0">Insert:</span>
                    {dataCategories.map(cat => (
                        <div key={cat.category} className="relative">
                            <button
                                type="button"
                                onClick={() => setOpenDropdown(openDropdown === cat.category ? null : cat.category)}
                                className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-md border border-slate-200 bg-white hover:bg-slate-50 text-slate-600 transition"
                            >
                                <span>{cat.icon}</span>
                                <span>{cat.category}</span>
                                <svg className="w-3 h-3 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                                </svg>
                            </button>
                            {openDropdown === cat.category && (
                                <div className="absolute top-full left-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-lg z-20 min-w-[190px]">
                                    {cat.fields.map(f => (
                                        <button
                                            key={f.key}
                                            type="button"
                                            onClick={() => insertMergeField(f.key)}
                                            className="w-full text-left px-3 py-2 text-xs hover:bg-slate-50 flex items-center justify-between gap-4 first:rounded-t-lg last:rounded-b-lg"
                                        >
                                            <span className="font-medium text-slate-700">{f.label}</span>
                                            <span className="text-slate-400 text-[10px] truncate max-w-[100px]">&ldquo;{f.example}&rdquo;</span>
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                    ))}
                    <div className="w-px h-5 bg-slate-300 mx-1 shrink-0" />
                    <div className="flex items-center gap-1.5 border border-rose-200 rounded-md px-2.5 py-1 bg-rose-50">
                        <span className="text-xs font-semibold text-rose-600 shrink-0">Signing:</span>
                        {signingCategory.fields.map(f => (
                            <button
                                key={f.key}
                                type="button"
                                onClick={() => insertMergeField(f.key)}
                                className="px-2 py-0.5 text-xs font-medium rounded bg-rose-100 text-rose-700 hover:bg-rose-200 transition"
                                title={`Insert ${f.label} block`}
                            >{f.label}</button>
                        ))}
                    </div>
                </div>
            </div>

            {/* Format Toolbar */}
            <div className="bg-white border-b border-slate-200 px-6 py-2 shrink-0 flex items-center gap-1 flex-wrap">
                <span className="text-xs font-semibold text-slate-500 mr-2">Format:</span>
                {[
                    { label: "H2", title: "Heading 2", action: () => editor?.chain().focus().toggleHeading({ level: 2 }).run(), active: () => editor?.isActive("heading", { level: 2 }), cls: "font-bold" },
                    { label: "H3", title: "Heading 3", action: () => editor?.chain().focus().toggleHeading({ level: 3 }).run(), active: () => editor?.isActive("heading", { level: 3 }), cls: "font-semibold" },
                    { label: "B", title: "Bold (Ctrl+B)", action: () => editor?.chain().focus().toggleBold().run(), active: () => editor?.isActive("bold"), cls: "font-bold" },
                    { label: "I", title: "Italic (Ctrl+I)", action: () => editor?.chain().focus().toggleItalic().run(), active: () => editor?.isActive("italic"), cls: "italic" },
                    { label: "U", title: "Underline (Ctrl+U)", action: () => editor?.chain().focus().toggleUnderline().run(), active: () => editor?.isActive("underline"), cls: "underline" },
                ].map(btn => (
                    <button
                        key={btn.label}
                        type="button"
                        onClick={btn.action}
                        title={btn.title}
                        className={`px-2 py-1 text-xs rounded transition ${btn.cls} ${btn.active?.() ? "bg-slate-200 text-slate-900" : "hover:bg-slate-100 text-slate-700"}`}
                    >{btn.label}</button>
                ))}
                <div className="w-px h-5 bg-slate-200 mx-1" />
                <button
                    type="button"
                    onClick={() => editor?.chain().focus().toggleBulletList().run()}
                    className={`px-2 py-1 text-xs rounded transition ${editor?.isActive("bulletList") ? "bg-slate-200 text-slate-900" : "hover:bg-slate-100 text-slate-700"}`}
                >• List</button>
                <button
                    type="button"
                    onClick={() => editor?.chain().focus().toggleOrderedList().run()}
                    className={`px-2 py-1 text-xs rounded transition ${editor?.isActive("orderedList") ? "bg-slate-200 text-slate-900" : "hover:bg-slate-100 text-slate-700"}`}
                >1. List</button>
                <div className="w-px h-5 bg-slate-200 mx-1" />
                <button type="button" onClick={() => editor?.chain().focus().setHorizontalRule().run()} className="px-2 py-1 text-xs rounded hover:bg-slate-100 text-slate-700 transition">― Line</button>
                <button type="button" onClick={() => editor?.chain().focus().setHardBreak().run()} className="px-2 py-1 text-xs rounded hover:bg-slate-100 text-slate-700 transition">↵ Break</button>
                <div className="w-px h-5 bg-slate-200 mx-1" />
                <button
                    type="button"
                    onClick={() => editor?.chain().focus().undo().run()}
                    disabled={!editor?.can().undo()}
                    className="px-2 py-1 text-xs rounded hover:bg-slate-100 text-slate-700 transition disabled:opacity-30"
                    title="Undo (Ctrl+Z)"
                >↩ Undo</button>
                <button
                    type="button"
                    onClick={() => editor?.chain().focus().redo().run()}
                    disabled={!editor?.can().redo()}
                    className="px-2 py-1 text-xs rounded hover:bg-slate-100 text-slate-700 transition disabled:opacity-30"
                    title="Redo (Ctrl+Shift+Z)"
                >↪ Redo</button>
            </div>

            {/* WYSIWYG Editing Surface */}
            <div className="flex-1 overflow-auto bg-slate-50">
                <div className="max-w-3xl mx-auto my-6 bg-white rounded-lg shadow-sm border border-slate-200 min-h-[600px]">
                    <EditorContent editor={editor} className="h-full" />
                </div>
            </div>
        </div>
    );
}
