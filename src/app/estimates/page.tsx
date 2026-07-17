export const dynamic = "force-dynamic";
import { getAllEstimates } from "@/lib/actions";
import EstimatesPageClient from "./EstimatesPageClient";

export default async function EstimatesPage() {
    const estimates = await getAllEstimates();
    // Serialize Decimal and Date fields before passing to client component
    const serialized = JSON.parse(JSON.stringify(estimates));
    return <EstimatesPageClient estimates={serialized} />;
}
