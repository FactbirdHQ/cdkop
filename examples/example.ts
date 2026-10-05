/**
 * A sample definition: two vaults, a nested group tree provisioned from Entra
 * ID, and the provisioning application that pushes those groups.
 *
 * `bun src/bin/cdkop.ts synth examples/example.ts` writes op.out/manifest.json.
 */
import { Account, App, edit, Group, manage, ScimProvisioning, Vault, view } from '../src/index.ts';

const app = new App();
const account = new Account(app, 'example', { signInAddress: 'example.1password.com' });

const shared = new Vault(account, 'Shared', { description: 'Credentials the whole company uses' });
const infrastructure = new Vault(account, 'Infrastructure', { description: 'Cloud and CI credentials' });

const engineering = new Group(account, 'engineering', {
  externalGroup: 'SG-Engineering',
  vaults: [...view(shared)],
});

// Inherits Engineering's view of Shared, and adds its own access.
new Group(engineering, 'devops', {
  externalGroup: 'SG-DevOps',
  vaults: [...manage(infrastructure)],
});

new Group(account, 'it', {
  name: 'IT',
  description: 'Runs the 1Password account',
  vaults: [...edit(shared)],
});

new ScimProvisioning(account, 'entra', {
  tenantId: 'contoso.onmicrosoft.com',
  applicationDisplayName: '1Password Business',
  tenantUrl: 'https://scim.example.com',
});

app.synth();
