import type { Prisma } from "@prisma/client";

/**
 * Append punch items to a task inside the caller's transaction.
 *
 * Locks the ScheduleTask row so concurrent writers (manual add, AI generate,
 * MCP bot) serialize on max(order) — TaskPunchItem has no (taskId, order)
 * unique constraint, so unlocked writers can assign duplicate orders.
 */
export async function appendPunchItemsInTransaction(
    tx: Prisma.TransactionClient,
    taskId: string,
    names: string[],
    createdById?: string | null,
) {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "ScheduleTask" WHERE id = ${taskId} FOR UPDATE`;
    if (locked.length === 0) throw new Error("Task not found");
    const maxOrder = await tx.taskPunchItem.aggregate({
        where: { taskId },
        _max: { order: true },
    });
    let order = (maxOrder._max.order ?? -1) + 1;
    const created = [];
    for (const name of names) {
        created.push(await tx.taskPunchItem.create({
            data: {
                taskId,
                name,
                order: order++,
                ...(createdById ? { createdById } : {}),
            },
        }));
    }
    return created;
}
