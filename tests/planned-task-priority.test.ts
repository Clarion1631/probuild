import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggestTaskForClockIn } from '../src/lib/time-suggestion';

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
