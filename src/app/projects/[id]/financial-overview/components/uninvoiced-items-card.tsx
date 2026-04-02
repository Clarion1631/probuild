"use client";

import { Card } from "@/components/ui/card";
import { CheckCircle2, AlertCircle } from "lucide-react";
import { useRouter } from "next/navigation";

export default function UninvoicedItemsCard({ projectId, uninvoiced }: { projectId: string; uninvoiced: any }) {
    const router = useRouter();
    const formatCurrency = (val: number) => 
        new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(val || 0);

    return (
        <Card className="flex flex-col border-gray-200 bg-white h-full shadow-sm hover:shadow-md transition cursor-pointer" onClick={() => router.push(`/projects/${projectId}/invoices/new`)}>
            <div className="p-5 border-b border-gray-100 bg-gray-50/50">
                <h3 className="font-semibold text-gray-900 flex items-center gap-2">
                    Uninvoiced Items
                </h3>
            </div>
            <div className="p-5 flex-1 flex flex-col justify-center">
                {!uninvoiced.hasItems ? (
                    <div className="flex items-center gap-3">
                        <CheckCircle2 size={32} className="text-emerald-500" />
                        <div>
                            <p className="text-sm font-medium text-gray-900">No uninvoiced items</p>
                            <p className="text-xs text-gray-500">All set for now!</p>
                        </div>
                    </div>
                ) : (
                    <div className="flex items-center gap-3">
                        <AlertCircle size={32} className="text-amber-500" />
                        <div>
                            <p className="text-2xl font-bold text-gray-900">{formatCurrency(uninvoiced.totalAmount)}</p>
                            <p className="text-sm text-gray-500">{uninvoiced.count} Items pending</p>
                        </div>
                    </div>
                )}
            </div>
        </Card>
    );
}
