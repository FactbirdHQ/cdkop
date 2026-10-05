# How-to guides

Each guide assumes a working definition, a signed-in `op` session for the
account it declares, and `bun src/bin/cdkop.ts` (or `cdkop` when installed)
on hand. Run `synth` after every edit to the definition, before `plan` or
`apply`.

## Adopt an existing account

1. Print a definition of what the account holds now:

   ```bash
   cdkop import example.1password.com --output account.ts
   ```

   You get every shared vault the session can see, each pinned by `id`, and
   every group someone created, with its description and vault access. The
   built-in groups are left out.

2. Format it with `treefmt` or your editor.

3. Change each group the SCIM bridge provisioned from a description to an
   `externalGroup` naming its Entra group. The import cannot tell those
   groups apart from groups someone created by hand.

4. Synthesize and plan. The plan should hold no changes. A change here means
   the import missed something, so fix the definition before applying
   anything.

Sign in as someone in the Administrators group before you import. `op` lists
only the vaults the session can reach, so a vault the administrators cannot
manage is missing from the import and from every later plan. Pinning a vault's
`id` turns that blind spot into an error instead of a duplicate vault.

## Give a group access to a vault

Add a grant to the group's `vaults`:

```ts
new Group(account, 'it', {
  name: 'IT',
  vaults: [...edit(shared), ...view('Finance')],
});
```

Use `view`, `edit` or `manage` for the three levels. For anything between
them, use `permissions`:

```ts
vaults: [...permissions(['view_items', 'create_items'], 'Onboarding')]
```

cdkop adds each permission's prerequisites for you. A vault named by string
must still be declared with `new Vault`.

## Take access away

Remove the grant, or narrow it, then:

```bash
cdkop apply --yes --allow-delete=grants
```

The run stops for a "y" before revoking. In CI or another unattended run, add
`--require-approval never`.

A declared group loses access to any vault its `vaults` list does not name,
including vaults the definition does not declare. To leave a group's access
alone entirely, do not declare the group.

## Mirror a team tree in nested groups

Scope a group under another group. The child gets every grant of its
ancestors plus its own:

```ts
const engineering = new Group(account, 'engineering', {
  externalGroup: 'SG-Engineering',
  vaults: [...view(shared)],
});

new Group(engineering, 'devops', {
  externalGroup: 'SG-DevOps',
  vaults: [...manage(infrastructure)],
});
```

1Password has no nested groups, so each group is granted its full access
directly. `plan` shows the parent in brackets when it creates a group.

## Add a group provisioned from Entra ID

1. Create the security group in Entra ID and give it members.
2. Declare the group with `externalGroup` set to the Entra group's display
   name, and give it vault access.
3. Assign the group to the provisioning application:

   ```bash
   cdkop scim            # dry run: lists the groups it would assign
   cdkop scim --yes
   ```

4. Wait for the next provisioning cycle. Until the group shows up in
   1Password, `plan` lists it under "Awaiting SCIM provisioning" and holds
   its grants back.
5. Run `cdkop apply --yes` to grant the access.

These steps need `ScimProvisioning` in the definition. Without it, cdkop
creates the group in step 2's apply instead of waiting for the bridge.

## Use identity provider group names before provisioning is set up

1. Declare each group with `externalGroup` set to the name its identity
   provider group has, or will have. Leave `ScimProvisioning` out.
2. Run `cdkop apply --yes`. cdkop creates the groups and grants their
   access. Add members in the 1Password console.
3. When provisioning is set up, add each group to the provisioning
   integration's managed groups in the 1Password console, so the bridge
   takes over its members.
4. Declare `ScimProvisioning` and run `cdkop scim --yes`. The groups
   already exist, so `plan` has nothing to wait for.

## Rotate the SCIM bridge token

1. Generate a new bearer token in 1Password's provisioning settings.
2. Export it in the variable the definition names (`OP_SCIM_BEARER_TOKEN`
   unless `tokenFrom` says otherwise).
3. Run:

   ```bash
   cdkop scim --rotate-token --yes
   ```

`ScimProvisioning` must declare `tenantUrl`. Run with `--rotate-token` only
when you mean it, because a wrong token stops provisioning for everyone.

## Rename a vault or a group

Set the new `name` and keep the old one in `previousName`:

```ts
new Vault(account, 'infrastructure', { name: 'Cloud', previousName: 'Infrastructure' });
```

`plan` shows a rename instead of a new vault. After the apply, delete the
`previousName` line whenever you like. Groups provisioned from Entra ID are
renamed in Entra ID.

## Recover after a failed apply

`apply` stops at the first failed change. It prints how many changes landed
and how many it never tried.

1. Run `cdkop plan`. The plan starts from where the account stands now, so it
   lists only what is still to do.
2. To see exactly what ran, read `journal.jsonl` in the backup directory the
   apply printed.
3. To put access back the way it was, read the grant for that vault and group
   in the backup's `live-state.json` and restore it with
   `op vault group grant`.
