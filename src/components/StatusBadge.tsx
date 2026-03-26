export type StatusType =
    | "In Progress"
    | "Closed"
    | "Paid, Ready to Start"
    | "Invoiced"
    | "Partially Paid"
    | "Sent"
    | "Draft"
    | "Issued"
    | "Paid"
    | "Overdue"
    | "Pending"
    | "Canceled"
    | "Approved"
    | "Not Started";

interface StatusBadgeProps {
    status: StatusType | string;
}

const STATUS_MAP: Record<string, { bg: string; text: string; dot: string }> = {
    "In Progress": { bg: "bg-green-50", text: "text-green-800", dot: "bg-green-500" },
    "Closed": { bg: "bg-amber-50", text: "text-amber-800", dot: "bg-amber-500" },
    "Paid, Ready to Start": { bg: "bg-slate-100", text: "text-slate-800", dot: "bg-slate-400" },
    "Invoiced": { bg: "bg-emerald-50", text: "text-emerald-800", dot: "bg-emerald-500" },
    "Partially Paid": { bg: "bg-orange-50", text: "text-orange-800", dot: "bg-orange-500" },
    "Sent": { bg: "bg-blue-50", text: "text-blue-800", dot: "bg-blue-500" },
    "Draft": { bg: "bg-slate-100", text: "text-slate-700", dot: "bg-slate-400" },
    "Issued": { bg: "bg-blue-50", text: "text-blue-800", dot: "bg-blue-500" },
    "Paid": { bg: "bg-emerald-50", text: "text-emerald-800", dot: "bg-emerald-500" },
    "Overdue": { bg: "bg-red-50", text: "text-red-800", dot: "bg-red-500" },
    "Pending": { bg: "bg-yellow-50", text: "text-yellow-800", dot: "bg-yellow-500" },
    "Canceled": { bg: "bg-slate-100", text: "text-slate-500", dot: "bg-slate-400" },
    "Approved": { bg: "bg-emerald-50", text: "text-emerald-800", dot: "bg-emerald-500" },
    "Not Started": { bg: "bg-slate-100", text: "text-slate-600", dot: "bg-slate-400" },
};

export default function StatusBadge({ status }: StatusBadgeProps) {
    const colors = STATUS_MAP[status] || { bg: "bg-slate-100", text: "text-slate-800", dot: "bg-slate-500" };

    return (
        <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium ${colors.bg} ${colors.text}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${colors.dot}`}></span>
            {status}
        </span>
    );
}
