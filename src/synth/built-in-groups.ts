/**
 * The groups every 1Password Business account has and nobody creates.
 *
 * A definition may not declare one, and `plan` never reports one as
 * undeclared. Their vault access is 1Password's own, set through each vault's
 * `allowAdminsToManage` and the account's policies rather than through grants.
 *
 * `op` reports a group's `type` on some commands and not others, so a live
 * group counts as built in when its type says so or, lacking a type, when its
 * name is one of these.
 */
export const BUILT_IN_GROUPS: ReadonlySet<string> = new Set([
  'Administrators',
  'Owners',
  'Recovery',
  'Team Members',
  'Security',
  'Provision Managers',
]);

/** The group type `op` reports for a group someone created. */
export const USER_DEFINED_GROUP_TYPE = 'USER_DEFINED';

export function isBuiltInGroup(group: { readonly name: string; readonly type?: string }): boolean {
  if (group.type !== undefined) {
    return group.type !== USER_DEFINED_GROUP_TYPE;
  }
  return BUILT_IN_GROUPS.has(group.name);
}
