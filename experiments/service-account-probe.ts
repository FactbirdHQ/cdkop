/**
 * What can a 1Password service account do of what cdkop needs?
 *
 * Runs every `op` call cdkop makes, as the service account in
 * OP_SERVICE_ACCOUNT_TOKEN, and records whether each one worked and what it
 * printed. The JSON it captures also settles the output shapes cdkop parses
 * (`docs/design.md`, "Assumptions still to check").
 *
 * With PROBE_ADMIN=1 it adds a second phase that also uses your own signed-in
 * session (the desktop app integration). An administrator creates a vault and
 * grants the service account `manage_vault` on it with `op vault user grant`,
 * then the service account tries to grant and revoke a group there. That is
 * the question of whether CI could manage vaults it did not create. The same
 * phase reads the vault's grants as the administrator and narrows a grant, to
 * see whether those work for an administrator where they failed for the
 * service account.
 *
 * Every write lands in a vault the run creates for the purpose, and the run
 * deletes each one at the end. It refuses to start unless the token's
 * `op whoami` reports a service account, and the administrator phase refuses
 * unless the session without the token reports someone else.
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
 *   PROBE_ADMIN=1 \
 *     bun experiments/service-account-probe.ts
 *
 * PROBE_GROUP is required: the group grants are the main question.
 * PROBE_VAULT is optional and only read, never written; it shows whether the
 * service account can see grants on a vault it did not create. PROBE_ADMIN is
 * optional and adds the administrator phase.
 *
 * The report goes to stdout and to op.out/service-account-probe.json. It lists
 * the account's vault and group names, so keep it out of anything public.
 * Afterwards, delete the service account in the admin console, or let the
 * one-hour expiry do it.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

/** Whose credentials a call runs with. */
type Actor = 'service account' | 'administrator';

interface Step {
  readonly as: Actor;
  readonly name: string;
  readonly command: string;
  readonly ok: boolean;
  readonly output: string;
}

const group = process.env.PROBE_GROUP ?? '';
const foreignVault = process.env.PROBE_VAULT;
const withAdmin = process.env.PROBE_ADMIN === '1';
if (!process.env.OP_SERVICE_ACCOUNT_TOKEN) {
  console.error('Set OP_SERVICE_ACCOUNT_TOKEN to the probe service account token first.');
  process.exit(1);
}
if (!group) {
  console.error('Set PROBE_GROUP to an existing group name.');
  process.exit(1);
}

const steps: Step[] = [];

/**
 * Run `op` as the service account or as the administrator, record the step,
 * and return its stdout when it succeeded. An administrator call runs without
 * OP_SERVICE_ACCOUNT_TOKEN, which `op` would otherwise prefer over the
 * desktop app session.
 */
function op(as: Actor, name: string, args: string[]): string | undefined {
  const env = { ...process.env };
  if (as === 'administrator') {
    delete env.OP_SERVICE_ACCOUNT_TOKEN;
  }
  const result = spawnSync(process.env.OP_BIN ?? 'op', args, { encoding: 'utf8', env });
  const ok = result.status === 0;
  const output = (ok ? result.stdout : result.stderr || result.stdout || String(result.error ?? '')).trim();
  steps.push({ as, name, command: `op ${args.join(' ')}`, ok, output: output.slice(0, 2000) });
  console.info(`${ok ? '✓' : '✗'} [${as}] ${name}`);
  return ok ? result.stdout : undefined;
}

const sa = (name: string, args: string[]) => op('service account', name, args);
const admin = (name: string, args: string[]) => op('administrator', name, args);

function json<T>(text: string | undefined): T | undefined {
  try {
    return text ? (JSON.parse(text) as T) : undefined;
  } catch {
    return undefined;
  }
}

function grant(vault: string, to: string, permissions: string): string[] {
  return ['vault', 'group', 'grant', '--vault', vault, '--group', to, '--permissions', permissions, '--no-input'];
}

function revoke(vault: string, from: string, permissions?: string): string[] {
  const args = ['vault', 'group', 'revoke', '--vault', vault, '--group', from, '--no-input'];
  return permissions === undefined ? args : [...args, '--permissions', permissions];
}

/** Create a vault, returning its id only when `op` created the one asked for. */
function createVault(as: Actor, name: string): string | undefined {
  const created = json<{ id: string; name: string }>(
    op(as, 'create a vault', [
      'vault',
      'create',
      name,
      '--description',
      'cdkop service account probe',
      '--format=json',
    ]),
  );
  return created?.id && created.name === name ? created.id : undefined;
}

