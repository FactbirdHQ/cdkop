/**
 * Everything cdkop reads from and writes to 1Password, behind an interface so
 * tests can run the whole plan/apply surface against an in-memory fake.
 *
 * The default implementation drives the `op` CLI. It needs a signed-in user
 * session: a service account cannot manage groups or vault permissions.
 */
import { spawn } from 'node:child_process';

import { normaliseLivePermissions, type Permission } from '../synth/permissions.ts';

export interface LiveAccount {
  /** The sign-in address the session reaches, e.g. `example.1password.com`. */
  readonly url: string;
  readonly email: string;
  readonly userId: string;
  readonly accountId: string;
}

export interface LiveVault {
  readonly id: string;
  readonly name: string;
  /** Undefined when `op` did not report one, which is not the same as empty. */
  readonly description?: string;
  /** `USER_CREATED`, `EVERYONE`, `PERSONAL`, … when `op` reports it. */
  readonly type?: string;
}

export interface LiveGroup {
  readonly id: string;
  readonly name: string;
  /** Undefined when `op` did not report one, which is not the same as empty. */
  readonly description?: string;
  /** `ACTIVE`, `DELETED`, … */
  readonly state?: string;
  /** `USER_DEFINED` for a group someone created, when `op` reports it. */
  readonly type?: string;
}

/** One group's direct access to one vault. */
export interface LiveVaultGrant {
  readonly groupId: string;
  readonly groupName: string;
  /** Closed and granular, whatever mix of broad and granular names `op` printed. */
  readonly permissions: Permission[];
}

export interface CreateVaultParams {
  readonly name: string;
  readonly description?: string;
  readonly icon?: string;
  readonly allowAdminsToManage?: boolean;
}

export interface EditParams {
  readonly name?: string;
  readonly description?: string;
}

export interface OpClient {
  whoami(): Promise<LiveAccount>;
  /** Every shared vault the session can see. Personal vaults are left out. */
  listVaults(): Promise<LiveVault[]>;
  listGroups(): Promise<LiveGroup[]>;
  listVaultGroups(vaultId: string): Promise<LiveVaultGrant[]>;
  createVault(params: CreateVaultParams): Promise<LiveVault>;
  editVault(id: string, params: EditParams): Promise<void>;
  createGroup(name: string, description?: string): Promise<LiveGroup>;
  editGroup(id: string, params: EditParams): Promise<void>;
  /** Add permissions to a group's access to a vault, creating the access when it has none. */
  grant(vaultId: string, groupId: string, permissions: readonly Permission[]): Promise<void>;
  /** Take permissions away; `'all'` removes the group from the vault. */
  revoke(vaultId: string, groupId: string, permissions: readonly Permission[] | 'all'): Promise<void>;
}

/** Runs `op` with the given arguments and resolves to its stdout. */
export type OpRunner = (args: readonly string[]) => Promise<string>;

/**
 * Spawn the `op` binary (or `$OP_BIN`). The arguments go straight to the
 * process with no shell in between, so a vault or group name is never parsed
 * as anything but one argument.
 */
export function spawnOp(bin: string = process.env.OP_BIN ?? 'op'): OpRunner {
  return (args) =>
    new Promise((resolve, reject) => {
      const child = spawn(bin, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.on('error', (error) => reject(new Error(`Could not run ${bin}: ${error.message}`)));
      child.on('close', (code) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`op ${args.join(' ')} exited ${code}: ${stderr.trim() || 'no output'}`));
        }
      });
    });
}

/** At most this many `op` processes run at once during a read. */
const READ_CONCURRENCY = 4;

export class CliOpClient implements OpClient {
  private readonly run: OpRunner;
  private readonly account: string;

  constructor(account: string, run: OpRunner = spawnOp()) {
    this.account = account;
    this.run = run;
  }

  private async json<T>(args: readonly string[]): Promise<T> {
    const out = await this.run([...args, '--format=json', '--account', this.account]);
    return (out.trim() === '' ? [] : JSON.parse(out)) as T;
  }

  private async exec(args: readonly string[]): Promise<void> {
    await this.run([...args, '--account', this.account]);
  }

