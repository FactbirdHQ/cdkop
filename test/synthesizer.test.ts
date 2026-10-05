import { describe, expect, test } from 'bun:test';

import { Account, App, edit, Group, manage, permissions, ScimProvisioning, Vault, view } from '../src/index.ts';
import { LEVELS } from '../src/synth/permissions.ts';
import { synthesize } from '../src/synth/synthesizer.ts';

function account(signInAddress = 'example.1password.com') {
  const app = new App({ outdir: '/dev/null' });
  return { app, account: new Account(app, 'example', { signInAddress }) };
}

describe('synthesize', () => {
  test('normalises the sign-in address', () => {
    const { app } = account('https://Example.1Password.com/');
    expect(synthesize(app).account.signInAddress).toBe('example.1password.com');
  });

  test('a nested group inherits its ancestors grants, widening where both grant', () => {
    const { app, account: a } = account();
    const shared = new Vault(a, 'Shared');
    const infra = new Vault(a, 'Infrastructure');
    const parent = new Group(a, 'engineering', { vaults: [...view(shared, infra)] });
    parent.addSubGroup('devops', { vaults: [...manage(infra)] });

    const groups = synthesize(app).groups;
    expect(groups.map((g) => g.name)).toEqual(['engineering', 'devops']);
    expect(groups[1]).toEqual({
      name: 'devops',
      parent: 'engineering',
      vaults: { Infrastructure: [...LEVELS.manage], Shared: [...LEVELS.view] },
    });
  });

  test('a granular grant is closed under its prerequisites', () => {
    const { app, account: a } = account();
    new Vault(a, 'Shared');
    new Group(a, 'g', { vaults: [...permissions(['edit_items'], 'Shared')] });
    expect(synthesize(app).groups[0]!.vaults.Shared).toEqual(['view_items', 'view_and_copy_passwords', 'edit_items']);
  });

  test('a grant may name only a declared vault', () => {
    const { app, account: a } = account();
    new Group(a, 'g', { vaults: [...view('Nowhere')] });
    expect(() => synthesize(app)).toThrow('grants vault "Nowhere", which no Vault declares');
  });

  test('a group may not grant the same vault twice', () => {
    const { app, account: a } = account();
    new Vault(a, 'Shared');
    new Group(a, 'g', { vaults: [...view('Shared'), ...edit('Shared')] });
    expect(() => synthesize(app)).toThrow('grants vault "Shared" twice');
  });

  test('names are unique, previous names included', () => {
    const { app, account: a } = account();
    new Vault(a, 'One');
    new Vault(a, 'Two', { previousName: 'One' });
    expect(() => synthesize(app)).toThrow('Vault name "One" is declared twice');
  });

  test('a built-in group cannot be declared', () => {
    const { app, account: a } = account();
    new Group(a, 'Administrators');
    expect(() => synthesize(app)).toThrow("one of 1Password's built-in groups");
  });

  test('an external group is named after its Entra group and owns nothing else', () => {
    const { app, account: a } = account();
    new Group(a, 'eng', { externalGroup: 'SG-Engineering' });
    expect(synthesize(app).groups[0]!.name).toBe('SG-Engineering');

    const second = account();
    new Group(second.account, 'eng', { name: 'Engineering', externalGroup: 'SG_X' });
    expect(() => synthesize(second.app)).toThrow('the two must agree');

    const third = account();
    new Group(third.account, 'eng', { externalGroup: 'SG_X', description: 'nope' });
    expect(() => synthesize(third.app)).toThrow('owns its name and description');
  });

  test('a vault must sit directly under the account', () => {
    const { app, account: a } = account();
    const g = new Group(a, 'g');
    new Vault(g, 'Hidden');
    expect(() => synthesize(app)).toThrow('must be declared directly under the Account');
  });

  test('exactly one account', () => {
    const app = new App({ outdir: '/dev/null' });
    expect(() => synthesize(app)).toThrow('declares 0');
  });

  test('SCIM groups default to every external group', () => {
    const { app, account: a } = account();
    const eng = new Group(a, 'eng', { externalGroup: 'SG_B' });
    new Group(eng, 'ops', { externalGroup: 'SG_A' });
    new Group(a, 'local');
    new ScimProvisioning(a, 'entra', {
      tenantId: 'contoso.onmicrosoft.com',
      applicationDisplayName: '1Password Business',
    });
    expect(synthesize(app).scim).toEqual({
      tenantId: 'contoso.onmicrosoft.com',
      applicationDisplayName: '1Password Business',
      tokenFrom: 'OP_SCIM_BEARER_TOKEN',
      groups: ['SG_A', 'SG_B'],
    });
  });
});
