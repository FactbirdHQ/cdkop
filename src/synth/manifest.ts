/**
 * The desired-state manifest: what `cdkop synth` writes to `op.out/manifest.json`
 * and what `plan` and `apply` read. Plain JSON, no secrets.
 */
import type { Permission } from './permissions.ts';

export interface DesiredState {
  readonly version: 1;
  readonly account: AccountManifest;
  readonly vaults: VaultManifest[];
  readonly groups: GroupManifest[];
  readonly scim?: ScimProvisioningManifest;
  /** Where the manifest came from, stamped by `cdkop synth`. */
  readonly provenance?: ManifestProvenance;
}

export interface AccountManifest {
  /**
   * The account's sign-in address, e.g. `example.1password.com`. Every `op`
   * call is pinned to it, and `plan` refuses a session signed into another.
   */
  readonly signInAddress: string;
}

export interface VaultManifest {
  readonly name: string;
  /** The name the vault carries in 1Password now, when `name` renames it. */
  readonly previousName?: string;
  /** The vault's id, when known. A pinned vault is never created, only adopted. */
  readonly id?: string;
  readonly description?: string;
  /** Applied when the vault is created; 1Password does not report it back. */
  readonly icon?: string;
  /** Applied when the vault is created; 1Password does not report it back. */
  readonly allowAdminsToManage?: boolean;
  /**
   * `service-account` when a service account creates and manages the vault.
   * A run as a service account touches only these vaults; a run as a person
   * manages every vault.
   */
  readonly owner?: VaultOwner;
}

/** Who creates and manages a vault in a run that can't manage them all. */
export type VaultOwner = 'service-account';

export interface GroupManifest {
  /** The group's name in 1Password, which is its identity. */
  readonly name: string;
  readonly previousName?: string;
  readonly description?: string;
  /**
   * The identity provider group this group is provisioned from. Its members
   * are never touched. With `scim` declared, the bridge creates the group and
   * cdkop waits for it; without, cdkop creates it.
   */
  readonly externalGroup?: string;
  /** Name of the enclosing group in the definition, whose grants this one inherits. */
  readonly parent?: string;
  /**
   * Effective vault access: the group's own grants merged with every
   * ancestor's, each a closed granular set in canonical order.
   */
  readonly vaults: Readonly<Record<string, Permission[]>>;
}

export interface ScimProvisioningManifest {
  /** The Entra tenant, as its GUID or a verified domain name. */
  readonly tenantId: string;
  /** Display name of the enterprise application that provisions 1Password. */
  readonly applicationDisplayName: string;
  /** The SCIM bridge's base URL, written to the job only on `--rotate-token`. */
  readonly tenantUrl?: string;
  /** Environment variable holding the bridge's bearer token, read only on `--rotate-token`. */
  readonly tokenFrom: string;
  /** Display names of the Entra security groups to assign to the application. */
  readonly groups: string[];
}

export interface ManifestProvenance {
  readonly source: string;
  readonly commit?: string;
  readonly dirty?: boolean;
  readonly synthesizedAt: string;
}