  async whoami(): Promise<LiveAccount> {
    const me = await this.json<{ url?: string; email?: string; user_uuid?: string; account_uuid?: string }>(['whoami']);
    return {
      url: me.url ?? '',
      email: me.email ?? '',
      userId: me.user_uuid ?? '',
      accountId: me.account_uuid ?? '',
    };
  }

  async listVaults(): Promise<LiveVault[]> {
    const listed = await this.json<RawVault[]>(['vault', 'list']);
    const vaults = await mapLimit(listed, READ_CONCURRENCY, (v) => this.json<RawVault>(['vault', 'get', v.id]));
    return vaults.map(toLiveVault).filter((v) => v.type !== 'PERSONAL');
  }

  async listGroups(): Promise<LiveGroup[]> {
    const groups = await this.json<RawGroup[]>(['group', 'list']);
    return groups.map(toLiveGroup);
  }

  async listVaultGroups(vaultId: string): Promise<LiveVaultGrant[]> {
    const grants = await this.json<Array<RawGroup & { permissions?: string[] }>>(['vault', 'group', 'list', vaultId]);
    return grants.map((g) => ({
      groupId: g.id,
      groupName: g.name,
      permissions: normaliseLivePermissions(g.permissions ?? []),
    }));
  }

  async createVault(params: CreateVaultParams): Promise<LiveVault> {
    const args = ['vault', 'create', params.name];
    if (params.description !== undefined) {
      args.push('--description', params.description);
    }
    if (params.icon !== undefined) {
      args.push('--icon', params.icon);
    }
    if (params.allowAdminsToManage !== undefined) {
      args.push(`--allow-admins-to-manage=${params.allowAdminsToManage}`);
    }
    return toLiveVault(await this.json<RawVault>(args));
  }

  async editVault(id: string, params: EditParams): Promise<void> {
    await this.exec(['vault', 'edit', id, ...editFlags(params)]);
  }

  async createGroup(name: string, description?: string): Promise<LiveGroup> {
    const args = ['group', 'create', name];
    if (description !== undefined) {
      args.push('--description', description);
    }
    return toLiveGroup(await this.json<RawGroup>(args));
  }

  async editGroup(id: string, params: EditParams): Promise<void> {
    await this.exec(['group', 'edit', id, ...editFlags(params)]);
  }

  async grant(vaultId: string, groupId: string, permissions: readonly Permission[]): Promise<void> {
    await this.exec([
      'vault',
      'group',
      'grant',
      '--vault',
      vaultId,
      '--group',
      groupId,
      '--permissions',
      permissions.join(','),
      '--no-input',
    ]);
  }

  async revoke(vaultId: string, groupId: string, permissions: readonly Permission[] | 'all'): Promise<void> {
    const args = ['vault', 'group', 'revoke', '--vault', vaultId, '--group', groupId, '--no-input'];
    if (permissions !== 'all') {
      args.push('--permissions', permissions.join(','));
    }
    await this.exec(args);
  }
}

interface RawVault {
  id: string;
  name: string;
  description?: string;
  type?: string;
}

interface RawGroup {
  id: string;
  name: string;
  description?: string;
  state?: string;
  type?: string;
}

function toLiveVault(v: RawVault): LiveVault {
  return {
    id: v.id,
    name: v.name,
    ...(v.description === undefined ? {} : { description: v.description }),
    ...(v.type === undefined ? {} : { type: v.type }),
  };
}

function toLiveGroup(g: RawGroup): LiveGroup {
  return {
    id: g.id,
    name: g.name,
    ...(g.description === undefined ? {} : { description: g.description }),
    ...(g.state === undefined ? {} : { state: g.state }),
    ...(g.type === undefined ? {} : { type: g.type }),
  };
}

function editFlags(params: EditParams): string[] {
  const flags: string[] = [];
  if (params.name !== undefined) {
    flags.push('--name', params.name);
  }
  if (params.description !== undefined) {
    flags.push('--description', params.description);
  }
  return flags;
}

/** `Promise.all` over `items` with at most `limit` in flight, results in input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
