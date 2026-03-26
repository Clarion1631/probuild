"use client";

import { useState } from "react";
import SignaturePad from "./SignaturePad";

interface DocumentSignModalProps {
    isOpen: boolean;
    onClose: () => void;
    mode: "signature" | "initials";
    onSign: (dataUrl: string, nameOrInitial: string) => void;
}

export default function DocumentSignModal({ isOpen, onClose, mode, onSign }: DocumentSignModalProps) {
    const [signatureData, setSignatureData] = useState<string | null>(null);
    const [typedName, setTypedName] = useState("");
    const [error, setError] = useState("");

    if (!isOpen) return null;

    const handleConfirm = () => {
        if (!typedName.trim()) {
            setError(`Please type your legal ${mode === "initials" ? "initials" : "name"}.`);
            return;
        }
        if (!signatureData) {
            setError(`Please draw your ${mode === "initials" ? "initials" : "signature"}.`);
            return;
        }
        setError("");
        onSign(signatureData, typedName.trim());
    };

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4">
            <div className="bg-white rounded-xl shadow-2xl max-w-lg w-full p-6 animate-in fade-in zoom-in-95 duration-200">
                <div className="flex justify-between items-center mb-6">
                    <h2 className="text-xl font-bold text-slate-800">
                        Adopt {mode === "initials" ? "Initials" : "Signature"}
                    </h2>
                    <button onClick={onClose} className="text-slate-400 hover:text-slate-600 transition">
                        <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" /></svg>
                    </button>
                </div>

                <div className="space-y-6">
                    <div>
                        <label className="block text-sm font-semibold text-slate-700 mb-2">
                            Type your {mode === "initials" ? "Initials" : "Full Legal Name"}
                        </label>
                        <input
                            type="text"
                            value={typedName}
                            onChange={(e) => setTypedName(e.target.value)}
                            placeholder={mode === "initials" ? "e.g. JD" : "e.g. John Doe"}
                            className="w-full px-4 py-2.5 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                            autoFocus
                        />
                    </div>

                    <div>
                        <label className="block text-sm font-semibold text-slate-700 mb-2">
                            Draw your {mode === "initials" ? "Initials" : "Signature"}
                        </label>
                        <SignaturePad 
                            onSignatureChange={setSignatureData} 
                            width={450} 
                            height={mode === "initials" ? 150 : 200} 
                        />
                    </div>

                    {error && <p className="text-red-500 text-sm font-medium">{error}</p>}

                    <div className="bg-slate-50 border border-slate-200 p-4 rounded-lg text-xs leading-relaxed text-slate-600">
                        <strong>ESIGN Act Disclosure:</strong> By clicking "Adopt & Sign," I agree that my electronic signature and initials are the legally binding equivalent to my handwritten signature, under the U.S. Electronic Signatures in Global and National Commerce Act (ESIGN) and UETA.
                    </div>

                    <div className="flex justify-end gap-3 pt-2">
                        <button
                            onClick={onClose}
                            className="px-5 py-2.5 rounded-lg text-sm font-semibold text-slate-600 hover:bg-slate-100 transition"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={handleConfirm}
                            className="px-6 py-2.5 rounded-lg text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 transition"
                        >
                            Adopt & Sign
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
