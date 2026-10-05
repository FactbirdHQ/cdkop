import { closePermissions, LEVELS, type Permission } from '../synth/permissions.ts';
import type { Vault } from './vault.ts';

/** A vault, by construct or by name. */
export type VaultRef = Vault | string;

/** One group's access to one vault. */
export interface VaultGrant {
  readonly vault: VaultRef;
  readonly permissions: readonly Permission[];
}

function grant(permissions: readonly Permission[], vaults: readonly VaultRef[]): VaultGrant[] {
  return vaults.map((vault) => ({ vault, permissions }));
}

/** View items, copy passwords and see item history: 1Password's `allow_viewing`. */
export function view(...vaults: VaultRef[]): VaultGrant[] {
  return grant(LEVELS.view, vaults);
}

/** Everything `view` grants, plus `allow_editing`: create, edit, archive, delete, import, export, share and print. */
export function edit(...vaults: VaultRef[]): VaultGrant[] {
  return grant(LEVELS.edit, vaults);
}

/** Everything `edit` grants, plus `manage_vault`: change who has access. */
export function manage(...vaults: VaultRef[]): VaultGrant[] {
  return grant(LEVELS.manage, vaults);
}

/**
 * A granular grant. Broad names are accepted, and every permission's
 * prerequisites are added, so `permissions(['edit_items'], v)` grants
 * `view_items`, `view_and_copy_passwords` and `edit_items`.
 */
export function permissions(names: readonly string[], ...vaults: VaultRef[]): VaultGrant[] {
  return grant(closePermissions(names), vaults);
}
