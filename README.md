# cdktn-bundlers

Asset bundlers maintained by the cdktn team: implementations of cdktn's
`IAssetBundler` interface, each published as its own package to npm, PyPI,
Maven Central, NuGet and Go.

There are no packages yet. [docs/adding-a-package.md](docs/adding-a-package.md)
describes how to add one.

## Layout

```
packages/<name>/     one jsii package per bundler (@cdktn/bundler-<name>)
scripts/release.mjs  convention checks, artifact collection, release planning
```

## Development

```bash
pnpm install
pnpm run build     # jsii, every package
pnpm run test
pnpm run package   # jsii-pacmak, every package (needs Python, Java, .NET and Go)
```

## Releasing

Packages are versioned independently. To release, bump `version` in the
package's `package.json` through a PR, then run the `release` workflow from
`main`. It publishes every version that is not yet on its registry, and a
second `team-cdk-terrain` member has to approve the publish jobs. Run it with
`dry_run` (the default) first to see the plan.

Go modules are published to
[cdktn-io/cdktn-bundlers-go](https://github.com/cdktn-io/cdktn-bundlers-go).

## License

[MPL-2.0](LICENSE)
