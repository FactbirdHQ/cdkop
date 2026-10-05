import { Construct } from 'constructs';

export interface VaultProps {
  /** The vault's name in 1Password. Defaults to the construct id. */
  readonly name?: string;

  /**
   * The name the vault carries in 1Password now, when a new `name` renames it.
   * Without it, a renamed vault reads as a new vault to create, and the old
   * one, with its items, is left behind undeclared.
   */
  readonly previousName?: string;

  /**
   * The vault's id. A pinned vault is adopted, never created: when the signed-in
   * session cannot see it, `plan` fails instead of proposing a duplicate.
   *
   * `op` lists only the vaults the signed-in user can reach, so a vault an
   * administrator cannot manage is invisible and would otherwise read as
   * missing. Pin every vault that exists before cdkop adopts it.
   */
  readonly id?: string;

  readonly description?: string;

  /** The vault icon, applied on creation only. 1Password does not report it back. */
  readonly icon?: string;

  /**
   * Whether the Administrators group can manage the vault, applied on creation
   * only. Left unset, the account's default policy decides.
   */
  readonly allowAdminsToManage?: boolean;
}

/**
 * A shared vault.
 *
 * Declaring a vault adopts the one 1Password already has by that name, or
 * creates it. Removing the declaration leaves the vault alone: cdkop has no
 * code path that deletes a vault, because deleting one deletes every item in it.
 */
export class Vault extends Construct {
  public readonly vaultName: string;
  public readonly props: VaultProps;

  constructor(scope: Construct, id: string, props: VaultProps = {}) {
    super(scope, id);
    this.props = props;
    this.vaultName = props.name ?? id;
  }
}
