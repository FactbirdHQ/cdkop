/**
 * cdkop: define a 1Password account's vaults, groups and vault access as
 * Infrastructure as Code, built on the `constructs` programming model
 * (inspired by AWS CDK).
 *
 * Public authoring API. Import these in your definition (see `examples/`).
 */
export { Account, type AccountProps } from './constructs/account.ts';
export { App, type AppProps } from './constructs/app.ts';
export { edit, manage, permissions, type VaultGrant, type VaultRef, view } from './constructs/grants.ts';
export { Group, type GroupProps } from './constructs/group.ts';
export { ScimProvisioning, type ScimProvisioningProps } from './constructs/scim-provisioning.ts';
export { Vault, type VaultProps } from './constructs/vault.ts';
export { BUILT_IN_GROUPS } from './synth/built-in-groups.ts';
export type {
  AccountManifest,
  DesiredState,
  GroupManifest,
  ManifestProvenance,
  ScimProvisioningManifest,
  VaultManifest,
  VaultOwner,
} from './synth/manifest.ts';
export {
  BROAD_PERMISSIONS,
  type BroadPermission,
  LEVELS,
  type Level,
  PERMISSIONS,
  type Permission,
} from './synth/permissions.ts';
