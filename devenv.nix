{
  pkgs,
  inputs,
  ...
}: {
  imports = [inputs.devkit.devenvModules.default];

  # cdkop is a TypeScript project run on Bun (package manager + runtime + test
  # runner). The shell adds the 1Password CLI, which every read and write goes
  # through, and the Azure CLI, which `cdkop scim` falls back to for a Microsoft
  # Graph token when AZURE_GRAPH_TOKEN is unset.
  packages = [
    pkgs._1password-cli
    pkgs.azure-cli
    pkgs.git
  ];

  languages.javascript = {
    enable = true;
    bun = {
      enable = true;
      # Run `bun install` on shell entry and when the lockfile changes.
      install.enable = true;
    };
  };

  # Biome formats and lints .ts/.json with devkit's shared settings, and devkit
  # writes them to biome.json for editors and a bare `biome`.
  treefmt = {
    enable = true;
    config = {
      settings.global.excludes = ["op.out/*" "*.lock"];
      devkit.biome = {
        enable = true;
        linter.enable = true;
      };
    };
  };

  git-hooks.hooks = {
    treefmt.enable = true;
    lsLint.enable = true;
  };

  # Shorthands mirroring the package.json scripts.
  scripts.synth.exec = "bun src/bin/cdkop.ts synth examples/factbird.ts";
  scripts.synth-workflows.exec = "bun run synth:workflows";
  # `fmt` rewrites in place; `lint` is check-only and fails on any diff (what
  # `devenv test` runs).
  scripts.fmt.exec = "treefmt";
  scripts.lint.exec = "treefmt --ci";

  enterShell = ''
    echo "cdkop dev shell: bun $(bun --version), op $(op --version)"
  '';

  # `devenv test` gates the same things CI does (formatting + typecheck + tests).
  enterTest = ''
    treefmt --ci
    bun run build
    bun test
  '';
}
