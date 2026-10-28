# @cdktn/bundler-dereference

Asset bundler for [CDK Terrain](https://github.com/open-constructs/cdk-terrain)
that replaces symlinks with the contents of their targets.

cdktn core keeps symlinks as links when it hashes, copies and zips an asset.
That is right for a link that resolves inside the artifact, but a link that
points outside it ships as a dangling link. Monorepos often symlink shared
packages into a function directory (`functions/api/shared -> ../../packages/shared`),
and a zip deployed to Lambda, Cloud Functions or Azure Functions needs the
*contents*. `DereferenceBundler` copies the source into the bundler output and
materializes those targets.

## Usage

> [!IMPORTANT]
> Always use `DereferenceBundler` with `assetHashType: AssetHashType.OUTPUT`.
>
> The bundler sets no `bundlerKey`. Under `OUTPUT` hashing, cdktn builds the
> asset eagerly and hashes the tree the bundler produced, which contains the
> dereferenced content, so editing a file behind an external link changes the
> asset hash. Under the default `SOURCE` hashing, cdktn hashes the source tree,
> where an external link counts only as its target path. A change behind the
> link would leave the hash unchanged while the staged artifact changed,
> giving a stale deploy. The bundler is not told which hash type it runs
> under, so it cannot reject `SOURCE` for you.

```ts
import { AssetHashType, AssetType, TerraformAsset } from "cdktn";
import { DereferenceBundler, SymlinkFollow } from "@cdktn/bundler-dereference";

const code = new TerraformAsset(this, "code", {
  path: "./functions/api",
  type: AssetType.ARCHIVE,
  assetHashType: AssetHashType.OUTPUT,
  bundler: new DereferenceBundler({ follow: SymlinkFollow.EXTERNAL }),
});
```

### Excluding files: put exclusions on the bundler

```ts
import { ExcludeIgnoreStrategy } from "cdktn";

new TerraformAsset(this, "code", {
  path: "./functions/api",
  type: AssetType.ARCHIVE,
  assetHashType: AssetHashType.OUTPUT,
  bundler: new DereferenceBundler({
    ignoreStrategy: new ExcludeIgnoreStrategy(["*.map", "shared/node_modules"]),
  }),
});
```

Don't set `exclude` or `ignoreStrategy` on the asset itself while the source
has relative links that escape it. With asset-level exclusions, cdktn hands
the bundler a filtered *copy* of the source in a temporary directory. That copy
keeps links verbatim, so `shared -> ../shared` points at a path that doesn't
exist there, and the bundler fails with a dangling-link error. Absolute links
are unaffected. Filtering on the bundler instead is safe under `OUTPUT`
hashing, because identity follows the produced tree.

The bundler's `ignoreStrategy` matches paths relative to the **output**:
content brought in through `shared -> ../shared` is matched as
`shared/node_modules/...`, not by its real location.

### Mapping AWS CDK `followSymlinks` (TerraConstructs and similar L2s)

| AWS CDK                                     | cdktn                                                                                          |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `followSymlinks: SymlinkFollowMode.NEVER`   | no bundler (core's behavior)                                                                   |
| `followSymlinks: SymlinkFollowMode.EXTERNAL`| `bundler: new DereferenceBundler({ follow: SymlinkFollow.EXTERNAL })`, `assetHashType: OUTPUT` |
| `followSymlinks: SymlinkFollowMode.ALWAYS`  | `bundler: new DereferenceBundler({ follow: SymlinkFollow.ALWAYS })`, `assetHashType: OUTPUT`   |
| `followSymlinks: SymlinkFollowMode.BLOCK_EXTERNAL` | not provided                                                                            |
| `exclude` / `ignoreMode` with a follow mode | the bundler's `ignoreStrategy` (not the asset's), see above                                    |

```ts
// An L2 mapping CDK's Code.fromAsset(path, { followSymlinks, exclude })
function toTerraformAssetConfig(p: string, opts: CdkAssetOptions): TerraformAssetConfig {
  const follow =
    opts.followSymlinks === SymlinkFollowMode.ALWAYS ? SymlinkFollow.ALWAYS
    : opts.followSymlinks === SymlinkFollowMode.EXTERNAL ? SymlinkFollow.EXTERNAL
    : undefined;
  if (follow === undefined) {
    return { path: p, type: AssetType.ARCHIVE, exclude: opts.exclude };
  }
  return {
    path: p,
    type: AssetType.ARCHIVE,
    assetHashType: AssetHashType.OUTPUT,
    bundler: new DereferenceBundler({
      follow,
      ignoreStrategy: opts.exclude ? new ExcludeIgnoreStrategy(opts.exclude) : undefined,
    }),
  };
}
```

If the user also passed CDK `assetHashType: SOURCE` (or a custom hash) together
with a follow mode, the L2 should reject the combination or override it to
`OUTPUT`, for the reason given above.

## Behavior

`follow` selects which links are replaced:

- **`SymlinkFollow.EXTERNAL`** (default): a link whose resolved target lies
  outside the source root is replaced by its target: a copy of the file, or the
  directory copied recursively. A link that resolves inside the root stays a
  link:
  - A relative link written in the source is kept exactly as written.
  - An absolute link is rewritten to a relative one, so it still resolves in
    the output.
  - A link inside dereferenced content that points back into the source is
    rewritten relative to its new location.
- **`SymlinkFollow.ALWAYS`**: every link is replaced, and the output contains no
  symlinks.

Other rules:

- **Dangling links are errors.** The message names the link and its target. To
  ship without a dangling link, exclude it with `ignoreStrategy`; excluded
  entries are skipped before they are resolved.
- **Cycles are errors.** The bundler tracks the chain of real directories it is
  descending. Following a link back into a directory on that chain throws an
  error that names the chain, for example
  `symlink cycle at "a/link": it leads back to "." (...). Chain: . => a => a/link -> ../`.
  This covers a link to an ancestor under `ALWAYS`, an external link to a
  directory that contains the source, and external directories that link to
  each other. A loop made of links only (`a -> b`, `b -> a`) is reported the
  same way, never as a raw `ELOOP`.
- Regular files keep their permission bits, including files reached through a
  link. On macOS a kept link also keeps its own mode; on Linux link modes are
  always `0777`.
- Sockets, FIFOs and devices are skipped, as in core's own copy.
- A file source (`AssetType.FILE`) is resolved and copied through as a
  `BundleResult.file`.

### Hash stability for trees without external links

When the source has no external links and no absolute internal links, the
bundler output is byte-for-byte the tree core would have staged. The `OUTPUT`
hash then equals the hash the same asset gets without a bundler. This holds
for both `AssetType.DIRECTORY` and `AssetType.ARCHIVE`, with
`canonicalAssetHashes` on or off. Adding the bundler to an L2 therefore
doesn't change any asset hash for users without links. The one exception is an
absolute link that points inside the source: rewriting it as a relative link
changes its recorded target, and so changes the hash.

### Differences from AWS CDK `SymlinkFollowMode`

These are compared against aws-cdk-lib's `core/lib/fs/copy.ts` and `shouldFollow`.

- **Where links are followed.** CDK applies the follow mode to both the
  fingerprint and the copy. Here only the copy follows links, and identity
  comes from `OUTPUT` hashing of the result.
- **Internal or external.** CDK decides *lexically*: `path.resolve(dir, linkText)`
  is compared to the root with a plain `startsWith`, so `/src/app-other` counts
  as inside `/src/app`. This bundler compares *real* paths (`realpath`) on path
  segment boundaries. A link that reaches outside only through another link is
  therefore treated as external.
- **Internal link text.** CDK copies internal links verbatim. This bundler
  rewrites an absolute internal link, or a link inside dereferenced content
  that points back into the source, as a relative link, so it stays valid
  inside the artifact. CDK leaves such links pointing at the original location.
- **Dangling links.** CDK's `EXTERNAL` silently keeps a dangling link, and its
  `ALWAYS` fails with a raw `ENOENT` from `stat`. This bundler throws a named
  error in both modes.
- **Cycles.** CDK has no cycle detection. An `ALWAYS` copy of a link to an
  ancestor recurses until the filesystem fails (`ENAMETOOLONG`/`ELOOP`). This
  bundler throws an error that names the chain.
- **Modes offered.** `NEVER` and `BLOCK_EXTERNAL` are not offered (see the
  table above).

## License

Mozilla Public License 2.0
