// Seeds/updates GTR's standard estimate templates from estimate-template-seeds.ts.
// Idempotent: existing templates with the same name are replaced wholesale (items
// cascade-delete), so re-running after editing the seed data is always safe.
// The legacy "Bathroom Remodel" template is intentionally untouched.
//
// Run: npx tsx --env-file=.env.local scripts/seed-estimate-templates.ts
import { randomUUID } from "crypto";
import { prisma } from "../src/lib/prisma";
import { SEED_TEMPLATES, RETIRED_TEMPLATE_NAMES } from "./estimate-template-seeds";

async function main() {
    const costCodes = await prisma.costCode.findMany({ select: { id: true, code: true } });
    const codeMap = new Map(costCodes.map(c => [c.code, c.id]));

    // Fail fast on typo'd cost codes rather than seeding uncoded items.
    const missing = new Set<string>();
    for (const t of SEED_TEMPLATES) {
        for (const p of t.phases) {
            if (!codeMap.has(p.costCode)) missing.add(p.costCode);
            for (const i of p.items) if (i.costCode && !codeMap.has(i.costCode)) missing.add(i.costCode);
        }
    }
    if (missing.size > 0) throw new Error(`Unknown cost codes in seed data: ${[...missing].join(", ")}`);

    const retired = await prisma.estimateTemplate.deleteMany({ where: { name: { in: RETIRED_TEMPLATE_NAMES, mode: "insensitive" } } });
    if (retired.count > 0) console.log(`removed ${retired.count} retired template(s)`);

    for (const seed of SEED_TEMPLATES) {
        await prisma.$transaction(async tx => {
            // Case-insensitive: get_template resolves names insensitively, so a stray
            // "kitchen remodel" duplicate would make lookups ambiguous.
            const existing = await tx.estimateTemplate.findMany({
                where: { name: { equals: seed.name, mode: "insensitive" } },
                select: { id: true },
            });
            if (existing.length > 0) {
                await tx.estimateTemplate.deleteMany({ where: { id: { in: existing.map(e => e.id) } } });
            }

            const template = await tx.estimateTemplate.create({ data: { name: seed.name, source: "standard" } });

            let order = 0;
            const rows: Parameters<typeof tx.estimateTemplateItem.createMany>[0]["data"] = [];
            for (const phase of seed.phases) {
                const sectionId = randomUUID();
                const phaseTotal = Math.round(phase.items.reduce((s, i) => s + i.quantity * i.unitCost, 0) * 100) / 100;
                rows.push({
                    id: sectionId,
                    templateId: template.id,
                    name: phase.name,
                    description: null,
                    type: "Section",
                    quantity: 1,
                    baseCost: null,
                    markupPercent: 0,
                    unitCost: phaseTotal,
                    order: order++,
                    parentId: null,
                    costCodeId: codeMap.get(phase.costCode)!,
                    costTypeId: null,
                });
                for (const item of phase.items) {
                    rows.push({
                        id: randomUUID(),
                        templateId: template.id,
                        name: item.name,
                        description: item.description ?? null,
                        type: item.type,
                        quantity: item.quantity,
                        baseCost: null,
                        markupPercent: 25,
                        unitCost: item.unitCost,
                        order: order++,
                        parentId: sectionId,
                        costCodeId: codeMap.get(item.costCode ?? phase.costCode)!,
                        costTypeId: null,
                    });
                }
            }
            await tx.estimateTemplateItem.createMany({ data: rows });
            console.log(`seeded: ${seed.name} (${rows.length} items, ${seed.phases.length} phases)`);
        });
    }

    const count = await prisma.estimateTemplate.count();
    console.log(`done — ${count} templates total in DB`);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
