export type StatusType =
    | "In Progress"
    | "Closed"
    | "Paid, Ready to Start"
    | "Invoiced"
    | "Partially Paid"
    | "Sent";

interface StatusBadgeProps {
    status: StatusType;
}

export default function StatusBadge({ status }: StatusBadgeProps) {
    let bgColor = "bg-slate-100";
    let textColor = "text-slate-800";
    let dotColor = "bg-slate-500";

    switch (status) {
        case "In Progress":
            bgColor = "bg-green-50";
            textColor = "text-green-800";
            dotColor = "bg-green-500";
            break;
        case "Closed":
            bgColor = "bg-amber-50";
            textColor = "text-amber-800";
            dotColor = "bg-amber-500";
            break;
        case "Paid, Ready to Start":
            bgColor = "bg-slate-100";
            textColor = "text-slate-800";
            dotColor = "bg-slate-400";
            break;
        case "Invoiced":
            bgColor = "bg-emerald-50";
            textColor = "text-emerald-800";
            dotColor = "bg-emerald-500";
            break;
        case "Partially Paid":
            bgColor = "bg-orange-50";
            textColor = "text-orange-800";
            dotColor = "bg-orange-500";
            break;
        case "Sent":
            bgColor = "bg-blue-50";
            textColor = "text-blue-800";
            dotColor = "bg-blue-500";
            break;
    }

    return (
        <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium ${bgColor} ${textColor}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${dotColor}`}></span>
            {status}
        </span>
    );
}
