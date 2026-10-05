/**
 * A sample definition: two vaults, a nested group tree provisioned from Entra
 * ID, and the provisioning application that pushes those groups.
 *
 * `bun src/bin/cdkop.ts synth examples/factbird.ts` writes op.out/manifest.json.
 */
import { Account, App, edit, Group, manage, ScimProvisioning, Vault, view } from '../src/index.ts';

const app = new App();
const account = new Account(app, 'factbird', { signInAddress: 'factbird.1password.eu' });

const shared = new Vault(account, 'Shared', { description: 'Credentials everyone at Factbird uses' });
const infrastructure = new Vault(account, 'Infrastructure', { description: 'Cloud and CI credentials' });

const engineering = new Group(account, 'engineering', {
  externalGroup: 'SG_Factbird_Department_Engineering',
  vaults: [...view(shared)],
});

// Inherits Engineering's view of Shared, and adds its own access.
new Group(engineering, 'devops', {
  externalGroup: 'SG_Factbird_Department_DevOps',
  vaults: [...manage(infrastructure)],
});

new Group(account, 'it', {
  name: 'IT',
  description: 'Runs the 1Password account',
  vaults: [...edit(shared)],
});

new ScimProvisioning(account, 'entra', {
  tenantId: 'factbird.com',
  applicationDisplayName: '1Password Business',
  tenantUrl: 'https://1password.scim.factbird.com',
});

app.synth();
