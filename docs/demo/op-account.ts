/**
 * The definition the README recording synthesizes, plans and applies.
 * It mirrors the README's example.
 */
import { Account, App, edit, Group, manage, ScimProvisioning, Vault, view } from '../../src/index.ts';

const app = new App();
const account = new Account(app, 'example', { signInAddress: 'example.1password.com' });

const shared = new Vault(account, 'Shared');
const infrastructure = new Vault(account, 'Infrastructure');

const engineering = new Group(account, 'engineering', {
  externalGroup: 'SG-Engineering',
  vaults: [...view(shared)],
});

new Group(engineering, 'devops', {
  externalGroup: 'SG-DevOps',
  vaults: [...manage(infrastructure)],
});

new Group(account, 'it', { name: 'IT', vaults: [...edit(shared)] });

new ScimProvisioning(account, 'entra', {
  tenantId: 'contoso.onmicrosoft.com',
  applicationDisplayName: '1Password Business',
});

app.synth();
