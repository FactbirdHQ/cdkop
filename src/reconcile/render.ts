import { describePermissions, type Permission, sortPermissions } from '../synth/permissions.ts';
import { type Change, isDestructive, type Note } from './changes.ts';
import type { Plan } from './planner.ts';

/** One line per change, prefixed `+`, `~` or `-` the way `plan` prints it. */
export function describeChange(change: Change): string {
  switch (change.kind) {
    case 'create-vault':
      return `+ vault ${change.vault.name}`;
    case 'update-vault':
      return `~ vault ${change.vault.name}: ${fields(change.fields)}`;
    case 'create-group':
      return `+ group ${change.group.name}${change.group.parent ? ` (under ${change.group.parent})` : ''}`;
    case 'update-group':
      return `~ group ${change.group.name}: ${fields(change.fields)}`;
    case 'grant':
      return change.from.length === 0
        ? `+ ${change.group} → ${change.vault}: ${describePermissions(change.add)}`
        : `~ ${change.group} → ${change.vault}: ${access(change.from)} -> ${access(union(change.from, change.add))}`;
    case 'revoke': {
      const { remove } = change;
      if (remove === 'all') {
        return `- ${change.group} → ${change.vault}: ${access(change.from)}`;
      }
      const kept = change.from.filter((p) => !remove.includes(p));
      return `~ ${change.group} → ${change.vault}: ${access(change.from)} -> ${access(kept)}`;
    }
  }
}

export function describeNote(note: Note): string {
  switch (note.kind) {
    case 'awaiting-provisioning':
      return `group ${note.group} is not provisioned yet from Entra group "${note.externalGroup}"; ${note.grants} grant(s) deferred`;
    case 'undeclared-vault':
      return `vault ${note.name} is not declared (left alone)`;
    case 'undeclared-group':
      return `group ${note.name} is not declared (left alone)`;
  }
}

/**
 * The plan as `plan` and `apply` print it: changes, then a summary, then what
 * needs no change but is worth knowing. Destructive lines carry the flag that
 * unlocks them.
 */
export function renderPlan(
  account: string,
  plan: Plan,
  options: { readonly allowDelete?: (c: Change) => boolean } = {},
): string {
  const lines = [`Plan for 1Password account "${account}":`, ''];
  if (plan.changes.length === 0) {
    lines.push('  No changes. The account matches the definition.');
  }
  for (const change of plan.changes) {
    const gated = isDestructive(change) && !(options.allowDelete?.(change) ?? false);
    lines.push(`  ${describeChange(change)}${gated ? '   (requires --allow-delete)' : ''}`);
  }
  if (plan.changes.length > 0) {
    lines.push('', `  ${summary(plan.changes)}`);
  }

  const awaiting = plan.notes.filter((n) => n.kind === 'awaiting-provisioning');
  const undeclared = plan.notes.filter((n) => n.kind !== 'awaiting-provisioning');
  if (awaiting.length > 0) {
    lines.push('', 'Awaiting SCIM provisioning:', ...awaiting.map((n) => `  … ${describeNote(n)}`));
  }
  if (undeclared.length > 0) {
    lines.push('', 'Not declared:', ...undeclared.map((n) => `  · ${describeNote(n)}`));
  }
  return `${lines.join('\n')}\n`;
}

function summary(changes: readonly Change[]): string {
  const creates = changes.filter((c) => c.kind === 'create-vault' || c.kind === 'create-group').length;
  const grants = changes.filter((c) => c.kind === 'grant').length;
  const updates = changes.filter((c) => c.kind === 'update-vault' || c.kind === 'update-group').length;
  const revokes = changes.filter(isDestructive).length;
  return `${creates} to create, ${updates} to update, ${grants} to grant, ${revokes} to revoke.`;
}

function fields(list: readonly { field: string; from: string | undefined; to: string }[]): string {
  return list.map((f) => `${f.field} ${JSON.stringify(f.from ?? '')} -> ${JSON.stringify(f.to)}`).join(', ');
}

function access(set: readonly Permission[]): string {
  return set.length === 0 ? 'none' : describePermissions(set);
}

function union(a: readonly Permission[], b: readonly Permission[]): Permission[] {
  return sortPermissions(new Set([...a, ...b]));
}
