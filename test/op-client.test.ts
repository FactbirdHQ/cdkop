import { describe, expect, test } from 'bun:test';

import { CliOpClient } from '../src/op/client.ts';
import { LEVELS } from '../src/synth/permissions.ts';

function recording(responses: Record<string, unknown> = {}) {
  const calls: string[][] = [];
  const client = new CliOpClient('factbird.1password.eu', async (args) => {
    calls.push([...args]);
    const key = args
      .slice(0, args.indexOf('--account'))
      .filter((a) => a !== '--format=json')
      .join(' ');
    return key in responses ? JSON.stringify(responses[key]) : '';
  });
  return { calls, client };
}

describe('CliOpClient', () => {
  test('pins every call to the account and asks for JSON on reads', async () => {
    const { calls, client } = recording({ 'group list': [] });
    await client.listGroups();
    expect(calls).toEqual([['group', 'list', '--format=json', '--account', 'factbird.1password.eu']]);
  });

  test('reads vault details one by one and leaves personal vaults out', async () => {
    const { client } = recording({
      'vault list': [{ id: 'a' }, { id: 'b' }],
      'vault get a': { id: 'a', name: 'Shared', type: 'USER_CREATED', description: 'd' },
      'vault get b': { id: 'b', name: 'Private', type: 'PERSONAL' },
    });
    expect(await client.listVaults()).toEqual([{ id: 'a', name: 'Shared', description: 'd', type: 'USER_CREATED' }]);
  });

  test('normalises the permissions a vault grant reports', async () => {
    const { client } = recording({
      'vault group list v': [{ id: 'g', name: 'IT', permissions: ['allow_viewing', 'manage_vault'] }],
    });
    expect(await client.listVaultGroups('v')).toEqual([
      { groupId: 'g', groupName: 'IT', permissions: [...LEVELS.view, 'manage_vault'] },
    ]);
  });

  test('builds grant, partial revoke and full revoke', async () => {
    const { calls, client } = recording();
    await client.grant('v', 'g', ['view_items', 'manage_vault']);
    await client.revoke('v', 'g', ['manage_vault']);
    await client.revoke('v', 'g', 'all');
    expect(calls).toEqual([
      [
        'vault',
        'group',
        'grant',
        '--vault',
        'v',
        '--group',
        'g',
        '--permissions',
        'view_items,manage_vault',
        '--no-input',
        '--account',
        'factbird.1password.eu',
      ],
      [
        'vault',
        'group',
        'revoke',
        '--vault',
        'v',
        '--group',
        'g',
        '--no-input',
        '--permissions',
        'manage_vault',
        '--account',
        'factbird.1password.eu',
      ],
      ['vault', 'group', 'revoke', '--vault', 'v', '--group', 'g', '--no-input', '--account', 'factbird.1password.eu'],
    ]);
  });

  test('passes creation-only vault settings', async () => {
    const { calls, client } = recording({
      'vault create Ops --description d --icon gears --allow-admins-to-manage=false': { id: 'v', name: 'Ops' },
    });
    expect(
      await client.createVault({ name: 'Ops', description: 'd', icon: 'gears', allowAdminsToManage: false }),
    ).toEqual({
      id: 'v',
      name: 'Ops',
    });
    expect(calls[0]).toContain('--allow-admins-to-manage=false');
  });
});
