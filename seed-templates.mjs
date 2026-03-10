import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

await prisma.documentTemplate.create({
  data: {
    name: 'Standard Construction Contract',
    type: 'contract',
    isDefault: true,
    body: `<h2>Construction Services Agreement</h2>
<p>This Construction Services Agreement (the "Agreement") is entered into on <strong>{{date}}</strong>, by and between:</p>
<p><strong>Contractor:</strong> {{company_name}}<br/>Address: {{company_address}}<br/>Phone: {{company_phone}}<br/>Email: {{company_email}}</p>
<p><strong>Client:</strong> {{client_name}}<br/>Address: {{client_address}}<br/>Phone: {{client_phone}}<br/>Email: {{client_email}}</p>
<h3>1. Scope of Work</h3>
<p>The Contractor agrees to perform the construction services described in the project "<strong>{{project_name}}</strong>" located at <strong>{{location}}</strong>, in accordance with the attached estimate totaling <strong>{{estimate_total}}</strong>.</p>
<h3>2. Payment Terms</h3>
<p>Payment shall be made according to the payment schedule outlined in the approved estimate. A deposit of 50% of the total contract amount is due upon signing of this Agreement. The remaining balance shall be paid upon satisfactory completion of the work.</p>
<h3>3. Project Timeline</h3>
<p>Work shall commence within 14 business days of receiving the signed contract and deposit. The Contractor will provide a detailed project schedule upon commencement. Timelines are estimates and may be affected by weather, material availability, or change orders.</p>
<h3>4. Change Orders</h3>
<p>Any modifications to the scope of work must be documented in a written change order signed by both parties. Change orders may affect the project cost and timeline.</p>
<h3>5. Warranty</h3>
<p>The Contractor warrants all workmanship for a period of one (1) year from the date of project completion. This warranty does not cover damage caused by the Client, normal wear and tear, or acts of nature.</p>
<h3>6. Insurance</h3>
<p>The Contractor maintains general liability insurance and workers compensation coverage. Certificates of insurance are available upon request.</p>
<h3>7. Dispute Resolution</h3>
<p>Any disputes arising from this Agreement shall first be addressed through good-faith negotiation. If unresolved, the parties agree to submit to binding mediation before pursuing legal action.</p>
<h3>8. Entire Agreement</h3>
<p>This Agreement, together with any attached estimates and change orders, constitutes the entire agreement between the parties. Modifications must be made in writing and signed by both parties.</p>`
  }
});

console.log('Created: Standard Construction Contract template');
await prisma.$disconnect();
