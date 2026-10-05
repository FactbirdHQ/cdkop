import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { FakeOp } from './fake-op.ts';

/**
 * Deleting a vault deletes every item in it, and deleting a group can take
 * provisioned access with it. cdkop has no code path for either, and these
 * tests fail the build if one appears.
 */
describe('cdkop never deletes a vault or a group', () => {
  test('the client interface has no delete', () => {
    const methods = Object.getOwnPropertyNames(FakeOp.prototype);
    expect(methods.filter((m) => /delete|remove/i.test(m))).toEqual([]);
  });

  test('no source file asks op to delete anything', () => {
    const files = (readdirSync('src', { recursive: true }) as string[]).filter((f) => f.endsWith('.ts'));
    for (const file of files) {
      const source = readFileSync(join('src', file), 'utf8');
      expect({ file, hit: /['"](delete|remove|rm)['"]/.test(source) }).toEqual({ file, hit: false });
    }
  });
});
