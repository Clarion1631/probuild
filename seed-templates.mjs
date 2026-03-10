import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

const templates = [
  {
    name: 'Standard Terms & Conditions',
    type: 'terms',
    isDefault: true,
    body: `<h3>Terms & Conditions</h3>
<p><strong>1. Scope of Work.</strong> The contractor agrees to perform the work described in this estimate. Any additional work outside the scope will require a written change order and may result in additional charges.</p>
<p><strong>2. Payment Terms.</strong> Payment is due within 30 days of invoice date. A deposit of 50% is required before work begins. Progress payments may be billed at milestones outlined in the payment schedule.</p>
<p><strong>3. Warranty.</strong> All workmanship is guaranteed for one (1) year from the date of project completion. Manufacturer warranties on materials apply separately.</p>
<p><strong>4. Permits &amp; Inspections.</strong> The contractor will obtain all necessary permits unless otherwise stated. The client is responsible for providing access for required inspections.</p>
<p><strong>5. Changes &amp; Modifications.</strong> Any changes to the scope of work must be agreed upon in writing. Change orders may affect the project timeline and cost.</p>
<p><strong>6. Timeline.</strong> Estimated project timelines are approximate and may be affected by weather, material availability, or unforeseen conditions. The contractor will communicate any significant delays promptly.</p>
<p><strong>7. Insurance.</strong> The contractor maintains general liability insurance and workers compensation coverage for all employees and subcontractors.</p>
<p><strong>8. Cancellation.</strong> Either party may cancel this agreement with 14 days written notice. The client is responsible for payment of all work completed and materials ordered prior to cancellation.</p>`
  },
  {
    name: 'Kitchen & Bath Remodel Terms',
    type: 'terms',
    isDefault: false,
    body: `<h3>Kitchen &amp; Bath Remodel Terms</h3>
<p><strong>1. Material Selections.</strong> Client must finalize all material selections (cabinets, countertops, fixtures, tile) at least 4 weeks prior to installation date. Delays in selection may affect the project timeline.</p>
<p><strong>2. Plumbing &amp; Electrical.</strong> This estimate includes standard plumbing and electrical connections. Any upgrades to plumbing lines, electrical panels, or code-required updates discovered during demolition will be quoted as a change order.</p>
<p><strong>3. Existing Conditions.</strong> Hidden damage such as water damage, mold, or structural issues discovered during demolition will be documented and quoted separately before proceeding.</p>
<p><strong>4. Living Arrangements.</strong> Kitchen and bathroom areas will be inaccessible during construction. The contractor will make reasonable efforts to maintain access to other areas of the home.</p>
<p><strong>5. Cleanup.</strong> Daily cleanup of work areas is included. Final cleaning of installed surfaces is included upon completion.</p>
<p><strong>6. Payment Schedule.</strong> 50% deposit upon signing, 25% at rough-in completion, 25% upon final completion and walkthrough.</p>`
  },
  {
    name: 'Liability Disclaimer',
    type: 'disclaimer',
    isDefault: true,
    body: `<h3>Liability Disclaimer</h3>
<p>This estimate is valid for 30 days from the date of issue. Prices are subject to change based on material cost fluctuations after the expiration date.</p>
<p>The contractor is not liable for pre-existing conditions, including but not limited to: structural deficiencies, hidden water damage, asbestos, lead paint, or code violations not related to the scope of work.</p>
<p>The client is responsible for clearing and securing personal belongings in and around the work area prior to project start.</p>
<p>Any dispute arising from this agreement shall be resolved through mediation before any legal action is taken.</p>`
  }
];

for (const t of templates) {
  await prisma.documentTemplate.create({ data: t });
  console.log('Created:', t.name);
}

console.log(`\nDone! Seeded ${templates.length} templates.`);
await prisma.$disconnect();
