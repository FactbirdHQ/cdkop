import { describe, expect, test } from 'bun:test';

import { readLiveState } from '../src/reconcile/live.ts';
import { PlanError, plan } from '../src/reconcile/planner.ts';
import { renderPlan } from '../src/reconcile/render.ts';
import type { DesiredState, GroupManifest, VaultManifest } from '../src/synth/manifest.ts';
import { LEVELS } from '../src/synth/permissions.ts';
import { FakeOp, type FakeOpState } from './fake-op.ts';

function desired(vaults: VaultManifest[], groups: GroupManifest[]): DesiredState {
  return { version: 1, account: { signInAddress: 'factbird.1password.eu' }, vaults, groups };
}

async function planAgainst(state: FakeOpState, d: DesiredState) {
  return plan(d, await readLiveState(new FakeOp(state)));
}

const view = [...LEVELS.view];
const edit = [...LEVELS.edit];
const manage = [...LEVELS.manage];

describe('plan', () => {
  test('refuses a session signed into another account', async () => {
    const promise = planAgainst({ account: { url: 'https://other.1password.com' } }, desired([], []));
    await expect(promise).rejects.toBeInstanceOf(PlanError);
    await expect(promise).rejects.toThrow('reaches other.1password.com');
  });

  test('creates what is missing, vaults before groups before grants', async () => {
    const result = await planAgainst({}, desired([{ name: 'Shared' }], [{ name: 'IT', vaults: { Shared: edit } }]));
    expect(result.changes.map((c) => c.kind)).toEqual(['create-vault', 'create-group', 'grant']);
    expect(result.changes[2]).toMatchObject({ vault: 'Shared', group: 'IT', add: edit, from: [] });
  });

  test('an account that matches plans nothing', async () => {
    const result = await planAgainst(
      {
        vaults: [{ id: 'v1', name: 'Shared', description: 'd' }],
        groups: [{ id: 'g1', name: 'IT', description: '', type: 'USER_DEFINED' }],
        grants: { v1: [{ groupId: 'g1', groupName: 'IT', permissions: edit }] },
      },
      desired([{ name: 'Shared', description: 'd' }], [{ name: 'IT', vaults: { Shared: edit } }]),
    );
    expect(result.changes).toEqual([]);
  });

  test('widening grants the difference, narrowing revokes it', async () => {
    const state: FakeOpState = {
      vaults: [
        { id: 'v1', name: 'A' },
        { id: 'v2', name: 'B' },
      ],
      groups: [{ id: 'g1', name: 'IT', type: 'USER_DEFINED' }],
      grants: {
        v1: [{ groupId: 'g1', groupName: 'IT', permissions: view }],
        v2: [{ groupId: 'g1', groupName: 'IT', permissions: manage }],
      },
    };
    const result = await planAgainst(
      state,
      desired([{ name: 'A' }, { name: 'B' }], [{ name: 'IT', vaults: { A: edit, B: view } }]),
    );
    expect(result.changes).toEqual([
      { kind: 'grant', vault: 'A', group: 'IT', vaultId: 'v1', groupId: 'g1', add: LEVELS.edit.slice(3), from: view },
      {
        kind: 'revoke',
        vault: 'B',
        group: 'IT',
        vaultId: 'v2',
        groupId: 'g1',
        remove: LEVELS.manage.slice(3),
        from: manage,
      },
    ]);
  });

  test('a declared group loses access to a vault it is not granted, declared or not', async () => {
    const result = await planAgainst(
      {
        vaults: [{ id: 'v9', name: 'Legacy' }],
        groups: [{ id: 'g1', name: 'IT', type: 'USER_DEFINED' }],
        grants: { v9: [{ groupId: 'g1', groupName: 'IT', permissions: view }] },
      },
      desired([], [{ name: 'IT', vaults: {} }]),
    );
    expect(result.changes).toEqual([
      { kind: 'revoke', vault: 'Legacy', group: 'IT', vaultId: 'v9', groupId: 'g1', remove: 'all', from: view },
    ]);
    expect(result.notes).toContainEqual({ kind: 'undeclared-vault', name: 'Legacy' });
  });

  test('a grant whose permissions op did not report is never revoked', async () => {
    const result = await planAgainst(
      {
        vaults: [{ id: 'v1', name: 'Legacy' }],
        groups: [{ id: 'g1', name: 'IT', type: 'USER_DEFINED' }],
        grants: { v1: [{ groupId: 'g1', groupName: 'IT', permissions: [] }] },
      },
      desired([], [{ name: 'IT', vaults: {} }]),
    );
    expect(result.changes).toEqual([]);
  });

  test('undeclared and built-in groups keep their access', async () => {
    const result = await planAgainst(
      {
        vaults: [{ id: 'v1', name: 'Shared' }],
        groups: [
          { id: 'g0', name: 'Administrators', type: 'ADMINISTRATORS' },
          { id: 'g1', name: 'Owners' },
          { id: 'g2', name: 'Marketing', type: 'USER_DEFINED' },
        ],
        grants: {
          v1: [
            { groupId: 'g0', groupName: 'Administrators', permissions: manage },
            { groupId: 'g2', groupName: 'Marketing', permissions: view },
          ],
        },
      },
      desired([{ name: 'Shared' }], []),
    );
    expect(result.changes).toEqual([]);
    expect(result.notes).toEqual([{ kind: 'undeclared-group', name: 'Marketing' }]);
  });

  test('an external group that does not exist yet is awaited, never created', async () => {
    const result = await planAgainst(
      { vaults: [{ id: 'v1', name: 'Shared' }] },
      desired(
        [{ name: 'Shared' }],
        [
          {
            name: 'SG_Factbird_Department_Sales',
            externalGroup: 'SG_Factbird_Department_Sales',
            vaults: { Shared: view },
          },
        ],
      ),
    );
    expect(result.changes).toEqual([]);
    expect(result.notes).toEqual([
      {
        kind: 'awaiting-provisioning',
        group: 'SG_Factbird_Department_Sales',
        externalGroup: 'SG_Factbird_Department_Sales',
        grants: 1,
      },
    ]);
  });

  test('an external group is granted access but its description is not managed', async () => {
    const result = await planAgainst(
      {
        vaults: [{ id: 'v1', name: 'Shared' }],
        groups: [{ id: 'g1', name: 'SG_X', description: 'from Entra', type: 'USER_DEFINED' }],
      },
      desired([{ name: 'Shared' }], [{ name: 'SG_X', externalGroup: 'SG_X', vaults: { Shared: view } }]),
    );
    expect(result.changes.map((c) => c.kind)).toEqual(['grant']);
  });

  test('renames by previous name and updates a description only when both sides state one', async () => {
    const result = await planAgainst(
      {
        vaults: [
          { id: 'v1', name: 'Old', description: 'a' },
          { id: 'v2', name: 'Quiet' },
        ],
      },
      desired(
        [
          { name: 'New', previousName: 'Old', description: 'b' },
          { name: 'Quiet', description: 'x' },
        ],
        [],
      ),
    );
    expect(result.changes).toEqual([
      {
        kind: 'update-vault',
        id: 'v1',
        vault: { name: 'New', previousName: 'Old', description: 'b' },
        fields: [
          { field: 'name', from: 'Old', to: 'New' },
          { field: 'description', from: 'a', to: 'b' },
        ],
      },
    ]);
  });

  test('a pinned vault the session cannot see fails instead of being created', async () => {
    await expect(planAgainst({}, desired([{ name: 'Secret', id: 'vX' }], []))).rejects.toThrow(
      'pinned to id vX, which the op session cannot see',
    );
  });

  test('two live vaults with one name fail rather than guess', async () => {
    const state = {
      vaults: [
        { id: 'v1', name: 'Shared' },
        { id: 'v2', name: 'Shared' },
      ],
    };
    await expect(planAgainst(state, desired([{ name: 'Shared' }], []))).rejects.toThrow(
      '2 live vaults are named "Shared"',
    );
    expect((await planAgainst(state, desired([{ name: 'Shared', id: 'v2' }], []))).changes).toEqual([]);
  });

  test('renders gated revocations and the notes', async () => {
    const result = await planAgainst(
      {
        vaults: [{ id: 'v1', name: 'Shared' }],
        groups: [{ id: 'g1', name: 'IT', type: 'USER_DEFINED' }],
        grants: { v1: [{ groupId: 'g1', groupName: 'IT', permissions: manage }] },
      },
      desired([{ name: 'Shared' }], [{ name: 'IT', vaults: { Shared: view } }]),
    );
    expect(renderPlan('factbird.1password.eu', result)).toBe(
      [
        'Plan for 1Password account "factbird.1password.eu":',
        '',
        '  ~ IT → Shared: manage -> view   (requires --allow-delete)',
        '',
        '  0 to create, 0 to update, 0 to grant, 1 to revoke.',
        '',
      ].join('\n'),
    );
  });
});
