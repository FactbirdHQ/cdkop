import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';

import { type EntraClient, MsGraphEntraClient } from './entra/graph.ts';
import { setUpScimProvisioning } from './entra/scim-setup.ts';
import { resolveGraphToken } from './entra/token.ts';
import { importAccount } from './import/import-account.ts';
import { CliOpClient, type OpClient } from './op/client.ts';
import { type AllowDelete, apply, deleteAllowed } from './reconcile/applier.ts';
import { writeBackup } from './reconcile/backup.ts';
import { type Change, DELETE_SCOPES, type DeleteScope, isDestructive } from './reconcile/changes.ts';
import { readLiveState } from './reconcile/live.ts';
import { PlanError, plan } from './reconcile/planner.ts';
import { describeChange, renderPlan } from './reconcile/render.ts';
import type { DesiredState } from './synth/manifest.ts';
import { normaliseSignInAddress } from './synth/synthesizer.ts';

const DEFAULT_MANIFEST = 'op.out/manifest.json';

const USAGE = `cdkop: define a 1Password account's vaults, groups and vault access as code

Usage:
  cdkop synth <definition.ts>   Run a definition and write op.out/manifest.json
  cdkop plan  [options]         Compare the manifest with the live account (read-only)
  cdkop apply [options]         Bring the live account in line with the manifest.
                                Dry run without --yes.
  cdkop import <sign-in address>
                                Read a live account and print a definition (read-only)
  cdkop scim  [options]         Assign the manifest's Entra groups to the 1Password
                                provisioning application. Dry run without --yes.

Options:
  --manifest <path>   Manifest to read (default: ${DEFAULT_MANIFEST})
  --output <path>     Where import writes the definition (default: stdout)
  --yes               Execute (apply, scim). Without it, nothing is written.
  --allow-delete[=scopes]
                      Permit revoking vault access the manifest does not grant.
                      Scopes: ${Object.keys(DELETE_SCOPES).join(', ')}.
  --require-approval <never|destructive|any-change>
                      When apply pauses for an interactive "y" (default:
                      destructive). In automation, pass "never".
  --rotate-token      scim: also rewrite the provisioning job's Tenant URL and
                      bearer token, read from the variable the definition names.

Every apply that writes first saves backups/<time>/ beside the manifest: the
live state it read, the manifest, the plan, and a journal of each change.

Auth: every read and write goes through \`op\`, pinned to the definition's
account with --account. Sign in first (\`op signin\`) as an owner or an
administrator who can manage groups and vaults; a service account cannot.
\`scim\` talks to Microsoft Graph with AZURE_GRAPH_TOKEN, else
\`az account get-access-token\`.`;

type RequireApproval = 'never' | 'destructive' | 'any-change';

export interface Flags {
  manifest: string;
  output?: string;
  yes: boolean;
  allowDelete: boolean | DeleteScope[];
  requireApproval: RequireApproval;
  rotateToken: boolean;
  positional: string[];
}

/** How the CLI reaches 1Password and Entra; tests substitute fakes. */
export interface Connect {
  readonly op: (signInAddress: string) => OpClient;
  readonly entra: () => EntraClient;
  /** Whether a person is at the terminal to answer a prompt. */
  readonly interactive: () => boolean;
  readonly confirm: (question: string) => Promise<boolean>;
}

const defaultConnect: Connect = {
  op: (signInAddress) => new CliOpClient(signInAddress),
  entra: () => new MsGraphEntraClient(resolveGraphToken()),
  interactive: () => Boolean(process.stdin.isTTY && process.stdout.isTTY),
  confirm: async (question) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return (await rl.question(question)).trim().toLowerCase() === 'y';
    } finally {
      rl.close();
    }
  },
};

export async function main(argv: string[], connect: Connect = defaultConnect): Promise<number> {
  const [command, ...rest] = argv;
  let flags: Flags;
  try {
    flags = parseFlags(rest);
  } catch (error) {
    console.error(`${message(error)}\n\n${USAGE}`);
    return 1;
  }

  try {
    switch (command) {
      case 'synth':
        return await synthCommand(flags.positional[0]);
      case 'plan':
        return await planCommand(flags, connect);
      case 'apply':
        return await applyCommand(flags, connect);
      case 'import':
        return await importCommand(flags, connect);
      case 'scim':
        return await scimCommand(flags, connect);
      case '-h':
      case '--help':
      case undefined:
        console.info(USAGE);
        return 0;
      default:
        console.error(`Unknown command: ${command}\n\n${USAGE}`);
        return 1;
    }
  } catch (error) {
    console.error(error instanceof PlanError ? message(error) : `error: ${message(error)}`);
    return 1;
  }
}