/** Delete a vault this run created, by the id it was created with. */
function deleteVault(as: Actor, name: string, id: string): void {
  if (op(as, 'delete the probe vault', ['vault', 'delete', id]) === undefined) {
    console.error(`Could not delete probe vault ${name} (${id}). Delete it in the admin console.`);
  }
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');

// Who is this? Everything below depends on it being a service account.
const me = json<{ user_type?: string; url?: string; user_uuid?: string }>(sa('whoami', ['whoami', '--format=json']));
if (me?.user_type !== 'SERVICE_ACCOUNT') {
  console.error(`op whoami reports ${me?.user_type ?? 'nothing'}, not SERVICE_ACCOUNT. Refusing to write anything.`);
  report();
  process.exit(1);
}
// cdkop pins every call with --account; check a service account tolerates it.
if (me.url) {
  sa('whoami with --account (cdkop pins every call)', ['whoami', '--format=json', '--account', me.url]);
}

// The reads cdkop's plan makes.
sa('list vaults', ['vault', 'list', '--format=json']);
const groups = json<Array<{ id: string; name: string }>>(sa('list groups', ['group', 'list', '--format=json']));
sa('get the probe group', ['group', 'get', group, '--format=json']);
if (foreignVault) {
  sa('get a vault it did not create', ['vault', 'get', foreignVault, '--format=json']);
  sa('list group grants on a vault it did not create', ['vault', 'group', 'list', foreignVault, '--format=json']);
}

// Phase 1: a vault the service account creates itself.
const ownName = `cdkop-probe-${stamp}`;
const own = createVault('service account', ownName);
if (own) {
  sa('get its own vault (are type and description reported?)', ['vault', 'get', own, '--format=json']);
  sa('edit its own vault description', ['vault', 'edit', own, '--description', 'cdkop probe, edited']);
  sa('list group grants on its own vault', ['vault', 'group', 'list', own, '--format=json']);

  sa('grant the group view, by group name', grant(own, group, 'view_items'));
  const groupId = groups?.find((g) => g.name === group)?.id;
  if (groupId) {
    sa('widen the grant, by group id', grant(own, groupId, 'allow_viewing'));
  }
  sa('list group grants after granting (the permissions shape)', ['vault', 'group', 'list', own, '--format=json']);
  // `vault group list` may leave permissions out of its JSON. Two other places
  // that might report them: the human-readable table, and `vault list`
  // filtered by group and permission (one call per permission).
  sa('list group grants after granting, as a table', ['vault', 'group', 'list', own]);
  sa('vaults where the group has view_item_history', [
    'vault',
    'list',
    '--group',
    group,
    '--permission',
    'view_item_history',
    '--format=json',
  ]);
  sa('vaults where the group has manage_vault (expect none)', [
    'vault',
    'list',
    '--group',
    group,
    '--permission',
    'manage_vault',
    '--format=json',
  ]);
  sa('revoke part of the grant', revoke(own, group, 'view_item_history'));
  sa('revoke part of the grant by broad name', revoke(own, group, 'allow_viewing'));
  sa('revoke the rest', revoke(own, group));
  deleteVault('service account', ownName, own);
} else {
  console.error('The service account created no vault, so the phase 1 write probes did not run.');
}

// Phase 2: a vault an administrator creates and then hands the service account.
if (withAdmin) {
  administratorPhase(me.user_uuid);
}

report();

function administratorPhase(serviceAccountId: string | undefined): void {
  if (!serviceAccountId) {
    console.error('The service account reported no user id, so it cannot be granted a vault. Phase 2 skipped.');
    return;
  }
  // A user session's whoami carries no user_type, only a service account's
  // does, so tell the two apart by user id.
  const adminMe = json<{ user_type?: string; user_uuid?: string }>(admin('whoami', ['whoami', '--format=json']));
  if (!adminMe?.user_uuid || adminMe.user_uuid === serviceAccountId || adminMe.user_type === 'SERVICE_ACCOUNT') {
    console.error(
      'Without the token, op whoami reports no signed-in user, or the service account again. ' +
        'Sign in to the desktop app as an administrator to run phase 2. Skipped.',
    );
    return;
  }

  const name = `cdkop-probe-admin-${stamp}`;
  const vault = createVault('administrator', name);
  if (!vault) {
    console.error('The administrator created no vault, so phase 2 did not run.');
    return;
  }

  // The administrator's view of grants, which cdkop's plan depends on.
  admin('grant the group view', grant(vault, group, 'allow_viewing'));
  admin('list group grants (does an administrator get permissions?)', [
    'vault',
    'group',
    'list',
    vault,
    '--format=json',
  ]);
  admin('list group grants, as a table', ['vault', 'group', 'list', vault]);
  admin('revoke part of the grant (failed for the service account)', revoke(vault, group, 'view_item_history'));
  admin('list group grants after the partial revoke', ['vault', 'group', 'list', vault, '--format=json']);
  admin('revoke the rest', revoke(vault, group));

  // Hand the vault to the service account, then see what it can do there.
  admin('grant the service account manage_vault', [
    'vault',
    'user',
    'grant',
    '--vault',
    vault,
    '--user',
    serviceAccountId,
    '--permissions',
    'view_items,manage_vault',
    '--no-input',
  ]);
  admin('list user grants (the service account should appear)', ['vault', 'user', 'list', vault, '--format=json']);
  sa('see the handed-over vault', ['vault', 'get', vault, '--format=json']);
  sa('list group grants on the handed-over vault', ['vault', 'group', 'list', vault, '--format=json']);
  sa('grant the group view on the handed-over vault', grant(vault, group, 'view_items'));
  admin('confirm the service account grant landed', ['vault', 'group', 'list', vault, '--format=json']);
  sa('revoke the group on the handed-over vault', revoke(vault, group));

  deleteVault('administrator', name, vault);
}

function report(): void {
  mkdirSync('op.out', { recursive: true });
  writeFileSync(
    'op.out/service-account-probe.json',
    `${JSON.stringify({ at: new Date().toISOString(), steps }, null, 2)}\n`,
  );
  console.info('\nResults (also in op.out/service-account-probe.json):\n');
  for (const step of steps) {
    console.info(
      `${step.ok ? 'ok  ' : 'FAIL'}  [${step.as}] ${step.name}\n      ${step.command}\n      ${step.output.split('\n').join('\n      ')}\n`,
    );
  }
}
