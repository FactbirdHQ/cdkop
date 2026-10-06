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
  /** Document contents by vault id, then title. */
  documents?: Record<string, Record<string, string>>;
}

/** An in-memory 1Password account that records every write. */
export class FakeOp implements OpClient {
  readonly account: LiveAccount;
  readonly vaults: LiveVault[];
  readonly groups: LiveGroup[];
  readonly grants: Record<string, LiveVaultGrant[]>;
  readonly documents: Record<string, Record<string, string>>;
  readonly calls: string[] = [];
  private readonly failOn: string[];
  private next = 1;

  constructor(state: FakeOpState = {}) {
    this.account = {
      url: 'example.1password.com',
      email: 'admin@example.com',
      userId: 'U',
      accountId: 'A',
      serviceAccount: false,
      ...state.account,
    };
    this.vaults = [...(state.vaults ?? [])];
    this.groups = [...(state.groups ?? [])];
    this.grants = structuredClone(state.grants ?? {});
    this.failOn = state.failOn ?? [];
    this.documents = structuredClone(state.documents ?? {});
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
  /** Like 1Password, a service account sees which groups have access but none of their permissions. */
  async listVaultGroups(vaultId: string) {
    const grants = structuredClone(this.grants[vaultId] ?? []);
    return this.account.serviceAccount ? grants.map((g) => ({ ...g, permissions: [] })) : grants;
  }
  async readDocument(vaultId: string, title: string) {
    return this.documents[vaultId]?.[title];
  }
  async writeDocument(vaultId: string, title: string, content: string) {
    this.record(`writeDocument ${vaultId} ${title}`);
    (this.documents[vaultId] ??= {})[title] = content;
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
    if (this.account.serviceAccount && permissions !== 'all') {
      // 1Password: "the accessor doesn't have any permissions".
      throw new Error('a service account cannot revoke part of a grant');
    }
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
