/**
 * What a service account's applies have done, kept in 1Password.
 *
 * A service account reads which groups can open a vault but not with which
 * permissions, so its plans compare the definition with this record rather
 * than with the account. The record changes only for changes that applied,
 * so a failed run is retried on the next one rather than forgotten.
 *
 * It lives as a Document item in a vault the service account creates for
 * it. Nobody else is granted that vault, and Owners and Administrators hold
 * only `manage_vault` there, the default for a new vault.
 */
import type { OpClient } from '../op/client.ts';
import { closePermissions, type Permission } from '../synth/permissions.ts';
import type { ApplyRecord } from './applier.ts';
import type { LiveState } from './live.ts';

/** The vault holding the record. */
export const STATE_VAULT = 'cdkop state';

/** The Document item holding the record. */
export const STATE_DOCUMENT = 'cdkop-applied-state';

export interface AppliedState {
  readonly version: 1;
  /** By vault id: the vault's name when last applied, and each group's permissions. */
  readonly vaults: Readonly<
    Record<string, { readonly name: string; readonly groups: Readonly<Record<string, Permission[]>> }>
  >;
}

export const EMPTY_STATE: AppliedState = { version: 1, vaults: {} };

/** The record, or an empty one before the first apply. */
export async function loadState(client: OpClient, live: LiveState): Promise<AppliedState> {
  const vault = live.vaults.find((v) => v.name === STATE_VAULT);
  if (!vault) {
    return EMPTY_STATE;
  }
  const text = await client.readDocument(vault.id, STATE_DOCUMENT);
  if (text === undefined) {
    return EMPTY_STATE;
  }
  const state = JSON.parse(text) as AppliedState;
  if (state.version !== 1) {
    throw new Error(
      `The applied-state record in "${STATE_VAULT}" has version ${String(state.version)}, which this cdkop can't read.`,
    );
  }
  return state;
}

/** Write the record, creating its vault on the first apply. */
export async function saveState(client: OpClient, live: LiveState, state: AppliedState): Promise<void> {
  const vault =
    live.vaults.find((v) => v.name === STATE_VAULT) ??
    (await client.createVault({
      name: STATE_VAULT,
      description: 'What cdkop applied as this service account. Read and written by cdkop only.',
    }));
  await client.writeDocument(vault.id, STATE_DOCUMENT, `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * The record after an apply: \`before\` with every applied change folded in.
 * A change against a vault created in the same run is keyed by the id the
 * account reports after the run.
 */
export function nextState(
  before: AppliedState,
  records: readonly ApplyRecord[],
  vaultIds: ReadonlyMap<string, string>,
): AppliedState {
  const vaults = new Map(
    Object.entries(before.vaults).map(([id, v]) => [id, { name: v.name, groups: { ...v.groups } }]),
  );
  const entry = (id: string, name: string) => {
    const found = vaults.get(id) ?? { name, groups: {} };
    found.name = name;
    vaults.set(id, found);
    return found;
  };

  for (const { change, status } of records) {
    if (status !== 'applied') {
      continue;
    }
    switch (change.kind) {
      case 'create-vault': {
        const id = vaultIds.get(change.vault.name);
        if (id) {
          entry(id, change.vault.name);
        }
        break;
      }
      case 'update-vault':
        entry(change.id, change.vault.name);
        break;
      case 'grant': {
        const id = change.vaultId ?? vaultIds.get(change.vault);
        if (id) {
          const v = entry(id, change.vault);
          v.groups[change.group] = closePermissions([...(v.groups[change.group] ?? []), ...change.add]);
        }
        break;
      }
      case 'regrant':
        entry(change.vaultId, change.vault).groups[change.group] = [...change.permissions];
        break;
      case 'revoke': {
        const v = entry(change.vaultId, change.vault);
        const { remove } = change;
        if (remove === 'all') {
          v.groups = Object.fromEntries(Object.entries(v.groups).filter(([g]) => g !== change.group));
        } else {
          v.groups[change.group] = (v.groups[change.group] ?? []).filter((p) => !remove.includes(p));
        }
        break;
      }
      case 'create-group':
      case 'update-group':
        break;
    }
  }
  return { version: 1, vaults: Object.fromEntries(vaults) };
}
