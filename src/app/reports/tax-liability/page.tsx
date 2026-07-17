import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default function TaxLiabilityPage() {
    redirect("/reports/sales-tax");
}
