import type { IConstruct } from 'constructs';

import { Account } from '../constructs/account.ts';
import type { VaultRef } from '../constructs/grants.ts';
import { Group } from '../constructs/group.ts';
import { ScimProvisioning } from '../constructs/scim-provisioning.ts';
import { Vault } from '../constructs/vault.ts';
import { BUILT_IN_GROUPS } from './built-in-groups.ts';
import type { DesiredState, GroupManifest, ScimProvisioningManifest, VaultManifest } from './manifest.ts';
import { closePermissions, type Permission } from './permissions.ts';

/**
 * Walk a construct tree into the desired state, failing on anything `apply`
 * could not carry out as written: a second account, a duplicate name, a grant
 * to an undeclared vault, a built-in group declared as if cdkop could own it.
 */
export function synthesize(root: IConstruct): DesiredState {
  const accounts = root.node.findAll().filter((c): c is Account => c instanceof Account);
  if (accounts.length !== 1) {
    throw new Error(`A definition declares exactly one Account; this one declares ${accounts.length}.`);
  }
  const account = accounts[0]!;

  const vaults = vaultsOf(account);
  const vaultNames = new Set(vaults.map((v) => v.name));
  const groups = groupsOf(account, (ref, where) => resolveVault(ref, where, account, vaultNames));
  const scim = scimOf(account, groups);

  return {
    version: 1,
    account: { signInAddress: normaliseSignInAddress(account.props.signInAddress) },
    vaults,
    groups,
    ...(scim ? { scim } : {}),
  };
}

/** `https://Example.1Password.com/` and `example.1password.com` are one account. */
export function normaliseSignInAddress(address: string): string {
  return address
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');
}

function vaultsOf(account: Account): VaultManifest[] {
  const out: VaultManifest[] = [];
  const seen = new Map<string, string>();
  for (const vault of account.node.findAll().filter((c): c is Vault => c instanceof Vault)) {
    if (vault.node.scope !== account) {
      throw new Error(`Vault "${vault.vaultName}" (${vault.node.path}) must be declared directly under the Account.`);
    }
    const { previousName, id, description, icon, allowAdminsToManage } = vault.props;
    for (const name of [vault.vaultName, previousName].filter((n): n is string => n !== undefined)) {
      const other = seen.get(name);
      if (other !== undefined) {
        throw new Error(`Vault name "${name}" is declared twice (${other} and ${vault.node.path}).`);
      }
      seen.set(name, vault.node.path);
    }
    out.push({
      name: vault.vaultName,
      ...(previousName === undefined ? {} : { previousName }),
      ...(id === undefined ? {} : { id }),
      ...(description === undefined ? {} : { description }),
      ...(icon === undefined ? {} : { icon }),
      ...(allowAdminsToManage === undefined ? {} : { allowAdminsToManage }),
    });
  }
  return out;
}

function resolveVault(ref: VaultRef, where: string, account: Account, declared: ReadonlySet<string>): string {
  if (typeof ref !== 'string') {
    if (ref.node.scope !== account) {
      throw new Error(`${where} grants vault "${ref.vaultName}", which belongs to another account.`);
    }
    return ref.vaultName;
  }
  if (!declared.has(ref)) {
    throw new Error(`${where} grants vault "${ref}", which no Vault declares. Declare it, or fix the name.`);
  }
  return ref;
}

function groupsOf(account: Account, resolve: (ref: VaultRef, where: string) => string): GroupManifest[] {
  const out: GroupManifest[] = [];
  const seen = new Map<string, string>();
  const visited = new Set<Group>();

  const visit = (group: Group, parent: Group | undefined, inherited: ReadonlyMap<string, Permission[]>) => {
    visited.add(group);
    const where = `Group "${group.groupName}" (${group.node.path})`;
    const { previousName, description, externalGroup } = group.props;

    if (BUILT_IN_GROUPS.has(group.groupName)) {
      throw new Error(`${where} is one of 1Password's built-in groups, which a definition cannot declare.`);
    }
    if (externalGroup !== undefined) {
      if (group.props.name !== undefined && group.props.name !== externalGroup) {
        throw new Error(
          `${where} sets name "${group.props.name}" and externalGroup "${externalGroup}". ` +
            'The SCIM bridge names the group after the Entra group, so the two must agree; drop `name`.',
        );
      }
      if (previousName !== undefined || description !== undefined) {
        throw new Error(
          `${where} is provisioned from Entra ID, which owns its name and description; drop previousName and description.`,
        );
      }
    }
    for (const name of [group.groupName, previousName].filter((n): n is string => n !== undefined)) {
      const other = seen.get(name);
      if (other !== undefined) {
        throw new Error(`Group name "${name}" is declared twice (${other} and ${group.node.path}).`);
      }
      seen.set(name, group.node.path);
    }

    const own = new Map<string, Permission[]>();
    for (const grant of group.props.vaults ?? []) {
      const vault = resolve(grant.vault, where);
      if (own.has(vault)) {
        throw new Error(`${where} grants vault "${vault}" twice. Merge the two grants into one.`);
      }
      own.set(vault, closePermissions(grant.permissions));
    }

    const effective = new Map(inherited);
    for (const [vault, set] of own) {
      effective.set(vault, closePermissions([...(effective.get(vault) ?? []), ...set]));
    }

    out.push({
      name: group.groupName,
      ...(previousName === undefined ? {} : { previousName }),
      ...(description === undefined ? {} : { description }),
      ...(externalGroup === undefined ? {} : { externalGroup }),
      ...(parent ? { parent: parent.groupName } : {}),
      vaults: Object.fromEntries([...effective].sort(([a], [b]) => a.localeCompare(b))),
    });

    for (const child of group.node.children) {
      if (child instanceof Group) {
        visit(child, group, effective);
      }
    }
  };

  for (const child of account.node.children) {
    if (child instanceof Group) {
      visit(child, undefined, new Map());
    }
  }

  const stray = account.node.findAll().filter((c) => c instanceof Group && !visited.has(c));
  if (stray.length > 0) {
    throw new Error(
      `Groups must be declared under the Account or under another Group: ${stray.map((c) => c.node.path).join(', ')}.`,
    );
  }
  return out;
}

function scimOf(account: Account, groups: readonly GroupManifest[]): ScimProvisioningManifest | undefined {
  const declarations = account.node.findAll().filter((c): c is ScimProvisioning => c instanceof ScimProvisioning);
  if (declarations.length > 1) {
    throw new Error('A definition declares at most one ScimProvisioning.');
  }
  const scim = declarations[0];
  if (!scim) {
    return undefined;
  }
  const { tenantId, applicationDisplayName, tenantUrl, tokenFrom, groups: listed } = scim.props;
  const derived = groups.flatMap((g) => (g.externalGroup ? [g.externalGroup] : []));
  return {
    tenantId,
    applicationDisplayName,
    ...(tenantUrl === undefined ? {} : { tenantUrl }),
    tokenFrom: tokenFrom ?? 'OP_SCIM_BEARER_TOKEN',
    groups: [...new Set(listed ?? derived)].sort(),
  };
}
