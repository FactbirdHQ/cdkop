#!/usr/bin/env bun
/**
 * The CLI the README recording runs: the real commands against an in-memory
 * 1Password account, so the recording needs no sign-in and writes nothing to
 * 1Password. Every call waits about as long as an `op` process takes, so the
 * read and the apply have something to show.
 *
 *   vhs docs/demo/cdkop.tape
 */
import { createInterface } from 'node:readline/promises';

import { main } from '../../src/cli.ts';
import type { OpClient } from '../../src/op/client.ts';
import { LEVELS } from '../../src/synth/permissions.ts';
import { FakeOp } from '../../test/fake-op.ts';

const account = new FakeOp({
  account: { url: 'https://example.1password.com/' },
  vaults: [{ id: 'v1', name: 'Shared' }],
  groups: [
    { id: 'g0', name: 'Administrators', type: 'ADMINISTRATORS' },
    { id: 'g1', name: 'IT', type: 'USER_DEFINED' },
    { id: 'g2', name: 'SG-Engineering', type: 'USER_DEFINED' },
  ],
  grants: {
    v1: [
      { groupId: 'g0', groupName: 'Administrators', permissions: ['manage_vault'] },
      { groupId: 'g1', groupName: 'IT', permissions: [...LEVELS.manage] },
    ],
  },
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** `account`, answering each call after the delay an `op` process would take. */
const client = new Proxy(account, {
  get(target, property, receiver) {
    const value = Reflect.get(target, property, receiver);
    if (typeof value !== 'function') {
      return value;
    }
    const writes = !/^(list|whoami|read)/.test(String(property));
    return async (...args: unknown[]) => {
      await sleep(writes ? 600 + Math.random() * 300 : 400 + Math.random() * 300);
      return value.apply(target, args);
    };
  },
}) as OpClient;

process.exit(
  await main(process.argv.slice(2), {
    op: () => client,
    entra: () => {
      throw new Error('The recording does not reach Entra ID.');
    },
    interactive: () => true,
    confirm: async (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return (await rl.question(question)).trim().toLowerCase() === 'y';
      } finally {
        rl.close();
      }
    },
  }),
);
