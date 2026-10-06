# Reference

## Commands

| Command | Reads | Writes |
| - | - | - |
| `cdkop synth <definition.ts>` | the definition | `op.out/manifest.json`, with a `provenance` block naming the file, the git commit and whether the tree was dirty |
| `cdkop plan` | the manifest, the live account | nothing |
| `cdkop apply` | the manifest, the live account | 1Password (only with `--yes`), and a backup beside the manifest |
| `cdkop import <sign-in address>` | the live account | a definition, to stdout or `--output` |
| `cdkop scim` | the manifest, Microsoft Graph | Entra ID group assignments (only with `--yes`), the provisioning credentials (only with `--rotate-token --yes`) |

`synth` runs the definition, which must construct an `App` and call
`app.synth()`. The provenance stamp is written only to `op.out/manifest.json`.
A definition whose `App` uses another `outdir` is left unstamped.

## Options

| Option | Commands | Meaning |
| - | - | - |
| `--manifest <path>` | plan, apply, scim | Manifest to read. Default `op.out/manifest.json`. |
| `--output <path>` | import | File to write instead of stdout. |
| `--yes` | apply, scim | Execute. Without it, both stop after printing what they would do. |
| `--allow-delete[=scopes]` | plan, apply | Unlock revocations. Bare, every scope. The only scope is `grants`. `plan` uses the flag only to decide which lines it marks `(requires --allow-delete)`. |
| `--require-approval <level>` | apply | `destructive` (default) asks before a run that revokes. `any-change` asks before any run. `never` never asks. A run that would ask, with no terminal on stdin and stdout, refuses and exits 1. |
| `--rotate-token` | scim | Also write the Tenant URL and bearer token to the provisioning job. |

## Exit codes

| Code | When |
| - | - |
| 0 | The command finished, including a dry run, a plan with changes, and an apply with only held-back revocations. |
| 1 | A bad flag, a missing manifest, a plan the live account refuses (wrong account, a pinned vault not visible, two live vaults or groups with one name), a declined or impossible approval, or a failed change. |

## Authentication

