import type { GroupManifest, VaultManifest } from '../synth/manifest.ts';
import type { Permission } from '../synth/permissions.ts';

/** A single differing field on an existing vault or group. */
export interface FieldChange {
  readonly field: 'name' | 'description';
  readonly from: string | undefined;
  readonly to: string;
}

export interface CreateVault {
  readonly kind: 'create-vault';
  readonly vault: VaultManifest;
}

export interface UpdateVault {
  readonly kind: 'update-vault';
  readonly id: string;
  readonly vault: VaultManifest;
  readonly fields: FieldChange[];
}

export interface CreateGroup {
  readonly kind: 'create-group';
  readonly group: GroupManifest;
}

export interface UpdateGroup {
  readonly kind: 'update-group';
  readonly id: string;
  readonly group: GroupManifest;
  readonly fields: FieldChange[];
}

/** Add permissions to a group's access to a vault. */
export interface Grant {
  readonly kind: 'grant';
  readonly vault: string;
  readonly group: string;
  /** Absent when the vault is created earlier in the same apply. */
  readonly vaultId?: string;
  /** Absent when the group is created earlier in the same apply. */
  readonly groupId?: string;
  readonly add: Permission[];
  readonly from: Permission[];
}

/**
 * Take permissions away from a group's access to a vault, or remove the
 * group from the vault outright (`remove: 'all'`). Gated by `--allow-delete`.
 */
export interface Revoke {
  readonly kind: 'revoke';
  readonly vault: string;
  readonly group: string;
  readonly vaultId: string;
  readonly groupId: string;
  readonly remove: Permission[] | 'all';
  readonly from: Permission[];
}

export type Change = CreateVault | UpdateVault | CreateGroup | UpdateGroup | Grant | Revoke;

/** What `--allow-delete=<scope>` unlocks, by scope. */
export const DELETE_SCOPES = {
  grants: ['revoke'],
} as const satisfies Record<string, readonly Change['kind'][]>;

export type DeleteScope = keyof typeof DELETE_SCOPES;

export function isDestructive(change: Change): change is Revoke {
  return change.kind === 'revoke';
}

/** Facts a plan reports that call for no change. */
export type Note =
  | {
      readonly kind: 'awaiting-provisioning';
      readonly group: string;
      readonly externalGroup: string;
      readonly grants: number;
    }
  | { readonly kind: 'undeclared-vault'; readonly name: string }
  | { readonly kind: 'undeclared-group'; readonly name: string };
