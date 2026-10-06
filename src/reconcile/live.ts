import {
  type LiveAccount,
  type LiveGroup,
  type LiveVault,
  type LiveVaultGrant,
  mapLimit,
  type OpClient,
} from '../op/client.ts';

/** The account as one read saw it. */
export interface LiveState {
  readonly account: LiveAccount;
  readonly vaults: LiveVault[];
  /** Every group that has not been deleted, built-in ones included. */
  readonly groups: LiveGroup[];
  /** Each visible vault's direct group grants, keyed by vault id. */
  readonly grants: Readonly<Record<string, LiveVaultGrant[]>>;
}

/** At most this many vaults have their grants read at once. */
const GRANT_CONCURRENCY = 4;

/**
 * Read the account: who the session is, every shared vault it can see, every
 * group, and every vault's group grants. One `op` call per vault for its
 * details and one for its grants, so a read takes a few seconds per dozen
 * vaults.
 */
export async function readLiveState(client: OpClient, progress: (line: string) => void = () => {}): Promise<LiveState> {
  const [account, vaults, groups] = await Promise.all([client.whoami(), client.listVaults(), client.listGroups()]);
  progress(`Read ${count(vaults.length, 'vault')} and ${count(groups.length, 'group')}; reading vault access...`);
  const perVault = await mapLimit(vaults, GRANT_CONCURRENCY, (v) => client.listVaultGroups(v.id));
  return {
    account,
    vaults,
    groups: groups.filter((g) => g.state !== 'DELETED'),
    grants: Object.fromEntries(vaults.map((v, i) => [v.id, perVault[i]!])),
  };
}

/** `1 vault`, `2 vaults`. */
function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}
