import type { LiveState } from '../reconcile/live.ts';
import { isBuiltInGroup } from '../synth/built-in-groups.ts';
import { levelOf, type Permission } from '../synth/permissions.ts';

/**
 * A definition that reproduces the live account: every visible shared vault,
 * pinned by id, and every group someone created with its vault access.
 *
 * Applying it unchanged proposes nothing, which is what makes it a starting
 * point. Two things it cannot know: which groups the SCIM bridge provisioned
 * (those want `externalGroup` instead of a description), and any vault the
 * session cannot see.
 */
export function importAccount(live: LiveState, signInAddress: string): string {
  const lines: string[] = [
    'const app = new App();',
    `const account = new Account(app, 'account', { signInAddress: ${q(signInAddress)} });`,
    '',
  ];

  const vaults = [...live.vaults].sort((a, b) => a.name.localeCompare(b.name));
  for (const vault of vaults) {
    const props = [`id: ${q(vault.id)}`];
    if (vault.description) {
      props.push(`description: ${q(vault.description)}`);
    }
    lines.push(`new Vault(account, ${q(vault.name)}, { ${props.join(', ')} });`);
  }
  lines.push('');

  const vaultNames = new Set(vaults.map((v) => v.name));
  const vaultNameById = new Map(vaults.map((v) => [v.id, v.name]));
  const groups = live.groups.filter((g) => !isBuiltInGroup(g)).sort((a, b) => a.name.localeCompare(b.name));
  for (const group of groups) {
    const held: Array<[string, Permission[]]> = [];
    for (const [vaultId, list] of Object.entries(live.grants)) {
      const grant = list.find((g) => g.groupId === group.id);
      const vault = vaultNameById.get(vaultId);
      if (grant && vault !== undefined && grant.permissions.length > 0) {
        held.push([vault, grant.permissions]);
      }
    }
    held.sort(([a], [b]) => a.localeCompare(b));

    const id = vaultNames.has(group.name) ? `${group.name} (group)` : group.name;
    const props: string[] = [];
    if (id !== group.name) {
      props.push(`name: ${q(group.name)}`);
    }
    if (group.description) {
      props.push(`description: ${q(group.description)}`);
    }
    const grants = grantExpressions(held);
    if (grants.length > 0) {
      props.push(`vaults: [${grants.join(', ')}]`);
    }
    lines.push(`new Group(account, ${q(id)}${props.length > 0 ? `, {\n  ${props.join(',\n  ')},\n}` : ''});`);
  }

  lines.push('', 'app.synth();', '');
  const body = lines.join('\n');
  const helpers = ['edit', 'manage', 'permissions', 'view'].filter((h) => body.includes(`...${h}(`));
  const names = ['Account', 'App', ...(groups.length > 0 ? ['Group'] : []), 'Vault', ...helpers].sort((a, b) =>
    a.localeCompare(b),
  );
  return `import { ${names.join(', ')} } from '@factbird/cdkop';\n\n${body}`;
}

/** `...view('A', 'B')` per level, `...permissions([...], 'C')` for a set that is no level. */
function grantExpressions(held: ReadonlyArray<[string, Permission[]]>): string[] {
  const byLevel = new Map<string, string[]>();
  const custom: string[] = [];
  for (const [vault, set] of held) {
    const level = levelOf(set);
    if (level) {
      byLevel.set(level, [...(byLevel.get(level) ?? []), vault]);
    } else {
      custom.push(`...permissions([${set.map(q).join(', ')}], ${q(vault)})`);
    }
  }
  const levels = (['view', 'edit', 'manage'] as const)
    .filter((l) => byLevel.has(l))
    .map((l) => `...${l}(${byLevel.get(l)!.map(q).join(', ')})`);
  return [...levels, ...custom];
}

function q(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}
