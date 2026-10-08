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
  "version": "0.1.0",
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

## First release of a package

Merge the package, then before dispatching `release`:

1. **PyPI**: add a pending trusted publisher for `cdktn-bundler-<name>`
   (owner `cdktn-io`, repository `cdktn-bundlers`, workflow `release.yml`,
   environment `pypi`). Without it the upload is rejected.
2. **npm**: nothing beforehand. The first publish falls back to `NPM_TOKEN`.
   Afterwards, add a trusted publisher on the package (repository
   `cdktn-bundlers`, workflow `release.yml`, environment `release`) and set
   publishing access to "disallow tokens".
3. **Maven, NuGet, Go**: nothing. They use the `io.cdktn` namespace, the
   `Io.Cdktn` prefix and `cdktn-bundlers-go`, which already exist.

Dispatch with `dry_run` first; the run summary lists what would be published.
