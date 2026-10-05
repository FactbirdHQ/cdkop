import { Construct } from 'constructs';

export interface ScimProvisioningProps {
  /** The Entra tenant the provisioning application lives in: its GUID, or a verified domain name. */
  readonly tenantId: string;

  /** Display name of the Entra enterprise application that provisions 1Password. */
  readonly applicationDisplayName: string;

  /**
   * The SCIM bridge's base URL, as the provisioning job's Tenant URL holds it.
   * Written only by `cdkop scim --rotate-token`.
   */
  readonly tenantUrl?: string;

  /**
   * Environment variable holding the bridge's bearer token. Read only by
   * `cdkop scim --rotate-token`; the token never appears in the definition or
   * the manifest.
   * @default "OP_SCIM_BEARER_TOKEN"
   */
  readonly tokenFrom?: string;

  /**
   * Display names of the Entra security groups to assign to the application.
   * Omitted, the list is every `externalGroup` a `Group` declares, which keeps
   * the groups granted vault access and the groups Entra pushes from drifting
   * apart.
   */
  readonly groups?: readonly string[];
}

/**
 * The Entra ID side of SCIM provisioning into 1Password: which security groups
 * the enterprise application pushes through the SCIM bridge.
 *
 * `cdkop scim` reconciles it over Microsoft Graph. It checks the tenant, finds
 * the application and its provisioning job, and assigns every declared group
 * that is not yet assigned. It only ever adds: a group assigned in Entra
 * outside this definition is reported, never unassigned.
 *
 * The bridge itself (its host, its `scimsession` credential) is
 * infrastructure, deployed elsewhere. So are the two settings 1Password keeps
 * in its admin console with no API: turning provisioning on and choosing
 * whether provisioned groups' memberships are managed by the IdP.
 */
export class ScimProvisioning extends Construct {
  public readonly props: ScimProvisioningProps;

  constructor(scope: Construct, id: string, props: ScimProvisioningProps) {
    super(scope, id);
    this.props = props;
  }
}
