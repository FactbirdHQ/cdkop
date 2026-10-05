import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type Connect, main, parseFlags } from '../src/cli.ts';
import type { DesiredState } from '../src/synth/manifest.ts';
import { LEVELS } from '../src/synth/permissions.ts';
import { FakeOp, type FakeOpState } from './fake-op.ts';

let dir: string;
let manifest: string;
const out: string[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cdkop-'));
  manifest = join(dir, 'manifest.json');
  out.length = 0;
  spyOn(console, 'info').mockImplementation((line: string) => void out.push(line));
  spyOn(console, 'error').mockImplementation((line: string) => void out.push(line));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function write(state: DesiredState): void {
  writeFileSync(manifest, JSON.stringify(state));
}

function connect(op: FakeOp, answers: { interactive?: boolean; confirm?: boolean } = {}): Connect {
  return {
    op: () => op,
    entra: () => {
      throw new Error('no entra in this test');
    },
    interactive: () => answers.interactive ?? false,
    confirm: async () => answers.confirm ?? false,
  };
}

const narrowing: { desired: DesiredState; live: FakeOpState } = {
  desired: {
    version: 1,
    account: { signInAddress: 'example.1password.com' },
    vaults: [{ name: 'Shared' }],
    groups: [{ name: 'IT', vaults: { Shared: [...LEVELS.view] } }],
  },
  live: {
    vaults: [{ id: 'v1', name: 'Shared' }],
    groups: [{ id: 'g1', name: 'IT', type: 'USER_DEFINED' }],
    grants: { v1: [{ groupId: 'g1', groupName: 'IT', permissions: [...LEVELS.manage] }] },
  },
};

describe('cdkop apply', () => {
  test('is a dry run without --yes', async () => {
    write(narrowing.desired);
    const op = new FakeOp(narrowing.live);
    expect(await main(['apply', '--manifest', manifest, '--allow-delete'], connect(op))).toBe(0);
    expect(op.calls).toEqual([]);
    expect(out.join('\n')).toContain('Dry run: 1 change(s) would be applied.');
  });

  test('holds a revocation back without --allow-delete', async () => {
    write(narrowing.desired);
    const op = new FakeOp(narrowing.live);
    expect(await main(['apply', '--manifest', manifest, '--yes'], connect(op))).toBe(0);
    expect(op.calls).toEqual([]);
    expect(out.join('\n')).toContain('1 revocation(s) held back');
  });

  test('refuses a revocation with no terminal to approve it', async () => {
    write(narrowing.desired);
    const op = new FakeOp(narrowing.live);
    expect(await main(['apply', '--manifest', manifest, '--yes', '--allow-delete=grants'], connect(op))).toBe(1);
    expect(op.calls).toEqual([]);
  });

  test('a declined prompt writes nothing; an accepted one backs up, then applies', async () => {
    write(narrowing.desired);
    const declined = new FakeOp(narrowing.live);
    expect(
      await main(
        ['apply', '--manifest', manifest, '--yes', '--allow-delete'],
        connect(declined, { interactive: true }),
      ),
    ).toBe(1);
    expect(declined.calls).toEqual([]);

    const accepted = new FakeOp(narrowing.live);
    const args = ['apply', '--manifest', manifest, '--yes', '--allow-delete'];
    expect(await main(args, connect(accepted, { interactive: true, confirm: true }))).toBe(0);
    expect(accepted.calls).toHaveLength(1);
    expect(existsSync(join(dir, 'backups'))).toBe(true);
  });

  test('--require-approval never applies unattended', async () => {
    write(narrowing.desired);
    const op = new FakeOp(narrowing.live);
    const args = ['apply', '--manifest', manifest, '--yes', '--allow-delete', '--require-approval', 'never'];
    expect(await main(args, connect(op))).toBe(0);
    expect(op.calls).toEqual([
      'revoke v1 g1 create_items,edit_items,archive_items,delete_items,import_items,export_items,copy_and_share_items,print_items,manage_vault',
    ]);
  });

  test('fails on the wrong account before reading further', async () => {
    write(narrowing.desired);
    const op = new FakeOp({ ...narrowing.live, account: { url: 'someone-else.1password.com' } });
    expect(await main(['plan', '--manifest', manifest], connect(op))).toBe(1);
    expect(out.join('\n')).toContain('reaches someone-else.1password.com');
  });
});

describe('parseFlags', () => {
  test('rejects an unknown delete scope and an unknown option', () => {
    expect(() => parseFlags(['--allow-delete=vaults'])).toThrow('is not one of grants');
    expect(() => parseFlags(['--force'])).toThrow('Unknown option: --force');
  });
});
