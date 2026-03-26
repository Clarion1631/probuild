import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();

async function main() {
  const contractId = 'test-token-contract';
  
  // Upsert the test contract
  await p.contract.upsert({
    where: { id: contractId },
    update: { status: 'Sent' }, // ensure it's not Signed
    create: {
      id: contractId,
      title: 'Monthly Subcontractor Lien Waiver (TEST)',
      status: 'Sent',
      recurringDays: 30, // Example for recurring logic
      body: `
        <h2>Conditional Waiver and Release on Progress Payment</h2>
        <p><strong>Project Name:</strong> {{PROJECT_NAME}}</p>
        <p><strong>Release Date:</strong> {{DATE_BLOCK}}</p>
        
        <p>Upon receipt by the undersigned of a check from Golden Touch Remodeling in the sum of $10,000.00 payable to the Subcontractor, this document shall become effective to release any mechanic's lien, stop notice, or bond right the undersigned has.</p>
        
        <p>Before proceeding, please initial to confirm you have reviewed the payment details: <br/> {{INITIAL_BLOCK}}</p>

        <p>This release covers a progress payment for labor, services, equipment, or material furnished to Golden Touch Remodeling.</p>
        
        <p>Please double check the terms and provide a secondary initial: <br/> {{INITIAL_BLOCK}}</p>

        <hr />
        <h3>Certification and Signature</h3>
        <p>I certify that all statements herein are true and correct.</p>
        <p>Please provide your signature below to execute this lien release:</p>
        <div style="margin-top: 15px; margin-bottom: 30px;">
          {{SIGNATURE_BLOCK}}
        </div>
        <p><strong>Signed Date:</strong> {{DATE_BLOCK}}</p>
      `
    }
  });

  console.log('Test Contract Created: http://localhost:3000/portal/contracts/' + contractId);
}

main().catch(console.error).finally(() => p.$disconnect());
