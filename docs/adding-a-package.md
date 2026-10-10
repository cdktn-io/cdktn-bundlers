# Adding a package

Each bundler is a jsii package in `packages/<name>`, published to npm, PyPI,
Maven Central, NuGet and Go. `<name>` is lower-kebab-case (`nodejs`,
`docker-bind`), and every published name derives from it. `pnpm run check`
(part of CI's `build` job) enforces this.

| Target | Name for `packages/docker-bind` |
| --- | --- |
| npm | `@cdktn/bundler-docker-bind` |
| PyPI | `cdktn-bundler-docker-bind` (module `cdktn_bundler_docker_bind`) |
| Maven | `io.cdktn:cdktn-bundler-docker-bind` (package `io.cdktn.bundler.dockerbind`) |
| NuGet | `Io.Cdktn.Bundler.DockerBind` |
| Go | `github.com/cdktn-io/cdktn-bundlers-go/dockerbind` |

## package.json

```json
{
  "name": "@cdktn/bundler-docker-bind",
  "version": "0.0.0",
  "description": "…",
  "license": "MPL-2.0",
  "author": { "name": "cdktn-io", "url": "https://cdktn.io", "organization": true },
  "repository": {
    "type": "git",
    "url": "https://github.com/cdktn-io/cdktn-bundlers.git",
    "directory": "packages/docker-bind"
  },
  "main": "lib/index.js",
  "types": "lib/index.d.ts",
  "files": ["lib/**/*.js", "lib/**/*.d.ts", ".jsii"],
  "scripts": {
    "build": "jsii",
    "package": "jsii-pacmak"
  },
  "peerDependencies": {
    "cdktn": "^0.25.0",
    "constructs": "^10.6.0"
  },
  "devDependencies": {
    "cdktn": "0.25.0",
    "constructs": "10.6.0"
  },
  "jsii": {
    "outdir": "dist",
    "tsc": { "outDir": "lib", "rootDir": "src" },
    "targets": {
      "python": { "distName": "cdktn-bundler-docker-bind", "module": "cdktn_bundler_docker_bind" },
      "java": {
        "package": "io.cdktn.bundler.dockerbind",
        "maven": { "groupId": "io.cdktn", "artifactId": "cdktn-bundler-docker-bind" }
      },
      "dotnet": { "namespace": "Io.Cdktn.Bundler.DockerBind", "packageId": "Io.Cdktn.Bundler.DockerBind" },
      "go": { "moduleName": "github.com/cdktn-io/cdktn-bundlers-go", "packageName": "dockerbind" }
    }
  }
}
```

`IAssetBundler` first ships in cdktn 0.25.0. Until that is released, depend on
the current `0.25.0-pre.*`. Keep each devDependency at the lowest version its
peer range allows (jsii warns otherwise).

`jsii`, `jsii-pacmak`, `typescript` and `@types/node` come from the workspace
root, so every package builds with the same versions. Each package also needs
a `README.md`, which becomes its page on every registry. Add a `test` script
once the package has tests; the root runs it if present.

## release-please

Register the package with release-please in the same PR:

- `release-please-config.json`: add `"packages/docker-bind": {}` to `packages`.
- `.release-please-manifest.json`: add `"packages/docker-bind": "0.0.0"`.

`pnpm run check` fails if either is missing or if `package.json`'s `version`
differs from the manifest. Never bump `version` by hand: once the PR is merged,
release-please opens a release PR for the package (first version 0.1.0) and
keeps it updated as more commits touching `packages/docker-bind` land.

## First release of a package

There are no long-lived registry credentials, so npm and PyPI need one-time
setup for each new package. Do it after the package's PR is merged and before
its first release PR is.

1. **PyPI**: add a [pending trusted publisher](https://docs.pypi.org/trusted-publishers/creating-a-project-through-oidc/)
   for `cdktn-bundler-<name>`: owner `cdktn-io`, repository `cdktn-bundlers`,
   workflow `release.yml`, environment `pypi`. The first upload then creates
   the project.
2. **npm**: a trusted publisher can only be added to a package that already
   exists, so a maintainer publishes a placeholder by hand. That needs npm
   11.15 or later and an account with 2FA that can publish to `@cdktn`:

   ```bash
   mkdir placeholder && cd placeholder
   cat > package.json <<'EOF'
   {
     "name": "@cdktn/bundler-<name>",
     "version": "0.0.0",
     "description": "Placeholder. See https://github.com/cdktn-io/cdktn-bundlers",
     "license": "MPL-2.0",
     "repository": { "type": "git", "url": "https://github.com/cdktn-io/cdktn-bundlers.git" }
   }
   EOF
   npm publish --access public
   npm trust github @cdktn/bundler-<name> --file release.yml \
     --repo cdktn-io/cdktn-bundlers --env release --allow-publish
   ```

   A new trusted publisher expires unless it is used within 2 days, so run
   `npm trust` only when the release PR is ready to merge. After the first real
   release, deprecate the placeholder
   (`npm deprecate @cdktn/bundler-<name>@0.0.0 "placeholder"`) and set the
   package's publishing access to "Require two-factor authentication and
   disallow tokens".
3. **Maven, NuGet, Go**: nothing. They use the `io.cdktn` namespace, the
   `Io.Cdktn` prefix and `cdktn-bundlers-go`, which already exist.

If the npm step is missed, the release still publishes everywhere else and
the npm job fails naming the package. Bootstrap it, then dispatch `release`
(with `dry_run` off) to publish the missing npm version.
