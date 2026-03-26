const {PrismaClient} = require('@prisma/client');
const p = new PrismaClient();

async function fix() {
    await p.contract.update({
        where: { id: 'cmn7yi0nr0001ygxlp1p2xojc' },
        data: {
            body: '<p>This is a test recurring contract executed 30 days ago.</p> <div class="doc-block-btn sig-block pulse-ring" data-id="sig-0" data-type="signature">[ Click to Sign ]</div>'
        }
    });
    console.log("Fixed missing type attribute!");
    await p.$disconnect();
}
fix();
