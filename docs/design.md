# Design notes

## Why the `op` CLI

Connect servers and service accounts read and write items, the Events API
is read-only, and the SCIM bridge takes users and groups from an IdP. None of
them can create a vault for a group or set its permissions. The `op` CLI,
signed in as a person, can. That decides a lot. cdkop runs where a person can
sign in, not in CI, and every read costs a process spawn, which is why a read
runs four at a time.

The client sits behind an interface. The tests drive the planner and applier
against an in-memory account, and a test checks the arguments `CliOpClient`
builds. Nothing in the suite touches a real account.

## Who owns what

Entra ID owns people. The SCIM bridge creates users, suspends leavers and
fills the groups Entra pushes. cdkop owns the shape around them: which shared
vaults exist, which groups exist beside the provisioned ones, and which group
reaches which vault at which permissions.

A declared group owns all of its vault access. That includes access to vaults
the definition never mentions, because a group's reach is the thing worth
reviewing, and half of it in code is worse than none. An undeclared group is
left alone completely. That is the way to keep a group out of cdkop's hands,
and it means an empty definition revokes nothing.

The built-in groups (Owners, Administrators and the rest) can't be declared.
Their access comes from 1Password's own rules, mostly through each vault's
"allow administrators to manage" setting. Treating them like ordinary grants
would invite a plan that locks the administrators out.

## Nothing gets deleted

Deleting a vault deletes its items. Deleting a group a provisioned user relies
on takes their access mid-shift. Neither comes back with an `op` call. So
cdkop has no delete. The client interface has no such method, and
`test/never-deletes.test.ts` fails the build if a source file ever passes
`delete`, `remove` or `rm` to `op`. Retiring a vault or a group is a decision
made in the 1Password console by someone who has looked inside it.

Revoking access is the only destructive change. It needs `--allow-delete`,
and by default a prompt. Revoking is cheap to undo: the backup holds the grant
as it was, and `op vault group grant` restores it.

## Nested groups are a definition-only idea

GitHub teams nest, and a child team inherits its parent's repositories. The
team tree this tool is meant to mirror relies on that. 1Password groups are
flat. Synthesis bridges the gap by giving every group its ancestors' grants
directly, merged so the wider set wins. The tree lives in the definition and
in the plan output. In 1Password, a child group holds the full union, and
removing a grant from a parent shows up as revocations on each child.

The alternative was making a child's members also members of the parent. That
would need cdkop to own rosters, and rosters belong to Entra.

## Permission sets are closed

1Password rejects a grant whose prerequisites are missing, and a revoke can
take dependants down with it. cdkop expands every set it handles, declared or
live, to granular names closed under the prerequisite table. Two closed sets
compare by equality. Granting the difference between them or revoking it
leaves a closed set behind, so no partial grant or revoke trips over
dependencies.

`op` may report permissions this version has never heard of. The live reader
drops them instead of failing, so a new 1Password permission shows as
unmanaged rather than breaking every plan. cdkop targets 1Password Business
only. The Teams plan has just the three broad permissions, and SCIM
provisioning needs Business anyway.

## Invisible vaults and pinned ids

`op vault list` shows only the vaults the signed-in person can reach. A vault
the administrators can't manage looks absent, and a definition naming it
would propose creating a second vault with the same name. Pinning `id` closes
that hole. A pinned vault is matched by id or fails the plan, and it is never
created. `import` pins every vault it writes.

Two live vaults or groups with the same name also fail the plan. Guessing
would grant access to the wrong one.

## SCIM, split in two

The SCIM bridge is infrastructure, deployed wherever you host it, with a
`scimsession` credential that lives outside git. cdkop leaves it alone.
`ScimProvisioning` declares the Entra half, meaning which security groups
the enterprise application pushes, and `cdkop scim` reconciles that over
Microsoft Graph.

`cdkop scim` only adds. It creates no application and no provisioning job,
because provisioning already runs and a second job aimed at the same bridge
would fight the first. It assigns missing groups, reports extra ones, and
writes credentials only on `--rotate-token`, since a bad token stops
provisioning for everyone. Two settings stay manual because 1Password exposes
no API for them: turning provisioning on, and whether the IdP manages
provisioned groups' memberships.

A group's `externalGroup` does two jobs. It names the Entra group `scim`
assigns, and it names the 1Password group the bridge creates, which takes the
Entra display name. Keeping both in one prop stops the two names drifting.
Who creates the group depends on whether the definition declares
`ScimProvisioning`. With it, the bridge does, and the grants wait until the
group appears, because a group cdkop made alongside would race the bridge
for the name. Without it, there is no bridge to wait for, so cdkop creates
the group under the identity provider's name. When provisioning arrives
later, the existing group is added to the provisioning integration's managed
groups in the 1Password console, and the integration takes ownership: from
then on a rename or a membership change has to come from the identity
provider. The group keeps its vault access, which is still cdkop's. The
order matters, because 1Password's setup guide warns that a group missing
from the managed list can end up duplicated, so the group joins the list
before its identity provider group is assigned to the application. Nothing
documents releasing a group again short of turning provisioning off, so the
handover counts as one-way.

1Password has no API for the managed list, so cdkop can't see whether a
group is on it. The only signal it has is the `Provision Managers` group
1Password adds when provisioning is turned on, and `plan` warns, with that
order, when it sees that group while creating external groups itself.

The Graph client is a trimmed copy of cdkgithub's. The two tools share a
tenant but no code, and a shared package for about two hundred lines did not
seem worth it yet.

## CI, and why a service account owns only its own vaults

The flow worth having is a pull request that asks for a vault, review, and
CI applying it after merge. CI can only sign in to 1Password as a service
account, and a service account is a narrow thing. Four runs against a live
account settled what it can do, recorded in
https://github.com/FactbirdHQ/cdkop/issues/2:

- It sees only the vaults it created. An administrator can't hand it one;
  `op vault user grant` naming a service account is rejected.
- On its own vaults it can grant a group and remove one outright, but
  `op` shows it no permissions, and revoking part of a grant fails.
- It can read every item in a vault it created. That access appears in no
  listing, and an administrator can't revoke it.

So a service-account run manages only vaults declared as its own, and since
it can't read levels it compares against a record of what its applies did,
kept in 1Password beside the vaults. The record changes only for changes
that landed. A diff between two commits would have been simpler, but after a
failed apply it would forget a narrowing that never happened.

Narrowing is a regrant: remove the group, grant the smaller set. The group
loses access to that vault for the moment between the two calls.

The last point is the price. The CI token can read the secrets in every vault
CI creates, permanently. What contains it is outside cdkop: the token sits in
a CI environment only the post-merge job can reach, and since cdkop never
reads an item, any item read by the service account is an alarm.

A run as a person still manages everything, CI's vaults included, because
Owners and Administrators get `manage_vault` on every vault the service
account creates. That run sees permissions, so it is also where drift in
CI's vaults gets noticed.

## What the live account confirmed

The `op` output this code parses was checked against a live account:

- `op vault get` reports `type` and `description`.
- `op group list` reports no `type`, so the built-in groups are recognised by
  name. `op group get` reports it. Both leave out an empty `description`.
- `op vault group list` reports `permissions` as granular names to a person,
  and leaves them out for a service account.
- Revoking part of a grant works for a person.
- The bridge names a provisioned group after the Entra group's display name.
- `op whoami` reports `user_type` only for a service account.
