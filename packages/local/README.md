# @cdktn/bundler-local

Host-process asset bundler for [CDK Terrain](https://github.com/open-constructs/cdk-terrain).

`LocalBundler` runs a build command directly on the machine performing the
synth and stages its output as a `TerraformAsset`. The required toolchain must
already be installed on the host; for an isolated, reproducible build use
`@cdktn/bundler-docker` instead.

## Usage

```ts
import { TerraformAsset, AssetType } from "cdktn";
import { LocalBundler, BundlingOutput } from "@cdktn/bundler-local";

new TerraformAsset(this, "asset", {
  path: "./src",
  type: AssetType.DIRECTORY,
  bundler: new LocalBundler({
    command: ["sh", "-c", "npm run build -- --out-dir \"$ASSET_OUTPUT_DIR\""],
    outputType: BundlingOutput.NOT_ARCHIVED,
  }),
});
```

The command is spawned directly, without a shell, so environment variable
references like `$ASSET_OUTPUT_DIR` are only expanded if the command itself is a
shell (`sh -c "..."` as above). Two variables are set for it:

- `ASSET_INPUT_DIR` — the asset source (read-only).
- `ASSET_OUTPUT_DIR` — a caller-owned directory the build writes its artifact into.

## License

Mozilla Public License 2.0
