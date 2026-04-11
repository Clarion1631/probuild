/**
 * DocumentCode — renders formatted document codes like ES-10085, IN-10046
 * from a document type prefix and auto-increment number.
 *
 * Usage:
 *   <DocumentCode type="estimate" number={10085} />
 *   → ES-10085
 *
 *   <DocumentCode type="invoice" number={10046} />
 *   → IN-10046
 */

const TYPE_MAP: Record<string, { prefix: string; color: string }> = {
    estimate: { prefix: "ES", color: "text-blue-700 bg-blue-50 border-blue-200" },
    invoice: { prefix: "IN", color: "text-emerald-700 bg-emerald-50 border-emerald-200" },
    "change-order": { prefix: "CO", color: "text-amber-700 bg-amber-50 border-amber-200" },
    "purchase-order": { prefix: "PO", color: "text-purple-700 bg-purple-50 border-purple-200" },
    contract: { prefix: "CT", color: "text-slate-700 bg-slate-50 border-slate-200" },
    retainer: { prefix: "RT", color: "text-teal-700 bg-teal-50 border-teal-200" },
    expense: { prefix: "EX", color: "text-red-700 bg-red-50 border-red-200" },
    lead: { prefix: "LD", color: "text-orange-700 bg-orange-50 border-orange-200" },
    payment: { prefix: "PM", color: "text-green-700 bg-green-50 border-green-200" },
};

interface DocumentCodeProps {
    type: string;
    number: number;
    className?: string;
}

export default function DocumentCode({ type, number, className = "" }: DocumentCodeProps) {
    const config = TYPE_MAP[type.toLowerCase()] || { prefix: type.slice(0, 2).toUpperCase(), color: "text-slate-700 bg-slate-50 border-slate-200" };
    const code = `${config.prefix}-${String(number).padStart(5, "0")}`;

    return (
        <span className={`inline-flex items-center px-2 py-0.5 rounded border text-xs font-mono font-semibold tracking-wide ${config.color} ${className}`}>
            {code}
        </span>
    );
}