export function parseFlags(args: readonly string[]): Flags {
  const flags: Flags = {
    manifest: DEFAULT_MANIFEST,
    yes: false,
    allowDelete: false,
    requireApproval: 'destructive',
    rotateToken: false,
    positional: [],
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const [name, inline] = arg.startsWith('--') ? (arg.split(/=(.*)/s, 2) as [string, string | undefined]) : [arg];
    const value = () => {
      const v = inline ?? args[++i];
      if (v === undefined) {
        throw new Error(`${name} needs a value.`);
      }
      return v;
    };
    switch (name) {
      case '--manifest':
        flags.manifest = value();
        break;
      case '--output':
        flags.output = value();
        break;
      case '--yes':
        flags.yes = true;
        break;
      case '--rotate-token':
        flags.rotateToken = true;
        break;
      case '--allow-delete':
        flags.allowDelete = inline === undefined ? true : parseScopes(inline);
        break;
      case '--require-approval': {
        const v = value();
        if (v !== 'never' && v !== 'destructive' && v !== 'any-change') {
          throw new Error(`--require-approval takes never, destructive or any-change, not "${v}".`);
        }
        flags.requireApproval = v;
        break;
      }
      default:
        if (arg.startsWith('-')) {
          throw new Error(`Unknown option: ${arg}`);
        }
        flags.positional.push(arg);
    }
  }
  return flags;
}

function parseScopes(value: string): DeleteScope[] {
  const scopes = value.split(',').map((s) => s.trim());
  for (const scope of scopes) {
    if (!Object.hasOwn(DELETE_SCOPES, scope)) {
      throw new Error(`--allow-delete scope "${scope}" is not one of ${Object.keys(DELETE_SCOPES).join(', ')}.`);
    }
  }
  return scopes as DeleteScope[];
}

async function synthCommand(definition: string | undefined): Promise<number> {
  if (!definition) {
    console.error('synth needs a definition file, e.g. `cdkop synth examples/factbird.ts`.');
    return 1;
  }
  // The definition constructs an App and calls app.synth() when it loads.
  await import(pathToFileURL(resolve(definition)).href);
  stampProvenance(DEFAULT_MANIFEST, definition);
  return 0;
}

/** Record which file and commit a manifest came from, so `plan` can name them. */
function stampProvenance(manifestPath: string, source: string): void {
  let manifest: DesiredState;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    // The definition chose another outdir; nothing to stamp.
    return;
  }
  const git = gitState();
  const provenance = { source, ...git, synthesizedAt: new Date().toISOString() };
  writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, provenance }, null, 2)}\n`);
}

function gitState(): { commit?: string; dirty?: boolean } {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (head.status !== 0) {
    return {};
  }
  const status = spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
  return { commit: head.stdout.trim(), dirty: status.stdout.trim() !== '' };
}

function readManifest(path: string): DesiredState {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`No manifest at ${path}. Run \`cdkop synth <definition.ts>\` first.`);
  }
  const manifest = JSON.parse(text) as DesiredState;
  if (manifest.version !== 1) {
    throw new Error(`${path} is not a cdkop manifest this version reads (version ${String(manifest.version)}).`);
  }
  return manifest;
}

function printProvenance(desired: DesiredState): void {
  const p = desired.provenance;
  if (p) {
    const commit = p.commit ? ` at ${p.commit.slice(0, 12)}${p.dirty ? ' (uncommitted changes)' : ''}` : '';
    console.info(`Manifest from ${p.source}${commit}, synthesized ${p.synthesizedAt}.\n`);
  }
}

async function readPlan(flags: Flags, connect: Connect) {
  const desired = readManifest(flags.manifest);
  printProvenance(desired);
  const client = connect.op(desired.account.signInAddress);
  const live = await readLiveState(client, (line) => console.error(line));
  return { desired, client, live, plan: plan(desired, live) };
}

async function planCommand(flags: Flags, connect: Connect): Promise<number> {
  const { desired, plan: result } = await readPlan(flags, connect);
  const allowDelete = resolveAllowDelete(flags.allowDelete);
  console.info(
    renderPlan(desired.account.signInAddress, result, { allowDelete: (c) => deleteAllowed(c, allowDelete) }),
  );
  return 0;
}

