# @cdktn/bundler-local

Host-process asset bundler for [CDK Terrain](https://github.com/open-constructs/cdk-terrain).

`LocalBundler` runs a build command directly on the machine performing the
synth and stages its output as a `TerraformAsset`. The required toolchain must
already be installed on the host; for an isolated, reproducible build use
`@cdktn/bundler-docker` instead.

## Usage

```ts
import { TerraformAsset, AssetType } from "cdktn";
import { LocalBundler } from "@cdktn/bundler-local";

new TerraformAsset(this, "asset", {
  path: "./src",
  type: AssetType.DIRECTORY,
  bundler: new LocalBundler({
    command: ["sh", "-c", "npm run build -- --out-dir \"$ASSET_OUTPUT_DIR\""],
  }),
});
```

The command is spawned directly, without a shell, so environment variable
references like `$ASSET_OUTPUT_DIR` are only expanded if the command itself is a
shell (`sh -c "..."` as above). Two variables are set for it:

- `ASSET_INPUT_DIR` — the asset source (read-only).
- `ASSET_OUTPUT_DIR` — a caller-owned directory the build writes its artifact into.

### Windows

`LocalBundler` resolves `npm`, `npx`, `pnpm`, and `.cmd`/`.bat` shims under
`node_modules/.bin` the same way [`cross-spawn`][cross-spawn] does, so these
commands work on Windows without a shell. A bare name like `"tsc"` is only
found this way when the directory containing its shim (for example
`node_modules/.bin`) is on `PATH`; otherwise pass a relative or absolute path
to it instead.

The `sh -c "..."` form in the example above still needs `sh` on `PATH` (for
example through Git Bash or WSL), since Windows has no built-in shell of that
name. A command that does not need a shell, such as a package.json script run
directly (`["npm", "run", "build"]`), works on Windows without that
dependency.

A script run directly (for example `["./build.js"]`) relies on Windows file
association, not on a shebang line, to pick an interpreter — pass the
interpreter explicitly instead (`["node", "build.js"]`).

[cross-spawn]: https://github.com/moxystudio/node-cross-spawn

## License

Mozilla Public License 2.0
