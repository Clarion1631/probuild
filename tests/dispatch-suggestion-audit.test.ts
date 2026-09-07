import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDispatchSuggestionAudit, dispatchAcceptanceIsCurrent } from '../src/lib/dispatch-suggestion-audit';

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
