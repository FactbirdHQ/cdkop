import { describe, expect, test } from 'bun:test';

import { apply } from '../src/reconcile/applier.ts';
import { readLiveState } from '../src/reconcile/live.ts';
import { plan } from '../src/reconcile/planner.ts';
import type { DesiredState } from '../src/synth/manifest.ts';
import { LEVELS } from '../src/synth/permissions.ts';
import { FakeOp, type FakeOpState } from './fake-op.ts';

const d: DesiredState = {
  version: 1,
  account: { signInAddress: 'example.1password.com' },
  vaults: [{ name: 'Shared' }, { name: 'Infrastructure' }],
  groups: [
    { name: 'IT', vaults: { Shared: [...LEVELS.edit] } },
    { name: 'DevOps', vaults: { Infrastructure: [...LEVELS.manage] } },
  ],
};

async function run(state: FakeOpState, allowDelete: boolean) {
  const op = new FakeOp(state);
  const p = plan(d, await readLiveState(op));
  const result = await apply(op, p.changes, { allowDelete });
  return { op, result };
}

describe('apply', () => {
  test('grants reach vaults and groups created earlier in the same run', async () => {
    const { op, result } = await run({}, false);
    expect(result.records.every((r) => r.status === 'applied')).toBe(true);
    expect(op.calls).toEqual([
      'createVault Shared',
      'createVault Infrastructure',
      'createGroup IT',
      'createGroup DevOps',
      `grant v1 g3 ${LEVELS.edit.join(',')}`,
      `grant v2 g4 ${LEVELS.manage.join(',')}`,
    ]);
    // A second plan against the result is empty.
    expect(plan(d, await readLiveState(op)).changes).toEqual([]);
  });

  test('a revocation runs only with --allow-delete', async () => {
    const state: FakeOpState = {
      vaults: [
        { id: 'v1', name: 'Shared' },
        { id: 'v2', name: 'Infrastructure' },
      ],
      groups: [
        { id: 'g1', name: 'IT', type: 'USER_DEFINED' },
        { id: 'g2', name: 'DevOps', type: 'USER_DEFINED' },
      ],
      grants: {
        v1: [{ groupId: 'g1', groupName: 'IT', permissions: [...LEVELS.manage] }],
        v2: [{ groupId: 'g2', groupName: 'DevOps', permissions: [...LEVELS.manage] }],
      },
    };
    const held = await run(state, false);
    expect(held.result.records.map((r) => r.status)).toEqual(['skipped']);
    expect(held.op.calls).toEqual([]);

    const allowed = await run(state, true);
    expect(allowed.op.calls).toEqual(['revoke v1 g1 manage_vault']);
  });

  test('stops at the first failure and says what was not attempted', async () => {
    const { op, result } = await run({ failOn: ['createGroup IT'] }, false);
    expect(result.records.map((r) => r.status)).toEqual(['applied', 'applied', 'failed']);
    expect(result.notAttempted.map((c) => c.kind)).toEqual(['create-group', 'grant', 'grant']);
    expect(op.calls).toEqual(['createVault Shared', 'createVault Infrastructure', 'createGroup IT']);
  });
});