async function applyCommand(flags: Flags, connect: Connect): Promise<number> {
  const { desired, client, live, plan: result } = await readPlan(flags, connect);
  const allowDelete = resolveAllowDelete(flags.allowDelete);
  console.info(
    renderPlan(desired.account.signInAddress, result, { allowDelete: (c) => deleteAllowed(c, allowDelete) }),
  );

  const executable = result.changes.filter((c) => deleteAllowed(c, allowDelete));
  const gated = result.changes.length - executable.length;
  if (executable.length === 0) {
    if (gated > 0) {
      console.info(`Nothing to apply without --allow-delete (${gated} revocation(s) held back).`);
    }
    return 0;
  }
  if (!flags.yes) {
    console.info(`Dry run: ${executable.length} change(s) would be applied. Re-run with --yes to apply.`);
    return 0;
  }
  if (!(await approved(executable, flags.requireApproval, connect))) {
    console.error('Not applied.');
    return 1;
  }

  const backup = writeBackup(dirname(flags.manifest), desired, live, executable);
  console.info(`Backup: ${backup.dir}`);
  const outcome = await apply(client, executable, {
    allowDelete,
    onRecord: (record) => {
      backup.journal(record);
      const mark = record.status === 'applied' ? '✓' : record.status === 'skipped' ? '·' : '✗';
      console.info(`${mark} ${describeChange(record.change)}${record.error ? `\n    ${record.error}` : ''}`);
    },
  });

  const failed = outcome.records.find((r) => r.status === 'failed');
  if (failed) {
    console.error(
      `\nStopped at a failure. ${outcome.records.filter((r) => r.status === 'applied').length} change(s) applied, ` +
        `${outcome.notAttempted.length} not attempted. Re-run plan to see where the account stands.`,
    );
    return 1;
  }
  console.info(`\nApplied ${outcome.records.length} change(s).`);
  return 0;
}

function resolveAllowDelete(value: Flags['allowDelete']): AllowDelete {
  return typeof value === 'boolean' ? value : new Set(value);
}

/**
 * Whether to go ahead. A level that asks needs a person at the terminal, and
 * refuses without one, so automation has to say `never` rather than get it by
 * accident.
 */
async function approved(executable: readonly Change[], level: RequireApproval, connect: Connect): Promise<boolean> {
  const asks = level === 'any-change' || (level === 'destructive' && executable.some(isDestructive));
  if (!asks) {
    return true;
  }
  if (!connect.interactive()) {
    console.error(
      'This apply needs approval and there is no terminal to ask. Pass --require-approval never to apply unattended.',
    );
    return false;
  }
  const revocations = executable.filter(isDestructive).length;
  const question =
    revocations > 0
      ? `Apply ${executable.length} change(s), ${revocations} of them revoking access? [y/N] `
      : `Apply ${executable.length} change(s)? [y/N] `;
  return connect.confirm(question);
}

async function importCommand(flags: Flags, connect: Connect): Promise<number> {
  const address = flags.positional[0];
  if (!address) {
    console.error('import needs the account sign-in address, e.g. `cdkop import factbird.1password.eu`.');
    return 1;
  }
  const signInAddress = normaliseSignInAddress(address);
  const live = await readLiveState(connect.op(signInAddress), (line) => console.error(line));
  const definition = importAccount(live, signInAddress);
  if (flags.output) {
    writeFileSync(flags.output, definition);
    console.error(`Wrote ${flags.output}.`);
  } else {
    process.stdout.write(definition);
  }
  return 0;
}

async function scimCommand(flags: Flags, connect: Connect): Promise<number> {
  const desired = readManifest(flags.manifest);
  if (!desired.scim) {
    console.error('The manifest declares no ScimProvisioning.');
    return 1;
  }
  const result = await setUpScimProvisioning(connect.entra(), desired.scim, {
    yes: flags.yes,
    rotateToken: flags.rotateToken,
    env: process.env,
  });
  for (const action of result.actions) {
    console.info(`  ${action}`);
  }
  for (const note of result.notes) {
    console.info(`  · ${note}`);
  }
  if (!flags.yes && result.actions.length > 0) {
    console.info('\nDry run. Re-run with --yes to apply.');
  }
  return 0;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
