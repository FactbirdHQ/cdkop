import type {
  CreateVaultParams,
  EditParams,
  LiveAccount,
  LiveGroup,
  LiveVault,
  LiveVaultGrant,
  OpClient,
} from '../src/op/client.ts';
import { closePermissions, type Permission } from '../src/synth/permissions.ts';

export interface FakeOpState {
  account?: Partial<LiveAccount>;
  vaults?: LiveVault[];
  groups?: LiveGroup[];
  /** Grants by vault id. */
  grants?: Record<string, LiveVaultGrant[]>;
  /** Calls whose name starts with one of these throw. */
  failOn?: string[];
}

/** An in-memory 1Password account that records every write. */
export class FakeOp implements OpClient {
  readonly account: LiveAccount;
  readonly vaults: LiveVault[];
  readonly groups: LiveGroup[];
  readonly grants: Record<string, LiveVaultGrant[]>;
  readonly calls: string[] = [];
  private readonly failOn: string[];
  private next = 1;

  constructor(state: FakeOpState = {}) {
    this.account = {
      url: 'factbird.1password.eu',
      email: 'admin@factbird.com',
      userId: 'U',
      accountId: 'A',
      ...state.account,
    };
    this.vaults = [...(state.vaults ?? [])];
    this.groups = [...(state.groups ?? [])];
    this.grants = structuredClone(state.grants ?? {});
    this.failOn = state.failOn ?? [];
  }

  private record(call: string): void {
    this.calls.push(call);
    if (this.failOn.some((f) => call.startsWith(f))) {
      throw new Error(`fake failure: ${call}`);
    }
  }

  async whoami() {
    return this.account;
  }
  async listVaults() {
    return [...this.vaults];
  }
  async listGroups() {
    return [...this.groups];
  }
  async listVaultGroups(vaultId: string) {
    return structuredClone(this.grants[vaultId] ?? []);
  }
  async createVault(params: CreateVaultParams) {
    this.record(`createVault ${params.name}`);
    const vault = { id: `v${this.next++}`, name: params.name, description: params.description ?? '' };
    this.vaults.push(vault);
    return vault;
  }
  async editVault(id: string, params: EditParams) {
    this.record(`editVault ${id} ${JSON.stringify(params)}`);
  }
  async createGroup(name: string, description?: string) {
    this.record(`createGroup ${name}`);
    const group = { id: `g${this.next++}`, name, description: description ?? '', type: 'USER_DEFINED' };
    this.groups.push(group);
    return group;
  }
  async editGroup(id: string, params: EditParams) {
    this.record(`editGroup ${id} ${JSON.stringify(params)}`);
  }
  async grant(vaultId: string, groupId: string, permissions: readonly Permission[]) {
    this.record(`grant ${vaultId} ${groupId} ${permissions.join(',')}`);
    const list = (this.grants[vaultId] ??= []);
    const i = list.findIndex((g) => g.groupId === groupId);
    if (i >= 0) {
      list[i] = { ...list[i]!, permissions: closePermissions([...list[i]!.permissions, ...permissions]) };
    } else {
      const name = this.groups.find((g) => g.id === groupId)?.name ?? groupId;
      list.push({ groupId, groupName: name, permissions: closePermissions(permissions) });
    }
  }
  async revoke(vaultId: string, groupId: string, permissions: readonly Permission[] | 'all') {
    this.record(`revoke ${vaultId} ${groupId} ${permissions === 'all' ? 'all' : permissions.join(',')}`);
    const list = this.grants[vaultId] ?? [];
    const i = list.findIndex((g) => g.groupId === groupId);
    if (i < 0) {
      return;
    }
    if (permissions === 'all') {
      list.splice(i, 1);
    } else {
      list[i] = { ...list[i]!, permissions: list[i]!.permissions.filter((p) => !permissions.includes(p)) };
    }
  }
}
