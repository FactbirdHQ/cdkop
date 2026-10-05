import { Construct } from 'constructs';

import type { VaultGrant } from './grants.ts';

export interface GroupProps {
  /**
   * The group's name in 1Password. Defaults to the construct id, or to
   * `externalGroup` when that is set.
   */
  readonly name?: string;

  /**
   * The name the group carries in 1Password now, when a new `name` renames it.
   * Not allowed on an external group, whose name Entra ID owns.
   */
  readonly previousName?: string;

  /** Not allowed on an external group, whose description the SCIM bridge owns. */
  readonly description?: string;

  /**
   * The identity provider group this group is provisioned from, by display
   * name. cdkop never edits its name or description, or touches its members.
   *
   * When the definition declares `ScimProvisioning`, the SCIM bridge creates
   * the group, named after the identity provider's group, and cdkop only grants
   * it vault access once it exists. Until then `plan` reports it as awaiting
   * provisioning and defers its grants. `cdkop scim` assigns every external
   * group to the provisioning application, unless `ScimProvisioning` lists its
   * groups explicitly.
   *
   * Without `ScimProvisioning`, cdkop creates the group itself, under the same
   * name, so the name is already right when provisioning arrives.
   */
  readonly externalGroup?: string;

  /**
   * Vault access: `[...view(shared), ...edit('Infrastructure')]`.
   *
   * A group the definition declares owns its vault access. A live grant this
   * list does not carry, or carries narrower, is proposed for revocation,
   * gated by `--allow-delete`.
   */
  readonly vaults?: readonly VaultGrant[];
}

/**
 * A 1Password group.
 *
 * 1Password groups are flat, but a definition can nest them: a `Group` whose
 * scope is another `Group` inherits every vault grant of its ancestors, the
 * way a GitHub child team inherits its parent's repositories. Synthesis
 * flattens that into each group's effective access, so the nesting exists in
 * the definition and in `plan`'s output, never in 1Password.
 */
export class Group extends Construct {
  public readonly groupName: string;
  public readonly props: GroupProps;

  constructor(scope: Construct, id: string, props: GroupProps = {}) {
    super(scope, id);
    this.props = props;
    this.groupName = props.name ?? props.externalGroup ?? id;
  }

  /** Declare a child group, which inherits this group's vault access. */
  addSubGroup(id: string, props: GroupProps = {}): Group {
    return new Group(this, id, props);
  }
}