| Command | Credential |
| - | - |
| plan, apply, import | The `op` session. Every call passes `--account <signInAddress>`. Set `OP_BIN` to run a different `op` binary. With `OP_SERVICE_ACCOUNT_TOKEN` set, `op` signs in as that service account, and `plan` and `apply` switch to [service-account runs](#service-account-runs). |
| scim | `AZURE_GRAPH_TOKEN`, else `az account get-access-token --resource https://graph.microsoft.com`. With `--rotate-token`, also the variable named by `tokenFrom`. |

## Constructs

### `App`

| Prop | Type | Default | |
| - | - | - | - |
| `outdir` | `string` | `"op.out"` | Directory `synth()` writes `manifest.json` to. |

### `Account`

Exactly one per definition.

| Prop | Type | |
| - | - | - |
| `signInAddress` | `string` | The account's sign-in address. Lowercased, with any `https://` and trailing `/` removed. `plan` exits 1 when the `op` session reaches another account. |

### `Vault`

Scope: the `Account`, directly.

| Prop | Type | Applied | |
| - | - | - | - |
| `name` | `string` | create, update | Defaults to the construct id. |
| `previousName` | `string` | update | Matched when no live vault carries `name`. |
| `id` | `string` | match only | Matched before any name. A pinned vault that `op` does not list fails the plan. It is never created. |
| `description` | `string` | create, update | Compared only when `op` reports a description for the live vault. |
| `icon` | `string` | create | |
| `allowAdminsToManage` | `boolean` | create | Unset leaves the account's default policy in force. |
| `owner` | `'service-account'` | match only | A run as a service account plans only vaults with this owner. A run as a person manages them once they exist, and leaves creating them, and granting access to them, to the service account. |

### `Group`

Scope: the `Account`, or another `Group`.

| Prop | Type | |
| - | - | - |
| `name` | `string` | Defaults to `externalGroup`, then to the construct id. With `externalGroup`, it must equal it. |
| `previousName` | `string` | Matched when no live group carries `name`. Not allowed with `externalGroup`. |
| `description` | `string` | Compared only when `op` reports a description for the live group. Not allowed with `externalGroup`. |
| `externalGroup` | `string` | Display name of the identity provider group this group is provisioned from. cdkop never edits its name or description and never touches its members. With a `ScimProvisioning` declared, cdkop never creates the group either, and waits for the bridge to. Without one, cdkop creates it. |
| `vaults` | `VaultGrant[]` | The group's own grants. Its effective access also includes every ancestor `Group`'s. |

`addSubGroup(id, props)` is `new Group(this, id, props)`.

Synthesis fails when a group name or previous name repeats, a name is a
built-in group (`Administrators`, `Owners`, `Recovery`, `Team Members`,
`Security`, `Provision Managers`), a grant names an undeclared vault or a
vault of another account, or one group's own list grants a vault twice.

### `ScimProvisioning`

Scope: the `Account`. At most one. Declaring it makes the SCIM bridge, not
cdkop, the creator of every `externalGroup` group.

| Prop | Type | Default | |
| - | - | - | - |
| `tenantId` | `string` | | Tenant GUID or verified domain. `scim` exits 1 when the Graph token reaches another tenant. |
| `applicationDisplayName` | `string` | | The enterprise application to configure. `scim` exits 1 when no service principal has this name. |
| `tenantUrl` | `string` | | Written as the job's `BaseAddress` by `--rotate-token`. Required for it. |
| `tokenFrom` | `string` | `"OP_SCIM_BEARER_TOKEN"` | Environment variable `--rotate-token` reads the bearer token from. |
| `groups` | `string[]` | every `externalGroup` | Entra security groups to assign to the application. |

## Grant helpers

| Helper | Grants |
| - | - |
| `view(...vaults)` | `view_items`, `view_and_copy_passwords`, `view_item_history` |
| `edit(...vaults)` | `view`, plus `create_items`, `edit_items`, `archive_items`, `delete_items`, `import_items`, `export_items`, `copy_and_share_items`, `print_items` |
| `manage(...vaults)` | `edit`, plus `manage_vault` |
| `permissions(names, ...vaults)` | `names`, broad names expanded, with every prerequisite added |

A vault is a `Vault` construct or a declared vault's name. Each helper returns
an array, so spread it into `vaults`.

### Permission prerequisites

| Permission | Requires |
| - | - |
| `view_items` | |
| `view_and_copy_passwords` | `view_items` |
| `view_item_history` | `view_and_copy_passwords`, `view_items` |
| `create_items` | `view_items` |
| `edit_items` | `view_and_copy_passwords`, `view_items` |
| `archive_items` | `edit_items`, `view_and_copy_passwords`, `view_items` |
| `delete_items` | `edit_items`, `view_and_copy_passwords`, `view_items` |
| `import_items` | `create_items`, `view_items` |
| `export_items` | `view_item_history`, `view_and_copy_passwords`, `view_items` |
| `copy_and_share_items` | `view_item_history`, `view_and_copy_passwords`, `view_items` |
| `print_items` | `view_item_history`, `view_and_copy_passwords`, `view_items` |
| `manage_vault` | |

Broad names: `allow_viewing` is the first three rows, `allow_editing` the next
eight, `allow_managing` is `manage_vault`.

## Plan lines

| Line | Change |
| - | - |
| `+ vault <name>` | create a vault |
| `~ vault <name>: <field> "<from>" -> "<to>"` | rename a vault or change its description |
| `+ group <name> (under <parent>)` | create a group |
| `~ group <name>: …` | rename a group or change its description |
| `+ <group> → <vault>: <access>` | grant access the group does not have |
| `~ <group> → <vault>: <from> -> <to>` | widen or narrow access |
| `- <group> → <vault>: <access>` | remove the group from the vault |
| `~ <group> → <vault>: <from> -> <to> (removes the group, then grants)` | set the access exactly, by removing the group and granting it again; `<from>` reads `unknown` when no record exists |

Access prints as `view`, `edit` or `manage` when it is exactly that level,
otherwise as the list of permissions. Changes run in this order: vault
creates, vault updates, group creates, group updates, grants, regrants,
revocations. Regrants appear only in service-account runs, and like
revocations they need `--allow-delete`.

Notes follow the changes. "Warning" appears when the definition declares no
`ScimProvisioning` and creates `externalGroup` groups itself, while the
account has a `Provision Managers` group, which 1Password adds when
provisioning is turned on. It names the groups and says to add each to the
provisioning integration's managed groups before its identity provider
group is assigned. "Awaiting SCIM provisioning" lists external groups
that do not exist in 1Password yet, with how many grants wait on each. "Not
declared" lists live vaults and non-built-in groups the definition does not
mention. "Skipped" lists, in a service-account run, the declared vaults it
doesn't own, and in a person's run the service-account vaults that don't exist
yet.

## Service-account runs

`op whoami` reporting `"user_type": "SERVICE_ACCOUNT"` switches `plan` and
`apply` to this mode.

| Aspect | Behaviour |
| - | - |
| Vaults | Only those declared with `owner: 'service-account'`. A missing one is created; the service account can see no other vault. |
| Groups | Must exist. A missing `externalGroup` group is awaited when `ScimProvisioning` is declared. Any other missing group fails the plan. |
| What it compares against | The applied-state record, not the account, because `op` shows a service account which groups can open a vault but not their permissions. |
| A group the vault doesn't list | Granted its declared set. |
| A recorded set narrower than declared | Granted the difference. |
| A recorded set wider than declared, or no record | Regranted: removed, then granted the declared set. |
| A group the vault lists that the definition doesn't grant | Removed, built-in groups excepted. |

The applied-state record is the Document item `cdkop-applied-state` in the
vault `cdkop state`, both created by the first service-account apply. It holds,
by vault id, the vault's name and each group's permissions as of the last
apply. An apply rewrites it with every change that landed, after the changes
run and whether or not one failed. An administrator's `plan` leaves that
vault out of "Not declared".

## Backup

`apply --yes` writes `backups/<UTC timestamp>/` next to the manifest before
the first change.

| File | Content |
| - | - |
| `live-state.json` | The account as read: session, vaults, groups, and every vault's grants by vault id. |
| `manifest.json` | The manifest applied. |
| `plan.json` | The changes about to run. |
| `journal.jsonl` | One line per change attempted: `at`, `change`, `status` (`applied`, `skipped`, `failed`), and `error` when failed. |

## `op` commands issued

| Purpose | Command |
| - | - |
| session | `op whoami` |
| read | `op vault list`, `op vault get <id>`, `op group list`, `op vault group list <vault id>` |
| vault | `op vault create <name> [--description] [--icon] [--allow-admins-to-manage=<bool>]`, `op vault edit <id> [--name] [--description]` |
| group | `op group create <name> [--description]`, `op group edit <id> [--name] [--description]` |
| access | `op vault group grant --vault <id> --group <id> --permissions <list> --no-input`, `op vault group revoke --vault <id> --group <id> --no-input [--permissions <list>]` |

Reads add `--format=json`. All add `--account`. At most four `op` processes
run at once during a read.
