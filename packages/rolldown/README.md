# @cdktn/bundler-rolldown

A [Rolldown](https://rolldown.rs) Node.js asset bundler for
[CDK Terrain](https://github.com/open-constructs/cdk-terrain). It implements
cdktn's `IAssetBundler` and the `INodejsBundlerFactory` contract from
`@cdktn/bundler-nodejs-spec`.

It is cloud-agnostic. It knows nothing about Lambda runtimes or `@aws-sdk/*`
externals. An L2 maps those onto `target` and `externalModules`.

Prior art: open-constructs/cdk-terrain#402 by @garysassano (`@cdktn/bundler-nodejs`).
The child-process runner, the externals-to-regex mapping and treating
`UNRESOLVED_IMPORT` as an error come from that PR.

## Usage

```ts
import { AssetHashType, AssetType, TerraformAsset } from "cdktn";
import { RolldownBundler } from "@cdktn/bundler-rolldown";

new TerraformAsset(this, "code", {
  path: projectRoot,                    // holds package.json / node_modules
  type: AssetType.ARCHIVE,              // cdktn's deterministic zip (or DIRECTORY)
  assetHashType: AssetHashType.OUTPUT,  // recommended: see below
  bundler: new RolldownBundler({ entry: "src/handler.ts", target: "node22", projectRoot }),
});
```

Install `rolldown` in your project, as AWS CDK expects you to do with esbuild.
It ships a platform-specific native binding that cannot be vendored into a
jsii package. The bundler resolves it from `projectRoot`, then from its own
`node_modules`. If neither has it, `bundle()` declines, so
`ChainBundler.of(rolldown, other)` falls through to the next bundler.

## Design notes

- **Output.** The bundler writes a directory with `index.js` or `index.mjs`,
  plus source maps. cdktn's ZIP packaging (`AssetType.ARCHIVE`) zips it
  deterministically: fixed mtime and sorted entries. #402 instead writes its
  own zip with fflate. Returning a directory reuses core and avoids a zip
  dependency.
- **Sync vs async.** `IAssetBundler.bundle()` is synchronous, because jsii
  cannot await a host-language callback. Rolldown's API is async and ESM-only,
  and it has no synchronous bundle entry point. `bundle()` therefore blocks on
  a child `node runner.mjs` process, the approach #402 uses. The child's
  stdout is never inherited, because a jsii host may be using the parent's
  stdout for its kernel protocol.
- **Identity.** `bundlerKey` contains the resolved Rolldown version, the
  normalized options (as sorted JSON, the same object the runner receives),
  and the lockfile name plus a content digest.
- **Determinism.** Source map paths are relative to the project root, and
  `cwd` is resolved to its real path, so the bundle bytes do not depend on
  where the project is checked out.
- **Hash type.** Prefer `AssetHashType.OUTPUT`. The source is a project root,
  most of which the entry never imports. Do not set `exclude` on the asset:
  that copies the whole root before every build.

## AWS CDK / TerraConstructs `NodejsFunction` bundling options Rolldown does not support

| Option | Why |
| --- | --- |
| `sourceMapMode: BOTH` | Rolldown emits either an inline map or a separate one, not both |
| `loader` values `file`, `copy`, `default`, `css` variants | no equivalent Rolldown module type |
| `inject` | Rolldown's `inject` maps globals to imports; esbuild's prepends files |
| `charset`, `metafile`, `logLevel`, `esbuildArgs`, `esbuildVersion` | esbuild-specific (no metafile in Rolldown) |
| `nodeModules`, `commandHooks`, `preCompilation` | install, shell-hook and `tsc` steps; neither bundler does them, and they are a separate concern |
| `dockerImage`, `forceDockerBundling`, `buildArgs`, `bundlingFileAccess` | no Docker leg; chain with a Docker bundler instead |
| `bundleAwsSDK`, `runtime`, `architecture`, `assetHash` | belong to the L2 or the asset, not to a bundler |

## License

Mozilla Public License 2.0
