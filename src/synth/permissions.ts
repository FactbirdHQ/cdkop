/**
 * 1Password Business vault permissions, and the rules that tie them together.
 *
 * Every permission set cdkop compares or writes is granular and closed under
 * {@link REQUIRES}: the broad names `op` also accepts are expanded on the way
 * in, and a permission's prerequisites are added with it. Comparing two closed
 * sets is then plain set equality, and revoking the difference between two
 * closed sets never strands a permission whose prerequisite was taken away.
 *
 * Source: https://www.1password.dev/cli/vault-permissions/
 */

export const PERMISSIONS = [
  'view_items',
  'view_and_copy_passwords',
  'view_item_history',
  'create_items',
  'edit_items',
  'archive_items',
  'delete_items',
  'import_items',
  'export_items',
  'copy_and_share_items',
  'print_items',
  'manage_vault',
] as const;

/** One granular vault permission. */
export type Permission = (typeof PERMISSIONS)[number];

/** The broad names `op` accepts, each standing for a fixed group of granular ones. */
export const BROAD_PERMISSIONS = {
  allow_viewing: ['view_items', 'view_and_copy_passwords', 'view_item_history'],
  allow_editing: [
    'create_items',
    'edit_items',
    'archive_items',
    'delete_items',
    'import_items',
    'export_items',
    'copy_and_share_items',
    'print_items',
  ],
  allow_managing: ['manage_vault'],
} as const satisfies Record<string, readonly Permission[]>;

export type BroadPermission = keyof typeof BROAD_PERMISSIONS;

/** What granting each permission also requires, per 1Password's dependency table. */
export const REQUIRES: Readonly<Record<Permission, readonly Permission[]>> = {
  view_items: [],
  view_and_copy_passwords: ['view_items'],
  view_item_history: ['view_and_copy_passwords', 'view_items'],
  create_items: ['view_items'],
  edit_items: ['view_and_copy_passwords', 'view_items'],
  archive_items: ['edit_items', 'view_and_copy_passwords', 'view_items'],
  delete_items: ['edit_items', 'view_and_copy_passwords', 'view_items'],
  import_items: ['create_items', 'view_items'],
  export_items: ['view_item_history', 'view_and_copy_passwords', 'view_items'],
  copy_and_share_items: ['view_item_history', 'view_and_copy_passwords', 'view_items'],
  print_items: ['view_item_history', 'view_and_copy_passwords', 'view_items'],
  manage_vault: [],
};

/** The three access levels the grant helpers name, as closed granular sets. */
export const LEVELS = {
  view: [...BROAD_PERMISSIONS.allow_viewing],
  edit: [...BROAD_PERMISSIONS.allow_viewing, ...BROAD_PERMISSIONS.allow_editing],
  manage: [...BROAD_PERMISSIONS.allow_viewing, ...BROAD_PERMISSIONS.allow_editing, ...BROAD_PERMISSIONS.allow_managing],
} as const satisfies Record<string, readonly Permission[]>;

export type Level = keyof typeof LEVELS;

const ORDER: ReadonlyMap<string, number> = new Map(PERMISSIONS.map((p, i) => [p, i]));

export function isPermission(name: string): name is Permission {
  return ORDER.has(name);
}

export function isBroadPermission(name: string): name is BroadPermission {
  return Object.hasOwn(BROAD_PERMISSIONS, name);
}

/**
 * Expand broad names, add every prerequisite, and return the set in canonical
 * order. Throws on a name 1Password does not define.
 */
export function closePermissions(names: Iterable<string>): Permission[] {
  const out = new Set<Permission>();
  const add = (p: Permission) => {
    if (out.has(p)) {
      return;
    }
    out.add(p);
    for (const required of REQUIRES[p]) {
      add(required);
    }
  };
  for (const name of names) {
    if (isBroadPermission(name)) {
      for (const p of BROAD_PERMISSIONS[name]) {
        add(p);
      }
    } else if (isPermission(name)) {
      add(name);
    } else {
      throw new Error(`"${name}" is not a 1Password vault permission.`);
    }
  }
  return sortPermissions(out);
}

/**
 * Normalise what `op` reports for a live grant. Unknown names are dropped
 * rather than thrown on, so a permission 1Password adds later reads as
 * unmanaged instead of breaking every plan.
 */
export function normaliseLivePermissions(names: Iterable<string>): Permission[] {
  return closePermissions([...names].filter((n) => isPermission(n) || isBroadPermission(n)));
}

export function sortPermissions(set: Iterable<Permission>): Permission[] {
  return [...set].sort((a, b) => (ORDER.get(a) ?? 0) - (ORDER.get(b) ?? 0));
}

/** The level a set is exactly equal to, if any. */
export function levelOf(set: readonly Permission[]): Level | undefined {
  for (const level of Object.keys(LEVELS) as Level[]) {
    if (sameSet(LEVELS[level], set)) {
      return level;
    }
  }
  return undefined;
}

/** A set as a reader wants it: its level name when it is one, else the list. */
export function describePermissions(set: readonly Permission[]): string {
  return levelOf(set) ?? set.join(', ');
}

export function sameSet<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const bs = new Set(b);
  return a.every((x) => bs.has(x));
}
