import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggestTaskForClockIn, computeAssignedPlanForUser } from '../src/lib/time-suggestion';
import { acceptedSuggestionConflictsWithPlan } from '../src/lib/dispatch-suggestion-audit';

const now = new Date('2026-09-08T15:00:00Z');
const task = (id: string, assigned = false, item: string | null = id) => ({
    id, name: id, parentId: null, estimateItemId: item, startDate: new Date('2026-09-08T00:00:00Z'),
    endDate: new Date('2026-09-09T00:00:00Z'), type: 'task', status: 'Not Started', order: 0,
    doneWhen: 'Leave the site clean', assignments: assigned ? [{ id: 'a', role: 'assigned' }] : [],
});
function fixture(tasks: ReturnType<typeof task>[]) {
    const db = {
        scheduleTask: { findMany: async () => tasks },
        estimate: { findMany: async () => [{ id: 'estimate', title: 'Job', items: tasks.filter(t=>t.estimateItemId).map(t=>({
            id: t.estimateItemId!, name: t.name, parentId: null, total: 100, costCodeId: 'phase-'+t.id,
            costCode: { code: 'phase-'+t.id, name: t.name },
        })) }] },
        dailyLog: { findFirst: async () => ({ date: new Date('2026-09-07T00:00Z'), aiSuggestedTaskId: 'log-task', aiSuggestionReason: 'Yesterday', photos: [] }) },
        timeEntry: { findFirst: async () => null },
    };
    return db as any;
}
test('the assigned task outranks yesterday log inference and carries office completion note', async () => {
    const result: any = await suggestTaskForClockIn({userId:'crew',projectId:'job',now}, fixture([task('log-task'),task('planned',true)]));
    assert.equal(result.suggestion?.scheduleTaskId, 'planned');
    assert.equal(result.suggestion?.source, 'dispatch');
    assert.equal(result.suggestion?.note, 'Leave the site clean');
});
test('an uncosted assigned task suppresses inferred work', async () => {
    const result: any = await suggestTaskForClockIn({userId:'crew',projectId:'job',now}, fixture([task('log-task'),task('planned',true,null)]));
    assert.equal(result.suggestion, null);
    assert.equal(result.uncostedPlannedTask?.id, 'planned');
});
test('multiple assigned tasks do not silently choose one or fall back to yesterday', async () => {
    const result: any = await suggestTaskForClockIn({userId:'crew',projectId:'job',now}, fixture([task('log-task'),task('first',true),task('second',true)]));
    assert.equal(result.suggestion, null);
    assert.equal(result.plannedTaskChoiceRequired, true);
});
test('without active assigned work, daily log fallback remains available', async () => {
    const result: any = await suggestTaskForClockIn({userId:'crew',projectId:'job',now}, fixture([task('log-task')]));
    assert.equal(result.suggestion?.scheduleTaskId, 'log-task');
    assert.equal(result.suggestion?.source, 'daily_log');
});

for (const [label, fields] of [
    ['completed', {status: 'Complete'}],
    ['tomorrow', {startDate: new Date('2026-09-09T00:00Z')}],
    ['ended yesterday', {endDate: new Date('2026-09-07T00:00Z')}],
    ['phase', {type: 'phase'}],
] as const) {
    test(`${label} assigned tasks do not suppress current log inference`, async () => {
        const result = await suggestTaskForClockIn({userId:'crew',projectId:'job',now}, fixture([
            task('log-task'), {...task('planned',true), ...fields},
        ]));
        assert.equal(result.suggestion?.source, 'daily_log');
        assert.equal(result.suggestion?.scheduleTaskId, 'log-task');
    });
}

test('assigned parent containers do not suppress a current leaf inference', async () => {
    const tasks = [task('log-task'), task('parent',true), {...task('child'),parentId:'parent'}];
    const result = await suggestTaskForClockIn({userId:'crew',projectId:'job',now}, fixture(tasks as any));
    assert.equal(result.suggestion?.source, 'daily_log');
});

test('assignment query scopes the plan to the authenticated user on this project', async () => {
    const db = fixture([task('planned',true)]);
    const original = db.scheduleTask.findMany;
    db.scheduleTask.findMany = async (query: any) => {
        assert.equal(query.where.projectId, 'job');
        assert.deepEqual(query.select.assignments.where, {userId:'crew'});
        return original(query);
    };
    assert.equal((await suggestTaskForClockIn({userId:'crew',projectId:'job',now}, db)).suggestion?.source, 'dispatch');
});

test('a log suggestion fetched before an office assignment is rejected against the new plan at acceptance', async () => {
    const tasks = [task('log-task')];
    const db = fixture(tasks);
    const displayed = (await suggestTaskForClockIn({userId:'crew',projectId:'job',now}, db)).suggestion!;
    assert.equal(displayed.source,'daily_log');
    tasks.push(task('new-office-plan',true));
    const current = await computeAssignedPlanForUser('crew','job','2026-09-08',db);
    assert.equal(current.assignmentCount,1);
    assert.equal(current.winner?.taskId,'new-office-plan');
    assert.equal(acceptedSuggestionConflictsWithPlan(displayed.source,false,displayed.scheduleTaskId,displayed.costCodeId,displayed.clockInEstimateItemId,current),true);
});

test('assignment read distinguishes no plan, ambiguous plans and a sole uncosted plan', async () => {
    const read = (tasks:ReturnType<typeof task>[]) => computeAssignedPlanForUser('crew','job','2026-09-08',fixture(tasks));
    assert.deepEqual(await read([task('unassigned')]),{assignmentCount:0,winner:null});
    assert.deepEqual(await read([task('one',true),task('two',true)]),{assignmentCount:2,winner:null});
    const uncosted = await read([task('one',true,null)]);
    assert.equal(uncosted.assignmentCount,1);
    assert.equal(uncosted.winner?.chargeable,false);
});
