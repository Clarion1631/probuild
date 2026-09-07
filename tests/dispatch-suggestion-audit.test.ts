import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDispatchSuggestionAudit, dispatchAcceptanceIsCurrent, acceptedSuggestionConflictsWithPlan } from '../src/lib/dispatch-suggestion-audit';

test('dispatch provenance requires the current assigned chargeable winner', () => {
    assert.deepEqual(resolveDispatchSuggestionAudit('task', {taskId:'task',chargeable:true,costCodeId:'real'}), {source:'dispatch',costCodeId:'real'});
    for (const winner of [null, {taskId:'other',chargeable:true,costCodeId:'real'}, {taskId:'task',chargeable:false,costCodeId:null}]) {
        assert.deepEqual(resolveDispatchSuggestionAudit('task', winner), {source:null,costCodeId:null});
    }
    assert.deepEqual(resolveDispatchSuggestionAudit(null, {taskId:'task',chargeable:true,costCodeId:'real'}), {source:null,costCodeId:null});
});

test('accepted plan must still match assigned task, phase and optional item', () => {
    const winner = {taskId:'task',chargeable:true,costCodeId:'phase',estimateItemId:'item'};
    assert.equal(dispatchAcceptanceIsCurrent('task','phase','item',winner),true);
    assert.equal(dispatchAcceptanceIsCurrent('task','phase',null,winner),true);
    assert.equal(dispatchAcceptanceIsCurrent('task','phase','item',null),false);
    assert.equal(dispatchAcceptanceIsCurrent('old-task','phase','item',winner),false);
    assert.equal(dispatchAcceptanceIsCurrent('task','old-phase','item',winner),false);
    assert.equal(dispatchAcceptanceIsCurrent('task','phase','old-item',winner),false);
});

for (const source of ['daily_log','today_schedule','user_history','dispatch']) {
    test(`${source} acceptance cannot bypass newly assigned, ambiguous or uncosted work`, () => {
        const winner = {taskId:'planned',costCodeId:'phase',estimateItemId:'item',chargeable:true};
        const check = (plan:any, overridden=false) => acceptedSuggestionConflictsWithPlan(source,overridden,'old-log','old-phase','old-item',plan);
        assert.equal(check({assignmentCount:1,winner}),true);
        assert.equal(check({assignmentCount:2,winner:null}),true);
        assert.equal(check({assignmentCount:1,winner:{...winner,chargeable:false}}),true);
        assert.equal(check({assignmentCount:1,winner},true),false);
        assert.equal(acceptedSuggestionConflictsWithPlan(source,false,'planned','phase','item',{assignmentCount:1,winner}),false);
        assert.equal(check({assignmentCount:0,winner:null}),source==='dispatch');
    });
}

test('legacy no-suggestion and explicit manual payloads remain supported', () => {
    assert.equal(acceptedSuggestionConflictsWithPlan(undefined,false,null,'phase',null,{assignmentCount:2,winner:null}),false);
    assert.equal(acceptedSuggestionConflictsWithPlan('daily_log',true,'old','phase',null,{assignmentCount:2,winner:null}),false);
});
