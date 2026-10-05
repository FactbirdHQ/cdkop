import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { importAccount } from '../src/import/import-account.ts';
import { readLiveState } from '../src/reconcile/live.ts';
import { plan } from '../src/reconcile/planner.ts';
import type { DesiredState } from '../src/synth/manifest.ts';
import { LEVELS } from '../src/synth/permissions.ts';
import { FakeOp } from './fake-op.ts';

describe('importAccount', () => {
  test('emits a definition that plans no change against the account it came from', async () => {
    const op = new FakeOp({
      vaults: [
        { id: 'v1', name: 'Shared', description: "Everyone's" },
        { id: 'v2', name: 'IT' },
      ],
      groups: [
        { id: 'g0', name: 'Owners', type: 'OWNERS' },
        { id: 'g1', name: 'IT', description: 'Runs it', type: 'USER_DEFINED' },
        { id: 'g2', name: 'Sales', type: 'USER_DEFINED' },
      ],
      grants: {
        v1: [
          { groupId: 'g0', groupName: 'Owners', permissions: [...LEVELS.manage] },
          { groupId: 'g1', groupName: 'IT', permissions: [...LEVELS.edit] },
          { groupId: 'g2', groupName: 'Sales', permissions: ['view_items'] },
        ],
        v2: [{ groupId: 'g1', groupName: 'IT', permissions: [...LEVELS.manage] }],
      },
    });
    const live = await readLiveState(op);
    const source = importAccount(live, 'example.1password.com');
    expect(source).not.toContain('Owners');

    const dir = mkdtempSync(join(process.cwd(), 'test', '.import-'));
    try {
      const file = join(dir, 'definition.ts');
      const outdir = join(dir, 'out');
      writeFileSync(
        file,
        source
          .replace("from '@factbird/cdkop'", `from ${JSON.stringify(join(process.cwd(), 'src/index.ts'))}`)
          .replace('new App()', `new App({ outdir: ${JSON.stringify(outdir)} })`),
      );
      await import(file);
      const desired = JSON.parse(await Bun.file(join(outdir, 'manifest.json')).text()) as DesiredState;
      expect(plan(desired, live).changes).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
