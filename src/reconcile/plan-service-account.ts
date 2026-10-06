import { isBuiltInGroup } from '../synth/built-in-groups.ts';
import type { DesiredState } from '../synth/manifest.ts';
import type { Change, Grant, Note, Regrant, Revoke } from './changes.ts';
import type { LiveState } from './live.ts';
import { assertAccount, fieldChanges, matchGroup, matchVault, type Plan, PlanError } from './planner.ts';
import { type AppliedState, STATE_VAULT } from './state.ts';

/**
 * Plan a run as a service account, which manages only the vaults declared
 * with `owner: 'service-account'`.
 *
 * A service account sees the vaults it created and which groups can open
 * them, but not with what permissions. So this compares the definition with
 * the record of what earlier applies did (`state`), not with the account:
 *
 * - a group the vault doesn't list yet is granted its set;
 * - a group whose recorded set is narrower is granted the difference;
 * - a group whose recorded set is wider, or that has no record, is removed
 *   and granted its set again (`regrant`), because a service account can't
 *   revoke part of a grant;
 * - a group the vault lists that the definition doesn't grant is removed.
 *
 * The service account owns the vault, not only the declared groups' access
 * to it, so the last rule reaches every group except the built-in ones. A
 * change made in the console that the record doesn't know about goes
 * unnoticed here. An administrator's `plan` sees permissions and finds it.
 */
export function planServiceAccount(desired: DesiredState, live: LiveState, state: AppliedState): Plan {
  assertAccount(desired, live);

  const owned = desired.vaults.filter((v) => v.owner === 'service-account');
  const notes: Note[] = [];
  const others = desired.vaults.filter((v) => v.owner !== 'service-account').map((v) => v.name);
  if (others.length > 0) {
    notes.push({ kind: 'left-to-administrator', vaults: others });
  }

  const vaultCreates: Change[] = [];
  const vaultUpdates: Change[] = [];
  const ids = new Map<string, string>();
  for (const vault of owned) {
    const found = matchVault(vault.name, vault.previousName, vault.id, live.vaults);
    if (!found) {
      vaultCreates.push({ kind: 'create-vault', vault });
      continue;
    }
    ids.set(vault.name, found.id);
    const fields = fieldChanges(found, vault.name, vault.description);
    if (fields.length > 0) {
      vaultUpdates.push({ kind: 'update-vault', id: found.id, vault, fields });
    }
  }
  for (const vault of live.vaults) {
    if (vault.name !== STATE_VAULT && ![...ids.values()].includes(vault.id)) {
      notes.push({ kind: 'undeclared-vault', name: vault.name });
    }
  }

  // Which group may open which owned vault, with what.
  const ownedNames = new Set(owned.map((v) => v.name));
  const wanted = new Map<string, Map<string, (typeof desired.groups)[number]['vaults'][string]>>();
  const groupIds = new Map<string, string>();
  const userGroups = live.groups.filter((g) => !isBuiltInGroup(g));
  for (const group of desired.groups) {
    const grants = Object.entries(group.vaults).filter(([vault]) => ownedNames.has(vault));
    if (grants.length === 0) {
      continue;
    }
    const found = matchGroup(group.name, group.previousName, userGroups);
    if (!found) {
      if (group.externalGroup !== undefined && desired.scim !== undefined) {
        notes.push({
          kind: 'awaiting-provisioning',
          group: group.name,
          externalGroup: group.externalGroup,
          grants: grants.length,
        });
        continue;
      }
      throw new PlanError(
        `Group "${group.name}" doesn't exist, and a service account can't create groups. ` +
          'Have the identity provider provision it, or apply once as an administrator.',
      );
    }
    groupIds.set(group.name, found.id);
    for (const [vault, set] of grants) {
      const byGroup = wanted.get(vault) ?? new Map();
      byGroup.set(group.name, set);
      wanted.set(vault, byGroup);
    }
  }

  const grants: Grant[] = [];
  const regrants: Regrant[] = [];
  const revokes: Revoke[] = [];
  for (const vault of owned) {
    const vaultId = ids.get(vault.name);
    const present = new Map(
      (vaultId ? (live.grants[vaultId] ?? []) : [])
        .filter((g) => !isBuiltInGroup({ name: g.groupName }))
        .map((g) => [g.groupName, g.groupId]),
    );
    const recorded = vaultId ? (state.vaults[vaultId]?.groups ?? {}) : {};

    for (const [group, set] of wanted.get(vault.name) ?? []) {
      const groupId = groupIds.get(group)!;
      const before = recorded[group];
      if (!vaultId || !present.has(group)) {
        grants.push({
          kind: 'grant',
          vault: vault.name,
          group,
          ...(vaultId ? { vaultId } : {}),
          groupId,
          add: set,
          from: [],
        });
      } else if (before === undefined || before.some((p) => !set.includes(p))) {
        regrants.push({
          kind: 'regrant',
          vault: vault.name,
          group,
          vaultId,
          groupId,
          permissions: set,
          ...(before ? { from: before } : {}),
        });
      } else {
        const add = set.filter((p) => !before.includes(p));
        if (add.length > 0) {
          grants.push({ kind: 'grant', vault: vault.name, group, vaultId, groupId, add, from: before });
        }
      }
    }
    for (const [group, groupId] of present) {
      if (vaultId && !wanted.get(vault.name)?.has(group)) {
        revokes.push({
          kind: 'revoke',
          vault: vault.name,
          group,
          vaultId,
          groupId,
          remove: 'all',
          from: recorded[group] ?? [],
        });
      }
    }
  }

  return { changes: [...vaultCreates, ...vaultUpdates, ...grants, ...regrants, ...revokes], notes };
}
