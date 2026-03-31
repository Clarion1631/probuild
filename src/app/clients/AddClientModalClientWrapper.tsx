"use client";

import { useState } from "react";
import AddClientModal from "./AddClientModal";

export default function AddClientModalClientWrapper() {
    const [isOpen, setIsOpen] = useState(false);

    return (
        <>
            <button
                onClick={() => setIsOpen(true)}
                className="hui-btn hui-btn-primary flex items-center gap-2"
            >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
                Add Client
            </button>

            {isOpen && <AddClientModal onClose={() => setIsOpen(false)} />}
        </>
    );
}
