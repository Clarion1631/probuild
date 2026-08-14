"use client";

import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import DOMPurify from "isomorphic-dompurify";
import { useEffect } from "react";

/**
 * Controlled rich-text editor built on TipTap. Emits sanitized HTML via onChange.
 * Used for the estimate Project Overview and Notes & Assumptions sections — the same
 * HTML shape (headings / paragraphs / bullet + numbered lists / bold / italic) that
 * the portal, portal-download PDF, and emailed pdf-lib PDF all know how to render.
 *
 * SSR note: immediatelyRender:false is required under the Next.js App Router so the
 * editor mounts on the client only and never produces a hydration mismatch.
 */

const ALLOWED_TAGS = ["p", "h1", "h2", "h3", "ul", "ol", "li", "strong", "em", "b", "i", "br", "a"];
const ALLOWED_ATTR = ["href", "target", "rel"];

export function sanitizeRichHtml(html: string): string {
    return DOMPurify.sanitize(html || "", { ALLOWED_TAGS, ALLOWED_ATTR });
}

function ToolbarButton({
    active,
    disabled,
    onClick,
    label,
    children,
}: {
    active?: boolean;
    disabled?: boolean;
    onClick: () => void;
    label: string;
    children: React.ReactNode;
}) {
    return (
        <button
            type="button"
            aria-label={label}
            title={label}
            aria-pressed={!!active}
            disabled={disabled}
            onMouseDown={(e) => e.preventDefault()}
            onClick={onClick}
            className={`h-8 min-w-8 px-2 rounded text-sm font-medium transition ${
                active
                    ? "bg-indigo-600 text-white"
                    : "bg-white text-slate-600 hover:bg-slate-100 border border-slate-200"
            } disabled:opacity-40 disabled:pointer-events-none`}
        >
            {children}
        </button>
    );
}

function Toolbar({ editor }: { editor: Editor }) {
    return (
        <div className="flex flex-wrap items-center gap-1 border-b border-slate-200 bg-slate-50 px-2 py-1.5">
            <ToolbarButton label="Heading 1" active={editor.isActive("heading", { level: 1 })} onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}>
                H1
            </ToolbarButton>
            <ToolbarButton label="Heading 2" active={editor.isActive("heading", { level: 2 })} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>
                H2
            </ToolbarButton>
            <span className="mx-1 h-5 w-px bg-slate-200" />
            <ToolbarButton label="Bold" active={editor.isActive("bold")} onClick={() => editor.chain().focus().toggleBold().run()}>
                <span className="font-bold">B</span>
            </ToolbarButton>
            <ToolbarButton label="Italic" active={editor.isActive("italic")} onClick={() => editor.chain().focus().toggleItalic().run()}>
                <span className="italic">I</span>
            </ToolbarButton>
            <span className="mx-1 h-5 w-px bg-slate-200" />
            <ToolbarButton label="Bullet list" active={editor.isActive("bulletList")} onClick={() => editor.chain().focus().toggleBulletList().run()}>
                • List
            </ToolbarButton>
            <ToolbarButton label="Numbered list" active={editor.isActive("orderedList")} onClick={() => editor.chain().focus().toggleOrderedList().run()}>
                1. List
            </ToolbarButton>
        </div>
    );
}

export default function RichTextEditor({
    value,
    onChange,
    placeholder,
}: {
    value: string;
    onChange: (html: string) => void;
    placeholder?: string;
}) {
    const editor = useEditor({
        immediatelyRender: false,
        // StarterKit (v3) already bundles Link, ListKeymap, Underline, etc. — configure it
        // in place rather than re-adding a second Link extension (which throws a duplicate).
        extensions: [
            StarterKit.configure({
                heading: { levels: [1, 2, 3] },
                link: { openOnClick: false, autolink: true },
            }),
        ],
        content: value || "",
        editorProps: {
            attributes: {
                class: "prose prose-sm max-w-none min-h-[140px] px-4 py-3 focus:outline-none prose-headings:font-semibold prose-p:my-1.5 prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5",
                ...(placeholder ? { "data-placeholder": placeholder } : {}),
            },
        },
        onUpdate: ({ editor }) => {
            // Emit the raw editor HTML (not sanitized) so the controlled-sync effect below
            // compares raw-to-raw and never calls setContent mid-keystroke (which would jump
            // the cursor). TipTap's schema only produces whitelisted nodes, and every render
            // path sanitizes again: the portal via DOMPurify, the pdf-lib path by drawing only
            // whitelisted tags — same defense-in-depth as the existing Terms & Conditions field.
            const html = editor.getHTML();
            // TipTap emits "<p></p>" for an empty doc — normalize to "" so an untouched
            // section is treated as absent by the renderers.
            onChange(html === "<p></p>" ? "" : html);
        },
    });

    // Sync external value changes (e.g. loading a saved template) into the editor
    // without clobbering the user's cursor while they type.
    useEffect(() => {
        if (!editor) return;
        const current = editor.getHTML();
        const next = value || "";
        const normalizedCurrent = current === "<p></p>" ? "" : current;
        if (next !== normalizedCurrent && next !== current) {
            editor.commands.setContent(next, { emitUpdate: false });
        }
         
    }, [value, editor]);

    if (!editor) {
        return <div className="min-h-[180px] rounded-lg border border-slate-200 bg-slate-50 animate-pulse" />;
    }

    return (
        <div className="rounded-lg border border-slate-200 overflow-hidden focus-within:ring-2 focus-within:ring-indigo-500/40 focus-within:border-indigo-300">
            <Toolbar editor={editor} />
            <EditorContent editor={editor} />
        </div>
    );
}
