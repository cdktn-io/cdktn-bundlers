# cdktn-bundlers

Asset bundlers maintained by the cdktn team: implementations of cdktn's
`IAssetBundler` interface, each published as its own package to npm, PyPI,
Maven Central, NuGet and Go.

Packages:

- `@cdktn/bundler-local`: runs a build with the host toolchain.
- `@cdktn/bundler-docker`: runs a build in a docker container.

[docs/adding-a-package.md](docs/adding-a-package.md) describes how to add one.

## Layout

```
packages/<name>/     one jsii package per bundler (@cdktn/bundler-<name>)
release-please-config.json, .release-please-manifest.json
                     release-please packages and their current versions
```

## Development

```bash
pnpm install
pnpm run build     # jsii, every package
pnpm run test
pnpm run package   # jsii-pacmak, every package (needs Python, Java, .NET and Go)
```

## Releasing

Packages are versioned independently by
[release-please](https://github.com/googleapis/release-please), from
conventional-commit PR titles (enforced by the `Validate PR title` check):

1. Merging a PR that touches `packages/<name>` makes release-please open (or
   update) a release PR for that package, with the version bump and
   `CHANGELOG.md`.
2. Merging the release PR tags `bundler-<name>-v<version>`, creates the
   GitHub release, and runs the publish jobs. A second `team-cdk-terrain`
   member approves them.

Publishing has no long-lived registry credentials: npm and PyPI use trusted
publishing, which a new package has to be set up for once
([docs/adding-a-package.md](docs/adding-a-package.md)). Every publish step
skips versions its registry already has, so a failed publish is retried with
"Re-run failed jobs" on the same workflow run (within 14 days, while its
build artifact is kept).

Go modules are published to
[cdktn-io/cdktn-bundlers-go](https://github.com/cdktn-io/cdktn-bundlers-go).

## License

[MPL-2.0](LICENSE)
