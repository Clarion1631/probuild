import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

const TEMPLATE_NAME = "Residential Remodel — Lump Sum Contract";
const TEMPLATE_TYPE = "contract";

const HTML_BODY = `
<h2 style="text-align:center; margin-bottom:4px;">RESIDENTIAL REMODELING LUMP SUM CONTRACT</h2>

<p>This Agreement is entered into between:</p>

<table style="width:100%; border-collapse:collapse; margin-bottom:16px;">
  <tr>
    <td style="padding:8px 12px; vertical-align:top; width:50%; border:1px solid #e2e8f0;">
      <strong>Contractor:</strong><br/>
      {{company_name}}<br/>
      {{company_address}}<br/>
      {{company_phone}} | {{company_email}}
    </td>
    <td style="padding:8px 12px; vertical-align:top; width:50%; border:1px solid #e2e8f0;">
      <strong>Owner:</strong><br/>
      {{client_name}}<br/>
      {{client_address}}<br/>
      {{client_phone}} | {{client_email}}
    </td>
  </tr>
</table>

<p><strong>Project Address:</strong> {{location}}<br/>
<strong>Effective Date:</strong> {{date}}</p>

<hr/>

<h2>1. Scope of Work</h2>

<p>Contractor agrees to furnish all labor, materials, and services necessary to complete the project (the "Work") as described in <strong>Exhibit A – Scope of Work</strong> and related documents.</p>

<h2>2. Contract Price</h2>

<p>Owner agrees to pay Contractor a total <strong>Lump Sum Price of {{estimate_total}}</strong> ("Contract Price"), subject to adjustments for approved Change Orders and Allowances.</p>

<h2>3. Payment Terms</h2>

<p><strong>Owner agrees to make payments in accordance with the Payment Schedule outlined in this Agreement.</strong></p>

<p><strong>All invoices are due within 5 days of receipt unless otherwise specified.</strong></p>

<p><strong>Payments not received when due may result in delays to the project schedule.</strong></p>

<p><strong>Time is of the essence with respect to all payment obligations under this Agreement.</strong></p>

<h3>3.1 Late Payments</h3>

<p><strong>Any payment not received within 5 days of the invoice date shall be considered past due.</strong></p>

<p>Contractor reserves the right to:</p>
<ul>
  <li>Suspend work until payment is brought current</li>
  <li>Adjust the project schedule to reflect any delay caused by nonpayment</li>
</ul>

<h3>3.2 Interest on Unpaid Balances</h3>

<p><strong>Any unpaid balance shall accrue interest at a rate of 18% per annum</strong> (not to exceed the maximum rate allowed by law), beginning 10 days after the invoice date until paid in full.</p>

<h3>3.3 Costs of Collection</h3>

<p><strong>Owner agrees to pay all reasonable costs incurred by Contractor in the collection of unpaid amounts, including but not limited to:</strong></p>
<ul>
  <li>Administrative time</li>
  <li>Collection fees</li>
  <li>Attorney’s fees</li>
  <li>Court costs</li>
</ul>

<h3>3.4 Application of Payments</h3>

<p><strong>Payments received shall be applied first to outstanding interest, then to costs of collection, and finally to the principal balance due.</strong></p>

<h3>3.5 Right to Stop Work</h3>

<p><strong>Contractor reserves the right to stop work, upon written notice, if payments are not made as required under this Agreement.</strong></p>

<p><strong>Any resulting delays shall extend the project schedule accordingly, and Contractor shall not be responsible for impacts caused by such delays.</strong></p>

<h2>4. Allowances</h2>

<p>Certain items may be designated as allowances and are identified in Exhibit B. Final costs may increase or decrease based on actual selections. Any overages will require a Change Order.</p>

<h2>5. Change Orders</h2>

<p>Any changes to the Work must be documented and approved in writing through a Change Order prior to the commencement of the additional or revised work.</p>

<p>Each Change Order will include a description of the change, associated cost, and any impact to the project schedule.</p>

<p><strong>Payment for all Change Orders that increase the Contract Price is due in full at the time of approval and prior to the start of the associated work.</strong></p>

<p>This requirement ensures that all parties have a clear and mutual understanding of the scope and cost of changes as they occur, and allows the Contractor to proceed without delay or disruption. It also prevents misunderstandings at the end of the project regarding the cumulative cost of approved changes.</p>

<p>Failure to provide payment for an approved Change Order may result in delays to the project schedule and/or suspension of the affected work.</p>

<h2>6. Schedule</h2>

<p>Contractor will begin work within a reasonable timeframe after contract execution and required permits are obtained.</p>

<p>Substantial completion is anticipated within ________, subject to delays caused by:</p>
<ul>
  <li>Material availability</li>
  <li>Owner changes</li>
  <li>Unforeseen conditions</li>
  <li>Weather or other events beyond Contractor’s control</li>
  <li>Delays caused by late payments</li>
</ul>

<p>"Substantial Completion" means the stage at which the Work is sufficiently complete for its intended use, with only minor punch list items remaining.</p>

<h2>7. Unforeseen Conditions</h2>

<p>This agreement is based on visible conditions. Hidden conditions (including structural issues, water damage, outdated wiring, etc.) may require additional work and will be addressed through a Change Order.</p>

<h2>8. Permits</h2>

<p>________ shall be responsible for obtaining required permits unless otherwise agreed.</p>

<p>Permit costs are ________.</p>

<h2>9. Access to Project</h2>

<p><strong>Owner shall provide Contractor with reasonable access to the project site during normal working hours and as reasonably required to complete the Work.</strong></p>

<p><strong>Delays caused by restricted access, limited working hours, or interference with the Work may result in schedule adjustments and additional costs.</strong></p>

<h3>9.1 Owner Selections and Decisions</h3>

<p><strong>Owner agrees to make timely selections and decisions as required for the progress of the Work, including but not limited to materials, finishes, and design elements.</strong></p>

<p><strong>Contractor shall not be responsible for delays or additional costs resulting from delayed selections, changes in selections, or failure to provide timely approvals.</strong></p>

<h2>10. Warranty</h2>

<p>Contractor provides a <strong>one (1) year warranty on workmanship</strong> from the date of substantial completion.</p>

<p>This warranty covers defects in workmanship only and does not include:</p>
<ul>
  <li>Normal wear and tear</li>
  <li>Owner-supplied materials</li>
  <li>Manufacturer defects (covered by manufacturer warranties)</li>
  <li>Damage due to misuse or lack of maintenance</li>
</ul>

<p>Contractor shall be given the opportunity to inspect and correct any warranty issues.</p>
<ul>
  <li>Contractor shall not be responsible for warranty work performed by others without prior written approval</li>
</ul>

<h2>11. Lien Rights &amp; Releases</h2>

<p>Contractor reserves the right to file a lien against the Property for nonpayment in accordance with Washington State law.</p>

<p>Owner acknowledges receipt of the following required documents:</p>
<ul>
  <li>Contractor Disclosure Statement / Notice to Customer (as required by RCW 18.27)</li>
  <li>Lead-Based Paint Disclosure (for homes constructed prior to 1978, if applicable)</li>
</ul>

<p>Where applicable, Owner further acknowledges that:</p>
<ul>
  <li>Additional environmental or hazardous material conditions (including but not limited to asbestos) may require specialized handling, testing, or abatement. Such work is not included in the Contract Price unless specifically identified and will be addressed through a Change Order if encountered.</li>
</ul>

<p>As a condition of payment, Contractor will provide lien release documentation as follows:</p>
<ul>
  <li>Conditional lien releases may be provided upon request for progress payments</li>
  <li>Final lien releases will be provided upon receipt of final payment</li>
</ul>

<p>Owner understands that subcontractors, suppliers, or laborers not paid for their work may have independent rights to file liens against the Property.</p>

<p>Contractor agrees to cooperate in providing reasonable documentation to demonstrate payment of subcontractors and suppliers upon request.</p>

<p>Contractor’s lien rights are governed by Washington State law and are not dependent upon issuance of preliminary or periodic lien notices unless otherwise required by law.</p>

<h2>12. Insurance</h2>

<p>Contractor shall maintain general liability insurance.</p>

<p>Owner is responsible for maintaining property insurance unless otherwise agreed.</p>

<p>Contractor is not responsible for loss due to fire, theft, vandalism, or other casualty to the project except to the extent caused by Contractor’s negligence.</p>

<h2>13. Termination</h2>

<h3>13.1 Termination by Owner (Without Cause)</h3>

<p>Owner may terminate this Agreement for convenience upon written notice to Contractor.</p>

<p>In the event of such termination, Owner agrees to pay:</p>
<ul>
  <li>The cost of all work performed to date</li>
  <li>The cost of all materials ordered, delivered, or non-cancelable</li>
  <li>Any reasonable costs incurred for demobilization or cancellation of scheduled work</li>
  <li>A termination fee equal to <strong>ten percent (10%) of the remaining unpaid Contract Price</strong></li>
</ul>

<p>This termination fee is intended to compensate Contractor for lost scheduling opportunities, administrative costs, and overhead associated with reserving time for the Project.</p>

<h3>13.2 Termination for Nonpayment</h3>

<p>Failure of Owner to make payments in accordance with this Agreement shall constitute a material breach.</p>

<p>Contractor may, upon written notice:</p>
<ul>
  <li>Suspend work until payment is made</li>
  <li>Terminate this Agreement if payment is not cured within 7 days</li>
</ul>

<p>In the event of termination due to nonpayment, Owner agrees to pay:</p>
<ul>
  <li>All amounts due for work performed</li>
  <li>Costs for materials and commitments made</li>
  <li>A fee equal to <strong>ten percent (10%) of the outstanding unpaid balance</strong></li>
</ul>

<p>This fee reflects the additional administrative burden, disruption to scheduling, and costs associated with collection and project interruption.</p>

<p>Contractor reserves all rights to pursue collection, including lien rights, interest, and legal remedies.</p>

<h3>13.3 Termination by Contractor (For Cause)</h3>

<p>Contractor may terminate this Agreement for cause, including but not limited to:</p>
<ul>
  <li>Nonpayment</li>
  <li>Interference with work</li>
  <li>Unsafe conditions</li>
  <li>Failure of Owner to make timely decisions</li>
</ul>

<p>Contractor shall be entitled to compensation as outlined above.</p>

<h3>13.4 Termination by Mutual Agreement</h3>

<p>The Parties may terminate this Agreement at any time by mutual written agreement, with terms for payment and project closeout agreed upon at that time.</p>

<h2>14. Dispute Resolution</h2>

<p>The parties agree to attempt to resolve disputes through good faith discussion.</p>

<p>If unresolved, disputes shall proceed to mediation, and if necessary, binding arbitration.</p>

<h2>15. Entire Agreement</h2>

<p>This Agreement, together with all exhibits, constitutes the entire agreement between the parties.</p>

<h2>16. Exhibits</h2>

<p>Exhibit A shall consist of the Contractor’s Estimate, including line-item descriptions, quantities, and pricing.</p>

<p>In the event of any conflict between the Estimate and this Agreement, the terms of this Agreement shall control.</p>

<ul>
  <li><strong>Exhibit A – Estimate</strong> (Scope + Pricing + Allowances + Payment Schedule)</li>
  <li><strong>Exhibit B – Plans / Drawings</strong> (if applicable)</li>
</ul>

<h2>17. Signatures</h2>

<table style="width:100%; border-collapse:collapse; margin-top:24px;">
  <tr>
    <td style="padding:8px 12px; width:50%; vertical-align:top;">
      <strong>Contractor:</strong><br/><br/>
      <div style="border-bottom:1px solid #94a3b8; height:40px; margin-bottom:4px;"></div>
      <p>{{company_name}}<br/>Date: _______________</p>
    </td>
    <td style="padding:8px 12px; width:50%; vertical-align:top;">
      <strong>Owner:</strong><br/><br/>
      <div style="border-bottom:1px solid #94a3b8; height:40px; margin-bottom:4px;"></div>
      <p>{{client_name}}<br/>Date: _______________</p>
    </td>
  </tr>
</table>
`;

async function main() {
  const existing = await prisma.documentTemplate.findFirst({
    where: { name: TEMPLATE_NAME, type: TEMPLATE_TYPE },
  });

  // Unset other contract defaults
  await prisma.documentTemplate.updateMany({
    where: { type: TEMPLATE_TYPE, isDefault: true },
    data: { isDefault: false },
  });

  let result;
  if (existing) {
    result = await prisma.documentTemplate.update({
      where: { id: existing.id },
      data: { body: HTML_BODY, isDefault: true },
    });
    console.log(`Updated existing template: ${result.id} (${result.name})`);
  } else {
    result = await prisma.documentTemplate.create({
      data: {
        name: TEMPLATE_NAME,
        type: TEMPLATE_TYPE,
        body: HTML_BODY,
        isDefault: true,
      },
    });
    console.log(`Created new template: ${result.id} (${result.name})`);
  }

  console.log(`  Type: ${result.type}`);
  console.log(`  Default: ${result.isDefault}`);
  console.log(`  Body size: ${result.body.length} chars`);
}

main()
  .catch((e) => {
    console.error("Failed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
