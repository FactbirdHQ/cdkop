import type { OpClient } from '../op/client.ts';
import { type Change, DELETE_SCOPES, type DeleteScope, isDestructive } from './changes.ts';

export type ApplyStatus = 'applied' | 'skipped' | 'failed';

/** One change and what became of it, as the journal records it. */
export interface ApplyRecord {
  readonly change: Change;
  readonly status: ApplyStatus;
  readonly error?: string;
}

export interface ApplyResult {
  readonly records: ApplyRecord[];
  /** The changes never attempted because an earlier one failed. */
  readonly notAttempted: Change[];
}

/** `true` unlocks every destructive kind; a set unlocks only the scopes it names. */
export type AllowDelete = boolean | ReadonlySet<DeleteScope>;

export function deleteAllowed(change: Change, allowDelete: AllowDelete): boolean {
  if (!isDestructive(change)) {
    return true;
  }
  if (typeof allowDelete === 'boolean') {
    return allowDelete;
  }
  return [...allowDelete].some((scope) => (DELETE_SCOPES[scope] as readonly string[]).includes(change.kind));
}

/**
 * Execute a plan's changes in order. A destructive change the flags do not
 * unlock is skipped. The first failure stops the run, because a later grant
 * may name the vault or group the failed change was creating; what ran and
 * what did not is in the result, and in the journal as it happens.
 */
export async function apply(
  client: OpClient,
  changes: readonly Change[],
  options: { readonly allowDelete: AllowDelete; readonly onRecord?: (record: ApplyRecord) => void },
): Promise<ApplyResult> {
  const records: ApplyRecord[] = [];
  const createdVaults = new Map<string, string>();
  const createdGroups = new Map<string, string>();
  const record = (r: ApplyRecord) => {
    records.push(r);
    options.onRecord?.(r);
  };

  for (const [index, change] of changes.entries()) {
    if (!deleteAllowed(change, options.allowDelete)) {
      record({ change, status: 'skipped' });
      continue;
    }
    try {
      switch (change.kind) {
        case 'create-vault': {
          const { name, description, icon, allowAdminsToManage } = change.vault;
          const created = await client.createVault({ name, description, icon, allowAdminsToManage });
          createdVaults.set(name, created.id);
          break;
        }
        case 'update-vault':
          await client.editVault(change.id, editParams(change.fields));
          break;
        case 'create-group': {
          const created = await client.createGroup(change.group.name, change.group.description);
          createdGroups.set(change.group.name, created.id);
          break;
        }
        case 'update-group':
          await client.editGroup(change.id, editParams(change.fields));
          break;
        case 'grant': {
          const vaultId = change.vaultId ?? createdVaults.get(change.vault);
          const groupId = change.groupId ?? createdGroups.get(change.group);
          if (vaultId === undefined || groupId === undefined) {
            throw new Error(
              `No id for ${vaultId === undefined ? `vault "${change.vault}"` : `group "${change.group}"`}.`,
            );
          }
          await client.grant(vaultId, groupId, change.add);
          break;
        }
        case 'revoke':
          await client.revoke(change.vaultId, change.groupId, change.remove);
          break;
        case 'regrant':
          await client.revoke(change.vaultId, change.groupId, 'all');
          await client.grant(change.vaultId, change.groupId, change.permissions);
          break;
      }
      record({ change, status: 'applied' });
    } catch (error) {
      record({ change, status: 'failed', error: error instanceof Error ? error.message : String(error) });
      return { records, notAttempted: changes.slice(index + 1) };
    }
  }
  return { records, notAttempted: [] };
}

function editParams(fields: readonly { field: 'name' | 'description'; to: string }[]): {
  name?: string;
  description?: string;
} {
  return Object.fromEntries(fields.map((f) => [f.field, f.to]));
}
