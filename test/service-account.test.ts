import { describe, expect, test } from 'bun:test';

import { apply } from '../src/reconcile/applier.ts';
import { readLiveState } from '../src/reconcile/live.ts';
import { planServiceAccount } from '../src/reconcile/plan-service-account.ts';
import { PlanError, plan } from '../src/reconcile/planner.ts';
import {
  type AppliedState,
  loadState,
  nextState,
  STATE_DOCUMENT,
  STATE_VAULT,
  saveState,
} from '../src/reconcile/state.ts';
import type { DesiredState, GroupManifest } from '../src/synth/manifest.ts';
import { LEVELS } from '../src/synth/permissions.ts';
import { FakeOp, type FakeOpState } from './fake-op.ts';

const view = [...LEVELS.view];
const edit = [...LEVELS.edit];

function desired(groups: GroupManifest[], extra: Partial<DesiredState> = {}): DesiredState {
  return {
    version: 1,
    account: { signInAddress: 'example.1password.com' },
    vaults: [{ name: 'Payments', owner: 'service-account' }, { name: 'Legacy' }],
    groups,
    ...extra,
  };
}

function serviceAccount(state: FakeOpState = {}): FakeOp {
  return new FakeOp({
    groups: [
      { id: 'g0', name: 'Administrators', type: 'ADMINISTRATORS' },
      { id: 'g1', name: 'SG-Finance', type: 'USER_DEFINED' },
      { id: 'g2', name: 'SG-Sales', type: 'USER_DEFINED' },
    ],
    ...state,
    account: { serviceAccount: true, ...state.account },
  });
}

/** One run the way `cdkop apply` does it as a service account. */
async function run(op: FakeOp, d: DesiredState, allowDelete = true) {
  const live = await readLiveState(op);
  const state = await loadState(op, live);
  const result = planServiceAccount(d, live, state);
  const outcome = await apply(op, result.changes, { allowDelete });
  const vaults = await op.listVaults();
  await saveState(
    op,
    { ...live, vaults },
    nextState(state, outcome.records, new Map(vaults.map((v) => [v.name, v.id]))),
  );
  return { result, outcome };
}

