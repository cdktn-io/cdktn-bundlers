// Copyright (c) cdktn-io
// SPDX-License-Identifier: MPL-2.0

import * as fs from "fs";
import * as path from "path";
import {
  BundleOptions,
  BundleResult,
  IAssetBundler,
  IIgnoreStrategy,
} from "cdktn";

/**
 * Which symlinks {@link DereferenceBundler} replaces with their targets'
 * contents.
 *
 * Mirrors the two following modes of AWS CDK's `SymlinkFollowMode`. CDK's
 * `NEVER` is what cdktn core already does without a bundler, and
 * `BLOCK_EXTERNAL` has no use for a bundler whose job is to remove links, so
 * neither is offered.
 */
export enum SymlinkFollow {
  /**
   * Dereference only links whose resolved target lies outside the source
   * root. Links that resolve inside the root stay links (an absolute one is
   * rewritten to a relative one so it still resolves in the output).
   */
  EXTERNAL = "external",

  /**
   * Dereference every link: the output contains no symlinks at all.
   */
  ALWAYS = "always",
}

/**
 * Configuration for {@link DereferenceBundler}.
 */
export interface DereferenceBundlerProps {
  /**
   * Which links to replace with their targets' contents.
   *
   * @default SymlinkFollow.EXTERNAL
   */
  readonly follow?: SymlinkFollow;

  /**
   * Entries to leave out of the output, applied while copying.
   *
   * Paths are matched relative to the *output* root, so content brought in
   * through a dereferenced link is matched under the link's own path
   * (`shared/node_modules`, not the target's real path). An excluded link is
   * skipped before it is resolved, so excluding a dangling link avoids the
   * dangling-link error.
   *
   * Prefer this over the asset's own `exclude` / `ignoreStrategy`. When the
   * asset sets those, cdktn core hands the bundler a filtered temporary copy
   * of the source in which relative links that escape the source root no
   * longer resolve (the bundler then fails with a dangling-link error). Under
   * `AssetHashType.OUTPUT`, filtering here instead is safe: identity follows
   * the produced tree.
   *
   * @default - nothing is excluded
   */
  readonly ignoreStrategy?: IIgnoreStrategy;
}

/**
 * A directory on the descent chain, for cycle detection and error messages.
 */
interface ChainEntry {
  /** Real (fully resolved) path of the directory. */
  readonly real: string;
  /** How the walk reached it, e.g. `a/link -> ../shared`. */
  readonly label: string;
}

/**
 * Copies an asset source into the output directory, replacing symlinks with
 * the contents of their targets.
 *
 * cdktn core keeps symlinks as links when it hashes, copies and zips an
 * asset. That is correct for a link that resolves inside the artifact, but a
 * link pointing outside it (a monorepo package symlinked into a function
 * directory) ships as a dangling link. This bundler materializes those
 * targets.
 *
 * **Use it with `assetHashType: AssetHashType.OUTPUT`.** The bundler has no
 * `bundlerKey`: under `OUTPUT` hashing core builds eagerly and hashes the
 * produced tree, which contains the dereferenced content, so a change behind
 * an external link changes the asset hash. Under the default `SOURCE`
 * hashing, core hashes the *source* tree, where an external link is recorded
 * only by its target path; a change behind the link would then leave the hash
 * (and the deployed artifact) stale. The bundler cannot detect which hash
 * type it runs under, so this is not enforced.
 *
 * Behavior:
 *
 * - A link whose target cannot be resolved (dangling) is an error naming the
 *   link, unless `ignoreStrategy` excludes it.
 * - Following a link into a directory that is already being copied (a link to
 *   an ancestor, or a loop of links) is an error naming the chain, rather than
 *   infinite recursion or duplicated content.
 * - Sockets, FIFOs and devices are skipped, as core's copy does.
 * - Regular files keep their permission bits.
 */
export class DereferenceBundler implements IAssetBundler {
  /**
   * Which links are dereferenced.
   */
  public readonly follow: SymlinkFollow;

  /**
   * Exclusions applied while copying, if any.
   */
  public readonly ignoreStrategy?: IIgnoreStrategy;

