import { PrismaClient } from "@prisma/client";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, "../.env.local") });
dotenv.config({ path: path.join(__dirname, "../.env") });

const prisma = new PrismaClient();

async function main() {
    const contract = await prisma.contract.findUnique({
        where: { id: "cmqs45hz50001vly3oowv4z9k" }
    });

    if (contract) {
        console.log("Contract ID:", contract.id);
        console.log("Title:", contract.title);
        console.log("Status:", contract.status);
        console.log("approvedBy:", contract.approvedBy);
        console.log("approvedAt:", contract.approvedAt);
        console.log("signatureUrl:", contract.signatureUrl);
        console.log("contractorSignedBy:", contract.contractorSignedBy);
        console.log("contractorSignedAt:", contract.contractorSignedAt);
        console.log("contractorSignatureUrl:", contract.contractorSignatureUrl);
    } else {
        console.log("Contract not found");
    }
}

main()
    .catch(console.error)
    .finally(() => prisma.$disconnect());
