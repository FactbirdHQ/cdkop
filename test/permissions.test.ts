import { describe, expect, test } from 'bun:test';

import {
  closePermissions,
  describePermissions,
  LEVELS,
  levelOf,
  normaliseLivePermissions,
  PERMISSIONS,
  REQUIRES,
} from '../src/synth/permissions.ts';

describe('closePermissions', () => {
  test('adds every prerequisite, transitively', () => {
    expect(closePermissions(['archive_items'])).toEqual([
      'view_items',
      'view_and_copy_passwords',
      'edit_items',
      'archive_items',
    ]);
    expect(closePermissions(['import_items'])).toEqual(['view_items', 'create_items', 'import_items']);
  });

  test('expands the broad names', () => {
    expect(closePermissions(['allow_viewing'])).toEqual([...LEVELS.view]);
    expect(closePermissions(['allow_viewing', 'allow_editing', 'allow_managing'])).toEqual([...LEVELS.manage]);
  });

  test('refuses a name 1Password does not define', () => {
    expect(() => closePermissions(['view_secrets'])).toThrow('"view_secrets" is not a 1Password vault permission.');
  });

  test('every level is already closed', () => {
    for (const set of Object.values(LEVELS)) {
      expect(closePermissions(set)).toEqual([...set]);
    }
  });

  test('every prerequisite is itself a permission', () => {
    for (const p of PERMISSIONS) {
      for (const r of REQUIRES[p]) {
        expect(PERMISSIONS).toContain(r);
      }
    }
  });
});

describe('normaliseLivePermissions', () => {
  test('drops names it does not know instead of failing a read', () => {
    expect(normaliseLivePermissions(['allow_viewing', 'some_future_permission'])).toEqual([...LEVELS.view]);
  });
});

describe('levels', () => {
  test('a set that is exactly a level reads as its name', () => {
    expect(levelOf([...LEVELS.edit].reverse())).toBe('edit');
    expect(describePermissions([...LEVELS.manage])).toBe('manage');
  });

  test('anything else reads as its list', () => {
    expect(levelOf(['view_items'])).toBeUndefined();
    expect(describePermissions(['view_items', 'manage_vault'])).toBe('view_items, manage_vault');
  });
});