  constructor(props: DereferenceBundlerProps = {}) {
    this.follow = props.follow ?? SymlinkFollow.EXTERNAL;
    this.ignoreStrategy = props.ignoreStrategy;
    if (!Object.values(SymlinkFollow).includes(this.follow)) {
      throw new Error(
        `DereferenceBundler: unsupported follow mode "${String(this.follow)}"`,
      );
    }
  }

  public bundle(options: BundleOptions): BundleResult {
    const { source, outputDir } = options;
    const root = resolveOrThrow(source, source, "the asset source");
    const rootStat = fs.statSync(root);

    if (!rootStat.isDirectory()) {
      // A file source has no links below it; core already follows a link at
      // the asset root. Copy the resolved file under the source's name.
      const target = path.join(outputDir, path.basename(source));
      fs.copyFileSync(root, target);
      return BundleResult.file(target);
    }

    new TreeCopier(root, outputDir, this.follow, this.ignoreStrategy).run();
    return BundleResult.directory(outputDir);
  }
}

/**
 * One copy of a source tree into an output directory.
 */
class TreeCopier {
  constructor(
    private readonly root: string,
    private readonly outputRoot: string,
    private readonly follow: SymlinkFollow,
    private readonly ignore?: IIgnoreStrategy,
  ) {}

  public run(): void {
    this.copyDirectory(this.root, this.outputRoot, "", [
      { real: this.root, label: "." },
    ]);
  }

  /**
   * Copy the children of `srcDir` into `destDir`.
   *
   * @param srcDir - the directory to read; for content reached through a
   * link this is the link's real target
   * @param destDir - where its children are written
   * @param relDir - `/`-separated path of `destDir` relative to the output root
   * @param chain - the real directories currently being descended
   */
  private copyDirectory(
    srcDir: string,
    destDir: string,
    relDir: string,
    chain: ChainEntry[],
  ): void {
    fs.mkdirSync(destDir, { recursive: true });
    for (const name of fs.readdirSync(srcDir).sort()) {
      const srcPath = path.join(srcDir, name);
      const destPath = path.join(destDir, name);
      const relPath = relDir ? `${relDir}/${name}` : name;
      const stat = fs.lstatSync(srcPath);

      const excluded =
        this.ignore?.ignores({
          relativePath: relPath,
          isDirectory: stat.isDirectory(),
        }) ?? false;
      if (excluded) {
        // Matches core's walkers: an excluded directory is still descended
        // (and materialized) when the strategy re-includes paths below it.
        if (
          stat.isDirectory() &&
          this.ignore?.pruneExcludedDirectories === false
        ) {
          this.descend(srcPath, destPath, relPath, relPath, chain);
        }
        continue;
      }

      if (stat.isSymbolicLink()) {
        this.copyLink(srcPath, destPath, relPath, stat, chain);
      } else if (stat.isDirectory()) {
        this.descend(srcPath, destPath, relPath, relPath, chain);
      } else if (stat.isFile()) {
        fs.copyFileSync(srcPath, destPath);
      }
      // Sockets, FIFOs and devices are skipped, as in core's copySync.
    }
  }

  private copyLink(
    linkPath: string,
    destPath: string,
    relPath: string,
    linkStat: fs.Stats,
    chain: ChainEntry[],
  ): void {
    const linkText = fs.readlinkSync(linkPath);
    const real = resolveOrThrow(
      linkPath,
      relPath,
      `symlink "${relPath}" -> "${linkText}"`,
      chain,
    );
    const internal = isWithin(this.root, real);

    if (this.follow === SymlinkFollow.EXTERNAL && internal) {
      fs.symlinkSync(
        this.internalLinkText(linkPath, linkText, relPath, real),
        destPath,
      );
      preserveLinkMode(destPath, linkStat);
      return;
    }

    const targetStat = fs.statSync(real);
    if (targetStat.isDirectory()) {
      this.descend(real, destPath, relPath, `${relPath} -> ${linkText}`, chain);
    } else if (targetStat.isFile()) {
      fs.copyFileSync(real, destPath);
    }
    // A link to a socket, FIFO or device is skipped like the entry itself.
  }