describe('a service account run', () => {
  test('creates its vault, grants the groups, and records it; the next run plans nothing', async () => {
    const op = serviceAccount();
    const d = desired([{ name: 'SG-Finance', vaults: { Payments: edit, Legacy: view } }]);

    const first = await run(op, d);
    expect(first.result.changes.map((c) => c.kind)).toEqual(['create-vault', 'grant']);
    expect(first.result.notes).toContainEqual({ kind: 'left-to-administrator', vaults: ['Legacy'] });
    expect(op.calls.filter((c) => c.startsWith('grant'))).toEqual([`grant v1 g1 ${edit.join(',')}`]);

    const state = JSON.parse(op.documents[op.vaults.find((v) => v.name === STATE_VAULT)!.id]![STATE_DOCUMENT]!);
    expect(state.vaults.v1).toEqual({ name: 'Payments', groups: { 'SG-Finance': edit } });

    const second = await run(op, d);
    expect(second.result.changes).toEqual([]);
    expect(second.result.notes.some((n) => n.kind === 'undeclared-vault')).toBe(false);
  });

  test('widens with a grant and narrows by removing the group and granting it again', async () => {
    const op = serviceAccount();
    await run(op, desired([{ name: 'SG-Finance', vaults: { Payments: view } }]));

    const widened = await run(op, desired([{ name: 'SG-Finance', vaults: { Payments: edit } }]));
    expect(widened.result.changes).toMatchObject([{ kind: 'grant', add: LEVELS.edit.slice(3), from: view }]);

    op.calls.length = 0;
    const narrowed = await run(op, desired([{ name: 'SG-Finance', vaults: { Payments: view } }]));
    expect(narrowed.result.changes).toMatchObject([{ kind: 'regrant', permissions: view, from: edit }]);
    expect(op.calls.slice(0, 2)).toEqual(['revoke v1 g1 all', `grant v1 g1 ${view.join(',')}`]);
    expect(op.grants.v1).toEqual([{ groupId: 'g1', groupName: 'SG-Finance', permissions: view }]);
  });

  test('a regrant waits for --allow-delete, because it can take access away', async () => {
    const op = serviceAccount();
    await run(op, desired([{ name: 'SG-Finance', vaults: { Payments: edit } }]));
    const held = await run(op, desired([{ name: 'SG-Finance', vaults: { Payments: view } }]), false);
    expect(held.outcome.records.map((r) => r.status)).toEqual(['skipped']);
    // Skipped, so the record keeps the wider set and the next run proposes it again.
    expect((await run(op, desired([{ name: 'SG-Finance', vaults: { Payments: view } }]))).result.changes).toMatchObject(
      [{ kind: 'regrant' }],
    );
  });

  test('a group on its vault with no record is granted again, and one the definition dropped is removed', async () => {
    const op = serviceAccount({
      vaults: [{ id: 'v9', name: 'Payments' }],
      grants: {
        v9: [
          { groupId: 'g0', groupName: 'Administrators', permissions: ['manage_vault'] },
          { groupId: 'g1', groupName: 'SG-Finance', permissions: edit },
          { groupId: 'g2', groupName: 'SG-Sales', permissions: view },
        ],
      },
    });
    const live = await readLiveState(op);
    const result = planServiceAccount(
      desired([{ name: 'SG-Finance', vaults: { Payments: view } }]),
      live,
      await loadState(op, live),
    );
    expect(result.changes).toEqual([
      { kind: 'regrant', vault: 'Payments', group: 'SG-Finance', vaultId: 'v9', groupId: 'g1', permissions: view },
      { kind: 'revoke', vault: 'Payments', group: 'SG-Sales', vaultId: 'v9', groupId: 'g2', remove: 'all', from: [] },
    ]);
  });

  test('a group that does not exist stops the run, unless SCIM will provision it', async () => {
    const live = await readLiveState(serviceAccount());
    const empty: AppliedState = { version: 1, vaults: {} };
    const missing = desired([{ name: 'SG-Ops', externalGroup: 'SG-Ops', vaults: { Payments: view } }]);
    expect(() => planServiceAccount(missing, live, empty)).toThrow(PlanError);
    expect(() => planServiceAccount(missing, live, empty)).toThrow("a service account can't create groups");

    const scim = { tenantId: 't', applicationDisplayName: 'a', tokenFrom: 'T', groups: ['SG-Ops'] };
    const awaited = planServiceAccount({ ...missing, scim }, live, empty);
    expect(awaited.changes.map((c) => c.kind)).toEqual(['create-vault']);
    expect(awaited.notes).toContainEqual({
      kind: 'awaiting-provisioning',
      group: 'SG-Ops',
      externalGroup: 'SG-Ops',
      grants: 1,
    });
  });

  test('a failed grant stays out of the record, so the next run retries it', async () => {
    const op = serviceAccount({ failOn: ['grant'] });
    const d = desired([{ name: 'SG-Finance', vaults: { Payments: view } }]);
    const first = await run(op, d);
    expect(first.outcome.records.map((r) => r.status)).toEqual(['applied', 'failed']);

    op.calls.length = 0;
    const retry = serviceAccount({ vaults: op.vaults, documents: op.documents });
    expect((await run(retry, d)).result.changes.map((c) => c.kind)).toEqual(['grant']);
  });

  test("an administrator's plan leaves a missing service-account vault, and grants to it, to the service account", async () => {
    const op = new FakeOp({ groups: [{ id: 'g1', name: 'SG-Finance', type: 'USER_DEFINED' }] });
    const result = plan(desired([{ name: 'SG-Finance', vaults: { Payments: view } }]), await readLiveState(op));
    expect(result.changes.map((c) => c.kind)).toEqual(['create-vault']);
    expect(result.changes[0]).toMatchObject({ vault: { name: 'Legacy' } });
    expect(result.notes).toContainEqual({ kind: 'left-to-service-account', vaults: ['Payments'] });
  });

  test("an administrator's plan manages a service-account vault once it exists", async () => {
    const op = new FakeOp({
      vaults: [
        { id: 'v1', name: 'Payments' },
        { id: 'v2', name: 'Legacy' },
      ],
      groups: [{ id: 'g1', name: 'SG-Finance', type: 'USER_DEFINED' }],
      grants: { v1: [{ groupId: 'g1', groupName: 'SG-Finance', permissions: edit }] },
    });
    const result = plan(desired([{ name: 'SG-Finance', vaults: { Payments: view } }]), await readLiveState(op));
    expect(result.changes).toMatchObject([{ kind: 'revoke', vault: 'Payments', remove: LEVELS.edit.slice(3) }]);
  });

  test("an administrator's plan leaves the record's vault out of the undeclared list", async () => {
    const op = new FakeOp({ vaults: [{ id: 's1', name: STATE_VAULT }] });
    const result = plan(desired([]), await readLiveState(op));
    expect(result.notes.some((n) => n.kind === 'undeclared-vault')).toBe(false);
  });
});
