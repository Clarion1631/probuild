"use client";

import { useState } from "react";
import AddLeadModal from "./AddLeadModal";

export default function AddLeadButton() {
    const [isOpen, setIsOpen] = useState(false);

    return (
        <>
            <button onClick={() => setIsOpen(true)} className="hui-btn hui-btn-primary">Add Lead</button>
            {isOpen && <AddLeadModal onClose={() => setIsOpen(false)} />}
        </>
    );
}
