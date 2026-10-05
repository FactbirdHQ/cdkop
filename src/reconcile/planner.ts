import type { LiveGroup, LiveVault } from '../op/client.ts';
import { isBuiltInGroup } from '../synth/built-in-groups.ts';
import type { DesiredState, GroupManifest } from '../synth/manifest.ts';
import type { Permission } from '../synth/permissions.ts';
import { normaliseSignInAddress } from '../synth/synthesizer.ts';
import type { Change, FieldChange, Grant, Note, Revoke } from './changes.ts';
import type { LiveState } from './live.ts';

export interface Plan {
  /** In execution order: vaults, then groups, then grants, then revocations. */
  readonly changes: Change[];
  readonly notes: Note[];
}

/** A definition that cannot be planned against this account as it stands. */
export class PlanError extends Error {}

/**
 * Compare the desired state with the live account and list what `apply` would
 * do. Pure: it reads nothing and writes nothing.
 *
 * A declared group owns its vault access, wherever that access points: every
 * live grant on it that the definition does not carry, or carries narrower, is
 * a revocation. Grants on undeclared groups, and the built-in groups, are
 * never touched.
 */
export function plan(desired: DesiredState, live: LiveState): Plan {
  const reached = normaliseSignInAddress(live.account.url);
  if (reached !== desired.account.signInAddress) {
    throw new PlanError(
      `The op session reaches ${reached || 'no account'}, but the definition declares ${desired.account.signInAddress}. ` +
        'Sign into the declared account and re-run.',
    );
  }

  const vaults = planVaults(desired, live);
  const groupCreates: Change[] = [];
  const groupUpdates: Change[] = [];
  const grants: Change[] = [];
  const revokes: Change[] = [];
  const notes: Note[] = [...vaults.notes];

  const userGroups = live.groups.filter((g) => !isBuiltInGroup(g));
  const matchedGroups = new Set<string>();
  for (const group of desired.groups) {
    const found = matchGroup(group.name, group.previousName, userGroups);
    if (found) {
      matchedGroups.add(found.id);
      if (group.externalGroup === undefined) {
        const fields = fieldChanges(found, group.name, group.description);
        if (fields.length > 0) {
          groupUpdates.push({ kind: 'update-group', id: found.id, group, fields });
        }
      }
      const access = planAccess(group, found.id, vaults.ids, live);
      grants.push(...access.grants);
      revokes.push(...access.revokes);
    } else if (group.externalGroup === undefined) {
      groupCreates.push({ kind: 'create-group', group });
      grants.push(...planAccess(group, undefined, vaults.ids, live).grants);
    } else {
      notes.push({
        kind: 'awaiting-provisioning',
        group: group.name,
        externalGroup: group.externalGroup,
        grants: Object.keys(group.vaults).length,
      });
    }
  }
  for (const group of userGroups) {
    if (!matchedGroups.has(group.id)) {
      notes.push({ kind: 'undeclared-group', name: group.name });
    }
  }

  return {
    changes: [...vaults.creates, ...vaults.updates, ...groupCreates, ...groupUpdates, ...grants, ...revokes],
    notes,
  };
}

/** Vaults to create or update, the live id of every declared vault that exists, and the undeclared ones. */
function planVaults(desired: DesiredState, live: LiveState) {
  const creates: Change[] = [];
  const updates: Change[] = [];
  const notes: Note[] = [];
  const ids = new Map<string, string>();
  for (const vault of desired.vaults) {
    const found = matchVault(vault.name, vault.previousName, vault.id, live.vaults);
    if (!found) {
      creates.push({ kind: 'create-vault', vault });
      continue;
    }
    ids.set(vault.name, found.id);
    const fields = fieldChanges(found, vault.name, vault.description);
    if (fields.length > 0) {
      updates.push({ kind: 'update-vault', id: found.id, vault, fields });
    }
  }
  const matched = new Set(ids.values());
  for (const vault of live.vaults) {
    if (!matched.has(vault.id)) {
      notes.push({ kind: 'undeclared-vault', name: vault.name });
    }
  }
  return { creates, updates, notes, ids };
}

/**
 * One group's grants and revocations. A group that does not exist yet
 * (`groupId` undefined) holds nothing, so it only gains.
 */
