"use client";

const Card = ({ className, children, onClick }: { className?: string, children: React.ReactNode, onClick?: () => void }) => (
    <div onClick={onClick} className={`rounded-xl border bg-white text-slate-950 shadow ${className}`}>{children}</div>
);
import { Clock } from "lucide-react";
import { useRouter } from "next/navigation";

export default function TimeLoggedCard({ projectId, timeLogged }: { projectId: string; timeLogged: any }) {
    const router = useRouter();
    const formatCurrency = (val: number) => 
        new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(val || 0);

    return (
        <Card className="flex flex-col border-gray-200 bg-white h-full shadow-sm hover:shadow-md transition cursor-pointer" onClick={() => router.push(`/projects/${projectId}/timeclock`)}>
            <div className="p-5 border-b border-gray-100 bg-gray-50/50">
                <h3 className="font-semibold text-gray-900 flex items-center gap-2">
                    <Clock size={16} className="text-gray-400" /> Time Logged
                </h3>
            </div>
            <div className="p-5 flex-1 flex flex-col justify-center">
                {!timeLogged.hasEntries ? (
                    <div className="text-center py-4">
                        <p className="text-sm text-gray-500">Your data will appear here once you create time entries</p>
                    </div>
                ) : (
                    <div className="flex justify-between items-center">
                        <div>
                            <p className="text-xs text-gray-500 font-medium uppercase tracking-wider mb-1">Total Hours</p>
                            <p className="text-2xl font-bold text-gray-900">{timeLogged.totalHours.toFixed(2)}h</p>
                        </div>
                        <div className="text-right">
                            <p className="text-xs text-gray-500 font-medium uppercase tracking-wider mb-1">Total Cost</p>
                            <p className="text-2xl font-bold text-gray-900">{formatCurrency(timeLogged.totalCost)}</p>
                        </div>
                    </div>
                )}
            </div>
        </Card>
    );
}