  /**
   * Descend into a directory, refusing to re-enter one already on the chain.
   */
  private descend(
    srcDir: string,
    destDir: string,
    relPath: string,
    label: string,
    chain: ChainEntry[],
  ): void {
    const real = fs.realpathSync(srcDir);
    const loop = chain.findIndex((entry) => entry.real === real);
    if (loop !== -1) {
      const path_ = [...chain.map((e) => e.label), label].join(" => ");
      throw new Error(
        `DereferenceBundler: symlink cycle at "${relPath}": it leads back to ` +
          `"${chain[loop].label}" (${real}), which is already being copied. ` +
          `Chain: ${path_}. Exclude the link with ignoreStrategy, or use ` +
          `SymlinkFollow.EXTERNAL if the link points inside the source.`,
      );
    }
    this.copyDirectory(srcDir, destDir, relPath, [...chain, { real, label }]);
  }

  /**
   * The text for an internal link kept as a link.
   *
   * A relative link written in the source tree whose target resolves the same
   * way lexically is kept verbatim, so its hash and staged form are unchanged.
   * Anything else (an absolute link, a link inside dereferenced content, a
   * path that only resolves through other links) is rewritten as a relative
   * path from the link's output location to the target's output location.
   */
  private internalLinkText(
    linkPath: string,
    linkText: string,
    relPath: string,
    real: string,
  ): string {
    const linkIsInSourceTree =
      path.join(this.root, ...relPath.split("/")) === linkPath;
    if (linkIsInSourceTree && !path.isAbsolute(linkText)) {
      const lexical = path.resolve(path.dirname(linkPath), linkText);
      if (isWithin(this.root, lexical) && safeRealpath(lexical) === real) {
        return linkText;
      }
    }
    const outputLink = path.join(this.outputRoot, ...relPath.split("/"));
    const outputTarget = path.join(
      this.outputRoot,
      path.relative(this.root, real),
    );
    return path.relative(path.dirname(outputLink), outputTarget) || ".";
  }
}

/**
 * Resolve `p` to its real path, turning ENOENT and ELOOP into errors that name
 * the offending entry.
 */
function resolveOrThrow(
  p: string,
  relPath: string,
  what: string,
  chain?: ChainEntry[],
): string {
  try {
    return fs.realpathSync(p);
  } catch (e: any) {
    const via = chain
      ? ` (reached via ${chain.map((c) => c.label).join(" => ")})`
      : "";
    if (e?.code === "ENOENT" || e?.code === "ENOTDIR") {
      throw new Error(
        `DereferenceBundler: dangling ${what}: its target does not exist${via}. ` +
          `Remove the link or exclude "${relPath}" with ignoreStrategy. If the ` +
          `asset sets exclude/ignoreStrategy, a relative link escaping the ` +
          `source root dangles in the filtered copy cdktn hands the bundler; ` +
          `move the exclusions to the bundler's ignoreStrategy.`,
      );
    }
    if (e?.code === "ELOOP") {
      throw new Error(
        `DereferenceBundler: symlink cycle at ${what}: the links resolve back ` +
          `to themselves${via}.`,
      );
    }
    throw e;
  }
}

function safeRealpath(p: string): string | undefined {
  try {
    return fs.realpathSync(p);
  } catch {
    return undefined;
  }
}

/**
 * Whether `p` is `root` or lies below it. Both must be real paths.
 */
function isWithin(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
  );
}

/**
 * Carry a symlink's own permission bits over where the platform can set them
 * (macOS), so the canonical hash, which records link modes, matches the
 * source. On Linux link modes are always 0777 and `lchmod` does not exist.
 */
function preserveLinkMode(dest: string, linkStat: fs.Stats): void {
  const lchmod = (fs as any).lchmodSync as
    | ((p: string, mode: number) => void)
    | undefined;
  if (typeof lchmod !== "function") {
    return;
  }
  try {
    lchmod(dest, linkStat.mode & 0o7777);
  } catch {
    // Best effort: only the hash of the produced tree is affected.
  }
}
