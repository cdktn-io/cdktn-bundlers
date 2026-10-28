# @cdktn/bundler-nodejs-spec

The bundler-agnostic contract between an L2 `NodejsFunction`-like construct
and the Node.js bundlers for [CDK Terrain](https://github.com/open-constructs/cdk-terrain)
(`@cdktn/bundler-rolldown`, a future `@cdktn/bundler-esbuild`, or your own).

It lets an L2 (TerraConstructs, or a GCP or Azure library) offer "esbuild or
Rolldown" without depending on either. It contains no bundler and no cloud
code.

- `NodejsBundleSpec`: one bundle as plain data. It holds the options that
  AWS CDK's `NodejsFunction` and every bundler here share: `entry`, `target`,
  `platform`, `format`, `externalModules`, `minify`, `sourceMap`,
  `sourceMapMode`, `sourcesContent`, `define`, `banner`, `footer`,
  `keepNames`, `mainFields`, `loader` and `tsconfig`.
- `INodejsBundlerFactory`: `bundler(spec)` returns a cdktn `IAssetBundler`.
  `unsupportedOptions(spec)` lets the L2 warn or fail before it builds
  anything.
- `NodejsBundleOutput.entryFileName(format)`: every factory writes a directory
  with `index.js` (CJS) or `index.mjs` (ESM) at its root.
- `NodejsBundlerDefaults`: a scope-wide default factory, resolved when the
  construct is created.

## For L2 authors

```ts
import { NodejsBundlerDefaults, INodejsBundlerFactory } from "@cdktn/bundler-nodejs-spec";

// in the L2 constructor, before creating the asset:
const factory = NodejsBundlerDefaults.resolve(this, props.bundler, myDefaultFactory);
const spec = { entry, target: runtimeToTarget(runtime), externalModules: ["@aws-sdk/*"], ...props.bundling };
new TerraformAsset(this, "Code", {
  path: projectRoot,
  type: AssetType.ARCHIVE,
  assetHashType: AssetHashType.OUTPUT,
  bundler: factory.bundler(spec),
});
```

## For L2 users

```ts
// per construct
new NodejsFunction(stack, "fn", { entry, bundler: new RolldownBundlerFactory() });
// for everything under a stack (or the App, or any subtree), set *before* creating them
NodejsBundlerDefaults.setDefault(stack, new RolldownBundlerFactory());
```

The nearest scope wins. The default must be set at construction time: the
asset hash is computed in `TerraformAsset`'s constructor (with
`AssetHashType.OUTPUT` the bundle is built there too), so an `Aspect`, which
runs at synth, cannot change it.

## License

Mozilla Public License 2.0
