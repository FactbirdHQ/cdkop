import type { ScimProvisioningManifest } from '../synth/manifest.ts';
import type { EntraClient } from './graph.ts';

export interface ScimSetupOptions {
  /** Execute the actions. Without it, the run reads, reports, and stops. */
  readonly yes: boolean;
  /** Also rewrite the job's Tenant URL and bearer token from the environment. */
  readonly rotateToken: boolean;
  /** Where the bearer token is read from, keyed by `tokenFrom`. */
  readonly env: Record<string, string | undefined>;
}

export interface ScimSetupResult {
  /** What was done, or what `--yes` would do. */
  readonly actions: string[];
  /** Facts that need no action. */
  readonly notes: string[];
}

/**
 * Bring the Entra side of 1Password provisioning in line with the declaration:
 * every declared security group is assigned to the enterprise application.
 *
 * Everything is read first (the tenant, the application, its job, its
 * assignments, every group id, and the token when rotating), and anything that
 * would make the run fail does so before the first write, so a typo in a group
 * name never leaves half the groups assigned.
 *
 * Ensure-only. It creates no application and no job, because provisioning
 * already exists and a second one pointed at the same bridge would fight the
 * first. A group assigned outside this definition is reported, never
 * unassigned. The credentials are left alone unless `rotateToken` asks,
 * because rewriting them with a wrong token stops provisioning outright.
 */
export async function setUpScimProvisioning(
  entra: EntraClient,
  manifest: ScimProvisioningManifest,
  options: ScimSetupOptions,
): Promise<ScimSetupResult> {
  const actions: string[] = [];
  const notes: string[] = [];

  // The Graph token decides which tenant is written to, and it is easy to be
  // signed into the wrong one. The declaration names the tenant it means.
  const tenant = await entra.describeTenant();
  if (!tenantMatches(manifest.tenantId, tenant)) {
    throw new Error(
      `The Graph token reaches tenant ${tenant.id} (${tenant.domains.join(', ')}), ` +
        `but the definition declares "${manifest.tenantId}". Sign into the declared tenant and re-run.`,
    );
  }

  const name = manifest.applicationDisplayName;
  const servicePrincipal = await entra.findServicePrincipal(name);
  if (!servicePrincipal) {
    throw new Error(
      `No enterprise application is named "${name}". cdkop configures the provisioning application, ` +
        'it does not create one; set it up in Entra, or fix applicationDisplayName.',
    );
  }

  const jobs = await entra.listSynchronizationJobs(servicePrincipal.id);
  if (jobs.length === 0) {
    notes.push(`"${name}" has no provisioning job. Configure provisioning on it in Entra.`);
  }
  for (const job of jobs) {
    if (job.state !== 'Active') {
      notes.push(`Provisioning job ${job.id} is ${job.state ?? 'in an unknown state'}, not Active.`);
    }
  }

  let token: string | undefined;
  if (options.rotateToken) {
    if (!manifest.tenantUrl) {
      throw new Error('--rotate-token needs ScimProvisioning to declare tenantUrl, the SCIM bridge address.');
    }
    token = options.env[manifest.tokenFrom]?.trim();
    if (!token) {
      throw new Error(`--rotate-token reads the bearer token from $${manifest.tokenFrom}, which is unset.`);
    }
  }

  const assigned = await entra.listAssignedGroups(servicePrincipal.id);
  const assignedIds = new Set(assigned.map((a) => a.groupId));
  const groupIds = new Map<string, string>();
  const missing: string[] = [];
  for (const group of manifest.groups) {
    const id = await entra.findGroupId(group);
    if (id === undefined) {
      missing.push(group);
    } else {
      groupIds.set(group, id);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `No Entra security group is named ${missing.map((g) => `"${g}"`).join(', ')}. Nothing was configured.`,
    );
  }

  const toAssign = [...groupIds].filter(([, id]) => !assignedIds.has(id));
  const declaredIds = new Set(groupIds.values());
  for (const extra of assigned.filter((a) => !declaredIds.has(a.groupId))) {
    notes.push(`"${extra.displayName}" is assigned to "${name}" but not declared (left alone).`);
  }

  const verb = options.yes ? '' : 'would ';
  if (token !== undefined && manifest.tenantUrl) {
    actions.push(`${verb}write the Tenant URL ${manifest.tenantUrl} and the token from $${manifest.tokenFrom}`);
    if (options.yes) {
      await entra.setSynchronizationSecrets(servicePrincipal.id, manifest.tenantUrl, token);
    }
  }
  for (const [group, id] of toAssign) {
    actions.push(`${verb}assign "${group}" to "${name}"`);
    if (options.yes) {
      await entra.assignGroup(servicePrincipal, id);
    }
  }
  if (toAssign.length === 0) {
    notes.push(`All ${groupIds.size} declared group(s) are assigned to "${name}".`);
  }
  return { actions, notes };
}

function tenantMatches(declared: string, tenant: { id: string; domains: string[] }): boolean {
  const want = declared.trim().toLowerCase();
  return tenant.id.toLowerCase() === want || tenant.domains.some((d) => d.toLowerCase() === want);
}
