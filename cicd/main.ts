/**
 * CI workflow for cdkop, defined with @factbird/cdkactions and synthesized
 * to `.github/workflows/`.
 *
 * Regenerate after editing:  bun run synth:workflows
 * (CI fails if the committed YAML drifts from this definition.)
 *
 * CI typechecks, runs the unit tests (which exercise plan and apply against an
 * in-memory 1Password fake) and synthesizes the example definition. It never
 * runs `plan` or `apply` against a live account: both need a signed-in
 * administrator session, which a CI runner does not have and should not.
 */
import {
  App,
  checkoutV7,
  createPullRequestV8,
  DependabotActionPinSync,
  installNixActionV31,
  Job,
  RunnerLabel,
  Stack,
  setupBunV2,
  setupNodeV6,
  Workflow,
} from '@factbird/cdkactions';

/**
 * An action runs by commit, not by tag: whoever controls the tag can move it,
 * and the release job holds a token that publishes to npm. Synth checks that
 * each version's tag still points at its commit.
 */
const checkout = checkoutV7.pinned('3d3c42e5aac5ba805825da76410c181273ba90b1', 'v7.0.1');
const setupBun = setupBunV2.pinned('0c5077e51419868618aeaa5fe8019c62421857d6', 'v2.2.0');
const setupNode = setupNodeV6.pinned('949feb2413d6458794dcd2491c4babbbce0c15c1', 'v7.1.0');
const installNix = installNixActionV31.pinned('448cde739abec1eaf0646249e3d25bb8d9bc7702', 'v31.11.2');
const createPullRequest = createPullRequestV8.pinned('5f6978faf089d4d20b00c7766989d076bb2fc7f1', 'v8.1.1');

const checkoutStep = () => checkout({ id: 'checkout' });
const setupBunStep = () => setupBun({ id: 'bun', name: 'Setup Bun', with: { bunVersion: 'latest' } });
const installStep = { name: 'Install', run: 'bun install --frozen-lockfile' };

/**
 * A named image rather than `ubuntu-latest`, so the image a job runs on changes
 * only through a change here.
 */
const runner = RunnerLabel.custom('ubuntu-26.04');

const app = new App({
  outdir: '.github/workflows',
  // The built-in validate workflow assumes a `.github/cdk` + yarn layout; our
  // definition lives in `cicd/` and the `verify` job already checks for drift.
  createValidateWorkflow: false,
});
const stack = new Stack(app, 'cdkop');

const ci = new Workflow(stack, 'ci', {
  name: 'CI',
  on: {
    pullRequest: { branches: ['main'] },
    push: { branches: ['main'] },
  },
  permissions: { contents: 'read' },
});

new Job(ci, 'verify', {
  runsOn: runner,
  steps: [
    checkoutStep(),
    setupBunStep(),
    installStep,
    { name: 'Typecheck', run: 'bun run build' },
    // Unit tests cover the plan/apply surface with an in-memory 1Password fake.
    { name: 'Test', run: 'bun test' },
    // Synthesize the desired-state manifest from the example definition.
    {
      name: 'Synth manifest',
      run: 'bun src/bin/cdkop.ts synth examples/example.ts',
    },
    { name: 'Compile', run: 'bun run compile' },
    {
      name: 'Workflows in sync',
      run: 'bun run synth:workflows && git diff --exit-code .github/workflows',
    },
  ],
});

/**
 * Publishes to npm when a GitHub release is published. npm trusts this
 * workflow's OIDC token, so no npm token is stored anywhere. The package's
 * trusted publisher on npmjs.com names this repository, the workflow file
 * `cdkactions_release.yaml` and the environment `npm`, and a token minted by
 * any other workflow or environment is refused.
 */
const release = new Workflow(stack, 'release', {
  name: 'Release',
  on: { release: { types: ['published'] } },
  permissions: { contents: 'read' },
});

new Job(release, 'publish', {
  runsOn: runner,
  environment: 'npm',
  // Two releases published together still publish one after the other.
  concurrency: { group: 'npm-publish', cancelInProgress: false },
  permissions: { contents: 'read', idToken: 'write' },
  steps: [
    checkoutStep(),
    setupBunStep(),
    installStep,
    { name: 'Typecheck', run: 'bun run build' },
    { name: 'Test', run: 'bun test' },
    // Trusted publishing needs Node 22.14 and npm 11.5.1 or later.
    setupNode({
      id: 'node',
      with: { nodeVersion: '24', registryUrl: 'https://registry.npmjs.org' },
    }),
    { name: 'Update npm', run: 'npm install --global npm@^11.5.1' },
    {
      name: 'Release tag matches package.json',
      env: { TAG: '${{ github.event.release.tag_name }}' },
      run: [
        'VERSION="v$(node -p "require(\'./package.json\').version")"',
        'if [ "$TAG" != "$VERSION" ]; then',
        '  echo "::error::Release tag $TAG does not match package.json version $VERSION"',
        '  exit 1',
        'fi',
      ].join('\n'),
    },
    { name: 'Compile', run: 'bun run compile' },
    { name: 'Prepare the npm package', run: 'bun cicd/dist-manifest.ts' },
    // npm attaches provenance on its own.
    { name: 'Publish', run: 'npm publish' },
  ],
});

/**
 * Dependabot never reads devenv.lock, and nixpkgs follows
 * cachix/devenv-nixpkgs/rolling, which moves about once a month. GitHub runs no
 * workflows on a pull request GITHUB_TOKEN opens until someone pushes to it or
 * reopens it.
 */
const devenvUpdate = new Workflow(stack, 'devenv-update', {
  name: 'devenv update',
  on: {
    schedule: [{ cron: '0 6 3 * *' }],
    workflowDispatch: null,
  },
  permissions: { contents: 'read' },
});

new Job(devenvUpdate, 'update', {
  runsOn: runner,
  permissions: { contents: 'write', pullRequests: 'write' },
  steps: [
    checkoutStep(),
    installNix({ name: 'Install Nix' }),
    { name: 'Install devenv', run: 'nix profile add nixpkgs#devenv' },
    { name: 'Update devenv.lock', run: 'devenv update' },
    createPullRequest({
      id: 'pull-request',
      name: 'Open pull request',
      with: {
        branch: 'chore/devenv-update',
        addPaths: 'devenv.lock',
        commitMessage: 'chore: update devenv.lock',
        title: 'chore: update devenv.lock',
        body: [
          'The monthly `devenv update` run moved the inputs in devenv.lock.',
          '',
          'GITHUB_TOKEN opened this pull request, so CI has not run on it. Push a commit or close and reopen the pull request to start it.',
        ].join('\n'),
        deleteBranch: true,
      },
    }),
  ],
});

/**
 * The push job reads APP_ID and APP_PEM from this repository's Dependabot
 * secrets. Organization Dependabot secrets do not reach a public repository.
 */
new DependabotActionPinSync(stack, 'dependabot-action-pin-sync', {
  sources: ['cicd/main.ts'],
  synthCommand: 'bun run synth:workflows',
  setupSteps: [setupBunStep(), installStep],
  runsOn: runner,
});

app.synth();