function planAccess(
  group: GroupManifest,
  groupId: string | undefined,
  vaultIds: ReadonlyMap<string, string>,
  live: LiveState,
): { grants: Grant[]; revokes: Revoke[] } {
  // What the group holds now, by the vault's declared name where it has one.
  const declaredById = new Map([...vaultIds].map(([name, id]) => [id, name]));
  const liveNameById = new Map(live.vaults.map((v) => [v.id, v.name]));
  const held = new Map<string, { vaultId: string; permissions: Permission[] }>();
  if (groupId !== undefined) {
    for (const entry of liveGrantsOf(groupId, live)) {
      held.set(declaredById.get(entry.vaultId) ?? liveNameById.get(entry.vaultId) ?? entry.vaultId, entry);
    }
  }

  const grants: Grant[] = [];
  for (const [vault, set] of Object.entries(group.vaults)) {
    const from = held.get(vault)?.permissions ?? [];
    const add = set.filter((p) => !from.includes(p));
    if (add.length > 0) {
      const vaultId = vaultIds.get(vault);
      grants.push({
        kind: 'grant',
        vault,
        group: group.name,
        ...(vaultId === undefined ? {} : { vaultId }),
        ...(groupId === undefined ? {} : { groupId }),
        add,
        from,
      });
    }
  }

  const revokes: Revoke[] = [];
  for (const [vault, entry] of held) {
    const set = group.vaults[vault];
    const remove = set === undefined ? 'all' : entry.permissions.filter((p) => !set.includes(p));
    if (remove === 'all' || remove.length > 0) {
      revokes.push({
        kind: 'revoke',
        vault,
        group: group.name,
        vaultId: entry.vaultId,
        groupId: groupId!,
        remove,
        from: entry.permissions,
      });
    }
  }
  return { grants, revokes };
}

/**
 * A group's live grants. One whose permissions `op` did not report reads as
 * unknown and is skipped, so it can never be revoked as unwanted.
 */
function liveGrantsOf(groupId: string, live: LiveState) {
  return Object.entries(live.grants).flatMap(([vaultId, list]) =>
    list
      .filter((g) => g.groupId === groupId && g.permissions.length > 0)
      .map((g) => ({ vaultId, permissions: g.permissions })),
  );
}

function matchVault(
  name: string,
  previousName: string | undefined,
  id: string | undefined,
  live: readonly LiveVault[],
): LiveVault | undefined {
  if (id !== undefined) {
    const pinned = live.find((v) => v.id === id);
    if (!pinned) {
      throw new PlanError(
        `Vault "${name}" is pinned to id ${id}, which the op session cannot see. ` +
          'Sign in as someone who can manage it, or check the id; a pinned vault is never created.',
      );
    }
    return pinned;
  }
  return unique('vault', name, live) ?? (previousName === undefined ? undefined : unique('vault', previousName, live));
}

function matchGroup(name: string, previousName: string | undefined, live: readonly LiveGroup[]): LiveGroup | undefined {
  return unique('group', name, live) ?? (previousName === undefined ? undefined : unique('group', previousName, live));
}

function unique<T extends { readonly id: string; readonly name: string }>(
  kind: string,
  name: string,
  live: readonly T[],
): T | undefined {
  const matches = live.filter((x) => x.name === name);
  if (matches.length > 1) {
    throw new PlanError(
      `${matches.length} live ${kind}s are named "${name}" (${matches.map((m) => m.id).join(', ')}). ` +
        `Pin the one to manage${kind === 'vault' ? ' with `id`' : ', or rename the others'}.`,
    );
  }
  return matches[0];
}

/** Name always; description only when both sides state one, so an unreported field never reads as drift. */
function fieldChanges(
  live: { readonly name: string; readonly description?: string },
  name: string,
  description: string | undefined,
): FieldChange[] {
  const fields: FieldChange[] = [];
  if (live.name !== name) {
    fields.push({ field: 'name', from: live.name, to: name });
  }
  if (description !== undefined && live.description !== undefined && live.description !== description) {
    fields.push({ field: 'description', from: live.description, to: description });
  }
  return fields;
}
