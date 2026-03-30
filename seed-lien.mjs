import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

// Conditional Lien Release (used during project — progress payments)
await prisma.documentTemplate.create({
  data: {
    name: 'Conditional Lien Release (Progress Payment)',
    type: 'lien_release',
    isDefault: true,
    body: `<h2 style="text-align: center;">CONDITIONAL WAIVER AND RELEASE ON PROGRESS PAYMENT</h2>

<p style="text-align: center; font-style: italic; color: #666;">This document waives and releases lien, stop-payment notice, and payment bond rights for progress payments received.</p>

<hr/>

<p><strong>Project:</strong> {{project_name}}</p>
<p><strong>Project Location:</strong> {{location}}</p>
<p><strong>Owner / Client:</strong> {{client_name}}</p>
<p><strong>Claimant (Contractor):</strong> {{company_name}}</p>
<p><strong>Through Date:</strong> {{date}}</p>

<hr/>

<h3>Conditional Waiver and Release</h3>

<p>Upon receipt of a progress payment in the amount of <strong>$_______________</strong> (the "Progress Payment"), the undersigned Claimant waives and releases any and all lien, stop-payment notice, and payment bond rights the Claimant has on the above-referenced project through the date stated above.</p>

<p>This waiver and release is <strong>conditioned upon</strong> receipt of the Progress Payment. If the Progress Payment is not received, or if a financial institution refuses to honor the instrument of payment, this waiver and release is null and void.</p>

<h3>Exceptions</h3>

<p>This waiver and release does not cover the following:</p>
<ul>
<li>Disputed claims in the amount of $_______________</li>
<li>Any retention withheld</li>
<li>Any amounts for work performed after the "Through Date" stated above</li>
</ul>

<h3>Certification</h3>

<p>The undersigned Claimant certifies under penalty of perjury that:</p>
<ol>
<li>A valid lien, stop-payment notice, or payment bond right exists or may exist in favor of the Claimant.</li>
<li>The Claimant has supplied labor, services, equipment, or materials to the project described above.</li>
<li>The information provided herein is true and correct to the best of the Claimant's knowledge.</li>
</ol>

<h3>Contractor Information</h3>

<p><strong>Company:</strong> {{company_name}}<br/>
<strong>Address:</strong> {{company_address}}<br/>
<strong>Phone:</strong> {{company_phone}}<br/>
<strong>Email:</strong> {{company_email}}</p>

<hr/>

<h3>Acknowledgment</h3>

<p>By signing below, the Client acknowledges receipt of this Conditional Waiver and Release on Progress Payment and confirms that the progress payment referenced above has been issued or is being processed.</p>

<table style="width: 100%; border-collapse: collapse; margin-top: 2em;">
<tr>
<td style="width: 60%; padding: 8px 0; vertical-align: bottom;">
<p style="margin: 0 0 4px;"><strong>Client Signature:</strong></p>
{{SIGNATURE_BLOCK}}
</td>
<td style="width: 40%; padding: 8px 0; vertical-align: bottom;">
<p style="margin: 0 0 4px;"><strong>Date:</strong></p>
{{DATE_BLOCK}}
</td>
</tr>
</table>`
  }
});

// Unconditional Lien Release (upon final payment)
await prisma.documentTemplate.create({
  data: {
    name: 'Unconditional Lien Release (Final Payment)',
    type: 'lien_release',
    isDefault: false,
    body: `<h2 style="text-align: center;">UNCONDITIONAL WAIVER AND RELEASE ON FINAL PAYMENT</h2>

<p style="text-align: center; font-style: italic; color: #666;">This document waives and releases lien, stop-payment notice, and payment bond rights upon final payment.</p>

<hr/>

<p><strong>Project:</strong> {{project_name}}</p>
<p><strong>Project Location:</strong> {{location}}</p>
<p><strong>Owner / Client:</strong> {{client_name}}</p>
<p><strong>Claimant (Contractor):</strong> {{company_name}}</p>
<p><strong>Date of Final Payment:</strong> {{date}}</p>

<hr/>

<h3>Unconditional Waiver and Release</h3>

<p>The undersigned Claimant has received final payment in full for all labor, services, equipment, and materials furnished to the above-referenced project.</p>

<p>The undersigned Claimant <strong>unconditionally waives and releases</strong> any and all lien, stop-payment notice, and payment bond rights that the Claimant has on said project. This waiver and release is effective immediately and is not conditioned upon receipt of further payment.</p>

<h3>No Exceptions</h3>

<p>The undersigned Claimant certifies that there are no disputed claims, unpaid amounts, or retained sums outstanding. All obligations between the parties relating to this project are fully satisfied.</p>

<h3>Certification</h3>

<p>The undersigned Claimant certifies under penalty of perjury that:</p>
<ol>
<li>All amounts due for labor, services, equipment, and materials furnished to the project have been paid in full.</li>
<li>All workers, subcontractors, and material suppliers have been paid in full.</li>
<li>The information provided herein is true and correct to the best of the Claimant's knowledge.</li>
</ol>

<h3>Contractor Information</h3>

<p><strong>Company:</strong> {{company_name}}<br/>
<strong>Address:</strong> {{company_address}}<br/>
<strong>Phone:</strong> {{company_phone}}<br/>
<strong>Email:</strong> {{company_email}}</p>

<hr/>

<h3>Acknowledgment</h3>

<p>By signing below, the Client acknowledges receipt of this Unconditional Waiver and Release on Final Payment and confirms that the final payment referenced above has been issued.</p>

<table style="width: 100%; border-collapse: collapse; margin-top: 2em;">
<tr>
<td style="width: 60%; padding: 8px 0; vertical-align: bottom;">
<p style="margin: 0 0 4px;"><strong>Client Signature:</strong></p>
{{SIGNATURE_BLOCK}}
</td>
<td style="width: 40%; padding: 8px 0; vertical-align: bottom;">
<p style="margin: 0 0 4px;"><strong>Date:</strong></p>
{{DATE_BLOCK}}
</td>
</tr>
</table>`
  }
});

console.log('✅ Created: Conditional Lien Release (Progress Payment)');
console.log('✅ Created: Unconditional Lien Release (Final Payment)');
await prisma.$disconnect();
