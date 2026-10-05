import { describe, expect, test } from 'bun:test';

import type { EntraClient, EntraServicePrincipal } from '../src/entra/graph.ts';
import { setUpScimProvisioning } from '../src/entra/scim-setup.ts';
import type { ScimProvisioningManifest } from '../src/synth/manifest.ts';

class FakeEntra implements EntraClient {
  readonly writes: string[] = [];
  constructor(
    private readonly groups: Record<string, string>,
    private readonly assigned: string[] = [],
    private readonly app: EntraServicePrincipal | null = { id: 'sp', appId: 'app', appRoles: [] },
  ) {}
  async describeTenant() {
    return { id: 'tenant-guid', domains: ['contoso.onmicrosoft.com'] };
  }
  async findServicePrincipal() {
    return this.app ?? undefined;
  }
  async listSynchronizationJobs() {
    return [{ id: 'job', state: 'Active' }];
  }
  async setSynchronizationSecrets(_sp: string, url: string) {
    this.writes.push(`secrets ${url}`);
  }
  async findGroupId(name: string) {
    return this.groups[name];
  }
  async listAssignedGroups() {
    return this.assigned.map((id) => ({
      groupId: id,
      displayName: Object.keys(this.groups).find((k) => this.groups[k] === id) ?? id,
    }));
  }
  async assignGroup(_sp: EntraServicePrincipal, groupId: string) {
    this.writes.push(`assign ${groupId}`);
  }
}

const manifest: ScimProvisioningManifest = {
  tenantId: 'contoso.onmicrosoft.com',
  applicationDisplayName: '1Password Business',
  tenantUrl: 'https://scim.example.com',
  tokenFrom: 'OP_SCIM_BEARER_TOKEN',
  groups: ['SG-Engineering', 'SG-Sales'],
};
const groups = { 'SG-Engineering': 'e', 'SG-Sales': 's', SG_Other: 'o' };
const options = { yes: true, rotateToken: false, env: {} };

describe('setUpScimProvisioning', () => {
  test('assigns what is missing and reports what it did not declare', async () => {
    const entra = new FakeEntra(groups, ['e', 'o']);
    const result = await setUpScimProvisioning(entra, manifest, options);
    expect(entra.writes).toEqual(['assign s']);
    expect(result.notes).toContain('"SG_Other" is assigned to "1Password Business" but not declared (left alone).');
  });

  test('a dry run writes nothing', async () => {
    const entra = new FakeEntra(groups);
    const result = await setUpScimProvisioning(entra, manifest, { ...options, yes: false });
    expect(entra.writes).toEqual([]);
    expect(result.actions).toHaveLength(2);
  });

  test('refuses the wrong tenant, a missing app, or a missing group before any write', async () => {
    await expect(
      setUpScimProvisioning(new FakeEntra(groups), { ...manifest, tenantId: 'other.com' }, options),
    ).rejects.toThrow('reaches tenant tenant-guid');
    await expect(setUpScimProvisioning(new FakeEntra(groups, [], null), manifest, options)).rejects.toThrow(
      'No enterprise application is named',
    );
    const entra = new FakeEntra({ 'SG-Sales': 's' });
    await expect(setUpScimProvisioning(entra, manifest, options)).rejects.toThrow('"SG-Engineering"');
    expect(entra.writes).toEqual([]);
  });

  test('leaves the credentials alone unless asked to rotate, and then needs the token', async () => {
    const entra = new FakeEntra(groups, ['e', 's']);
    await setUpScimProvisioning(entra, manifest, options);
    expect(entra.writes).toEqual([]);

    await expect(setUpScimProvisioning(entra, manifest, { ...options, rotateToken: true })).rejects.toThrow(
      '$OP_SCIM_BEARER_TOKEN, which is unset',
    );
    await setUpScimProvisioning(entra, manifest, { ...options, rotateToken: true, env: { OP_SCIM_BEARER_TOKEN: 't' } });
    expect(entra.writes).toEqual(['secrets https://scim.example.com']);
  });
});
