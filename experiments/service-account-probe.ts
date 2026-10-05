/**
 * What can a 1Password service account do of what cdkop needs?
 *
 * Runs every `op` call cdkop makes, as the service account in
 * OP_SERVICE_ACCOUNT_TOKEN, and records whether each one worked and what it
 * printed. The JSON it captures also settles the output shapes cdkop parses
 * (`docs/design.md`, "Assumptions still to check").
 *
 * It writes only inside one vault it creates for the purpose, and deletes that
 * vault at the end. It refuses to write anything unless `op whoami` reports a
 * service account, so a desktop-app session can never be the one probed.
 *
 * Setup, as an administrator:
 *
 *   export OP_SERVICE_ACCOUNT_TOKEN=$(op service-account create cdkop-probe \
 *     --can-create-vaults --expires-in 1h --raw)
 *
 * Run:
 *
 *   PROBE_GROUP='<an existing group to grant view access to>' \
 *   PROBE_VAULT='<an existing shared vault the service account was NOT given>' \
 *     bun experiments/service-account-probe.ts
 *
 * PROBE_GROUP is required: the grant on the probe's own vault is the main
 * question. PROBE_VAULT is optional and only read, never written; it shows
 * whether the service account can see grants on a vault it did not create.
 *
 * The report goes to stdout and to op.out/service-account-probe.json.
 * Afterwards, delete the service account in the admin console, or let the
 * one-hour expiry do it.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

interface Step {
  readonly name: string;
  readonly command: string;
  readonly ok: boolean;
  readonly output: string;
}

const group = process.env.PROBE_GROUP;
const foreignVault = process.env.PROBE_VAULT;
if (!process.env.OP_SERVICE_ACCOUNT_TOKEN) {
  console.error('Set OP_SERVICE_ACCOUNT_TOKEN to the probe service account token first.');
  process.exit(1);
}
if (!group) {
  console.error('Set PROBE_GROUP to an existing group name.');
  process.exit(1);
}

const steps: Step[] = [];

/** Run `op`, record the step, and return its stdout when it succeeded. */
function op(name: string, args: string[]): string | undefined {
  const result = spawnSync(process.env.OP_BIN ?? 'op', args, { encoding: 'utf8' });
  const ok = result.status === 0;
  const output = (ok ? result.stdout : result.stderr || result.stdout || String(result.error ?? '')).trim();
  steps.push({ name, command: `op ${args.join(' ')}`, ok, output: output.slice(0, 2000) });
  console.info(`${ok ? '✓' : '✗'} ${name}`);
  return ok ? result.stdout : undefined;
}

function json<T>(text: string | undefined): T | undefined {
  try {
    return text ? (JSON.parse(text) as T) : undefined;
  } catch {
    return undefined;
  }
}

// Who is this? Everything below depends on it being a service account.
const me = json<{ user_type?: string; url?: string }>(op('whoami', ['whoami', '--format=json']));
if (me?.user_type !== 'SERVICE_ACCOUNT') {
  console.error(`op whoami reports ${me?.user_type ?? 'nothing'}, not SERVICE_ACCOUNT. Refusing to write anything.`);
  report();
  process.exit(1);
}
// cdkop pins every call with --account; check a service account tolerates it.
if (me.url) {
  op('whoami with --account (cdkop pins every call)', ['whoami', '--format=json', '--account', me.url]);
}

// The reads cdkop's plan makes.
op('list vaults', ['vault', 'list', '--format=json']);
const groups = json<Array<{ id: string; name: string }>>(op('list groups', ['group', 'list', '--format=json']));
op('get the probe group', ['group', 'get', group, '--format=json']);
op('list users (cdkop never does; for the record)', ['user', 'list', '--format=json']);
if (foreignVault) {
  op('get a vault it did not create', ['vault', 'get', foreignVault, '--format=json']);
  op('list group grants on a vault it did not create', ['vault', 'group', 'list', foreignVault, '--format=json']);
}

// Writes, confined to a vault this run creates.
const name = `cdkop-probe-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const created = json<{ id: string; name: string }>(
  op('create a vault', ['vault', 'create', name, '--description', 'cdkop service account probe', '--format=json']),
);
if (created?.id && created.name === name) {
  const vault = created.id;
  op('get its own vault (are type and description reported?)', ['vault', 'get', vault, '--format=json']);
  op('edit its own vault description', ['vault', 'edit', vault, '--description', 'cdkop probe, edited']);
  op('list group grants on its own vault', ['vault', 'group', 'list', vault, '--format=json']);

  op('grant the group view, by group name', [
    'vault',
    'group',
    'grant',
    '--vault',
    vault,
    '--group',
    group,
    '--permissions',
    'view_items',
    '--no-input',
  ]);
  const groupId = groups?.find((g) => g.name === group)?.id;
  if (groupId) {
    op('widen the grant, by group id', [
      'vault',
      'group',
      'grant',
      '--vault',
      vault,
      '--group',
      groupId,
      '--permissions',
      'allow_viewing',
      '--no-input',
    ]);
  }
  op('list group grants after granting (the permissions shape)', ['vault', 'group', 'list', vault, '--format=json']);
  op('revoke part of the grant', [
    'vault',
    'group',
    'revoke',
    '--vault',
    vault,
    '--group',
    group,
    '--permissions',
    'view_item_history',
    '--no-input',
  ]);
  op('revoke the rest', ['vault', 'group', 'revoke', '--vault', vault, '--group', group, '--no-input']);

  // Clean up the one vault this run created, by the id it was created with.
  if (op('delete the probe vault', ['vault', 'delete', vault]) === undefined) {
    console.error(`Could not delete probe vault ${name} (${vault}). Delete it in the admin console.`);
  }
} else {
  console.error('No vault was created, so none of the write probes ran.');
}

report();

function report(): void {
  mkdirSync('op.out', { recursive: true });
  writeFileSync(
    'op.out/service-account-probe.json',
    `${JSON.stringify({ at: new Date().toISOString(), steps }, null, 2)}\n`,
  );
  console.info('\nResults (also in op.out/service-account-probe.json):\n');
  for (const step of steps) {
    console.info(
      `${step.ok ? 'ok  ' : 'FAIL'}  ${step.name}\n      ${step.command}\n      ${step.output.split('\n').join('\n      ')}\n`,
    );
  }
}
