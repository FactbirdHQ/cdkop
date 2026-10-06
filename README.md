# cdkop

**Declare a 1Password account's vaults and who can reach them in TypeScript.
Review the change in a pull request. Apply it from a plan you have read.**

![cdkop synthesizing a definition, reading the account, printing the plan, asking before it revokes access, and applying each change](docs/demo/cdkop.gif)

cdkop keeps shared vaults, groups and every group's vault permissions in one
definition in git. It reads the live account through the `op` CLI, prints the
difference, and applies it with `op`. Groups that Entra ID provisions through
SCIM are declared by their Entra name. cdkop grants them vault access and
leaves their members to Entra, and `cdkop scim` assigns those Entra groups to
the provisioning application. It is built on
[`constructs`](https://www.npmjs.com/package/constructs), the library under
the AWS CDK, and works the way [cdkgithub](https://github.com/FactbirdHQ/cdkgithub)
does: `synth`, then `plan`, then `apply`.

```ts
const account = new Account(app, 'example', { signInAddress: 'example.1password.com' });

const shared = new Vault(account, 'Shared');
const infrastructure = new Vault(account, 'Infrastructure');

const engineering = new Group(account, 'engineering', {
  externalGroup: 'SG-Engineering', // members come from Entra ID
  vaults: [...view(shared)],
});

new Group(engineering, 'devops', { // inherits Engineering's access
  externalGroup: 'SG-DevOps',
  vaults: [...manage(infrastructure)],
});
```

```
Plan for 1Password account "example.1password.com":

  + vault Infrastructure
  + SG-DevOps → Infrastructure: manage
  ~ IT → Shared: manage -> edit   (requires --allow-delete)
```

What it will and will not do:

- `apply` writes nothing without `--yes`. With it, the run still stops for an
  interactive "y" before it revokes anyone's access.
- Taking access away needs `--allow-delete`. Without it, revocations are
  printed and held back.
- No code path deletes a vault or a group, and a test fails the build if one
  appears. Deleting a vault deletes its items.
- Every apply that writes saves the live state it read first, so any access it
  changed can be put back.
- cdkop never adds or removes people. Entra ID owns users and the rosters of
  the groups it provisions.

New here? Start with [Getting started](#getting-started). Looking for a task?
See the [how-to guides](docs/how-to.md). Need a flag or a prop? See the
[reference](docs/reference.md). Wondering why it works this way? Read the
[design notes](docs/design.md).

## Getting started

This walkthrough takes you from a fresh checkout to one new vault that one new
group can edit. Nothing before the last step writes to 1Password.

You need [Bun](https://bun.sh), the
[1Password CLI](https://developer.1password.com/docs/cli/) and an owner or
administrator login to a 1Password Business account. With
[devenv](https://devenv.sh), `devenv shell` provides Bun and `op`.

1. Install dependencies and sign in:

   ```bash
   bun install
   op signin
   ```

2. Find your account's sign-in address. It is the `URL` column of:

   ```bash
   op account list
   ```

3. Create `examples/my-account.ts`, replacing `my-team.1password.com` with
   that address:

   ```ts
   import { Account, App, edit, Group, Vault } from '../src/index.ts';

   const app = new App();
   const account = new Account(app, 'mine', { signInAddress: 'my-team.1password.com' });

   const sandbox = new Vault(account, 'cdkop sandbox', {
     description: 'Created by the cdkop walkthrough',
   });

   new Group(account, 'sandbox-editors', {
     name: 'cdkop sandbox editors',
     vaults: [...edit(sandbox)],
   });

   app.synth();
   ```

4. Synthesize the manifest:

   ```bash
   bun src/bin/cdkop.ts synth examples/my-account.ts
   ```

   This writes `op.out/manifest.json` and prints nothing.

5. Compare it with the live account:

   ```bash
   bun src/bin/cdkop.ts plan
   ```

   You should see three lines: `+ vault cdkop sandbox`,
   `+ group cdkop sandbox editors`, and
   `+ cdkop sandbox editors → cdkop sandbox: edit`. Below them, under
   "Not declared", sits every vault and group the account already has. cdkop
   leaves all of those alone.

6. Apply:

   ```bash
   bun src/bin/cdkop.ts apply --yes
   ```

   The plan prints again, then the backup directory, then a check mark per
   change. Run `bun src/bin/cdkop.ts plan` once more. It now reports no
   changes.

7. Commit `examples/my-account.ts`. From now on, a change to that vault's
   access starts as an edit to this file.

To adopt the vaults and groups you already have, follow
[Adopt an existing account](docs/how-to.md#adopt-an-existing-account).

## License

[Apache License 2.0](LICENSE).
