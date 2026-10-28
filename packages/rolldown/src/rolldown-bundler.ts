// Copyright (c) cdktn-io
// SPDX-License-Identifier: MPL-2.0

import { spawnSync } from "child_process";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import {
  INodejsBundlerFactory,
  NodejsBundleOutput,
  NodejsBundleSpec,
  NodejsOutputFormat,
  NodejsPlatform,
  NodejsSourceMapMode,
} from "@cdktn/bundler-nodejs-spec";
import {
  BundleOptions,
  BundleResult,
  BundlerKey,
  IAssetBundler,
} from "cdktn";

/**
 * Tool-wide settings for Rolldown, shared by every bundle a
 * {@link RolldownBundlerFactory} creates.
 */
export interface RolldownToolOptions {
  /**
   * Directory to resolve the `rolldown` package from, and to start the
   * lockfile search in.
   *
   * Rolldown is not bundled with this package: it ships a platform-specific
   * native binding that cannot be vendored into a jsii tarball, so the project
   * installs it (and pins its version in its own lockfile), as AWS CDK expects
   * of esbuild. If it is not found here, the copy this package can resolve is
   * used; if neither exists, `bundle()` declines.
   *
   * @default - the current working directory
   */
  readonly projectRoot?: string;

  /**
   * Lockfile folded into the `bundlerKey`, so a dependency change moves the
   * asset hash even when the source tree is hashed without `node_modules`.
   *
   * @default - the nearest `pnpm-lock.yaml`, `package-lock.json`,
   * `yarn.lock`, `bun.lock` or `bun.lockb` at or above `projectRoot`
   */
  readonly depsLockFilePath?: string;

  /**
   * Maximum time for one build, in milliseconds.
   *
   * @default 120000
   */
  readonly timeoutMs?: number;
}

/**
 * Configuration for {@link RolldownBundler}: one bundle spec plus the tool
 * settings.
 */
export interface RolldownBundlerProps
  extends NodejsBundleSpec,
    RolldownToolOptions {}

/** Module types every Node.js bundler in this repo understands. */
const PORTABLE_LOADERS = new Set([
  "js",
  "jsx",
  "ts",
  "tsx",
  "json",
  "text",
  "base64",
  "dataurl",
  "binary",
  "empty",
]);

const LOCKFILES = [
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
];

/** Where the located Rolldown lives. */
interface RolldownInstall {
  readonly entry: string;
  readonly version: string;
}

/**
 * Bundles a Node.js entry point with [Rolldown](https://rolldown.rs) into a
 * directory holding `index.js` (CJS) or `index.mjs` (ESM).
 *
 * Cloud-agnostic: it knows nothing about Lambda, Cloud Functions or Azure
 * Functions. An L2 maps its runtime to `target` and adds its platform's
 * default externals (e.g. `@aws-sdk/*`) before creating it.
 *
 * Stage it with `AssetType.ARCHIVE` for a deterministic zip (cdktn's ZIP
 * packaging uses fixed timestamps and sorted entries) or `AssetType.DIRECTORY`
 * for the tree, and prefer `AssetHashType.OUTPUT`: the source is a project
 * root, most of which the entry never imports. Do not set `exclude` on the
 * asset, which would copy the whole project root before every build.
 *
 * `bundle()` is synchronous, as `IAssetBundler` requires, so it runs Rolldown's
 * async API in a child Node.js process (see `runner.mjs`) and blocks on it.
 */
export class RolldownBundler implements IAssetBundler {
  /**
   * The spec fields Rolldown cannot honor, as messages. Empty when the spec is
   * fully supported.
   */
  public static unsupportedOptions(spec: NodejsBundleSpec): string[] {
    const problems: string[] = [];
    if (spec.sourceMap === false && spec.sourceMapMode !== undefined) {
      problems.push("sourceMapMode cannot be used when sourceMap is false");
    }
    if (spec.sourceMapMode === NodejsSourceMapMode.BOTH) {
      problems.push(
        "sourceMapMode BOTH: Rolldown emits either an inline or a separate source map, not both",
      );
    }
    for (const [ext, loader] of Object.entries(spec.loader ?? {})) {
      if (!PORTABLE_LOADERS.has(loader)) {
        problems.push(
          `loader "${loader}" for ${ext}: Rolldown has no equivalent module type`,
        );
      }
    }
    return problems;
  }

  /**
   * Identifies the build: Rolldown version, the normalized options and the
   * lockfile. Folded into the asset hash by cdktn.
   */
  public readonly bundlerKey?: string;

  /**
   * The Rolldown version this bundler will run, or undefined when Rolldown
   * could not be found (in which case `bundle()` declines).
   */
  public readonly rolldownVersion?: string;

  /**
   * The entry file name at the root of the output.
   */
  public readonly entryFileName: string;

  private readonly request: { [key: string]: unknown };
  private readonly install?: RolldownInstall;
  private readonly timeoutMs: number;

  constructor(props: RolldownBundlerProps) {
    const problems = RolldownBundler.unsupportedOptions(props);
    if (problems.length > 0) {
      throw new Error(
        `RolldownBundler cannot honor these options:\n- ${problems.join("\n- ")}`,
      );
    }

    const projectRoot = path.resolve(props.projectRoot ?? process.cwd());
    this.install = RolldownBundler.locate(projectRoot);
    this.rolldownVersion = this.install?.version;
    this.timeoutMs = props.timeoutMs ?? 120_000;

    const format = props.format ?? NodejsOutputFormat.CJS;
    this.entryFileName = NodejsBundleOutput.entryFileName(format);
    const sourceMapOn =
      props.sourceMapMode !== undefined || props.sourceMap === true;
    const mode = props.sourceMapMode ?? NodejsSourceMapMode.DEFAULT;

    // The normalized request is both what the runner receives and what the
    // key serializes, so the key cannot miss an option the build sees.
    this.request = {
      entry: props.entry,
      target: props.target,
      platform: props.platform ?? NodejsPlatform.NODE,
      format,
      entryFileName: this.entryFileName,
      externalModules: props.externalModules ?? [],
      minify: props.minify ?? false,
      sourcemap: !sourceMapOn
        ? false
        : mode === NodejsSourceMapMode.INLINE
          ? "inline"
          : mode === NodejsSourceMapMode.EXTERNAL
            ? "hidden"
            : true,
      sourcesContent: props.sourcesContent ?? true,
      define: props.define,
      banner: props.banner,
      footer: props.footer,
      keepNames: props.keepNames ?? false,
      mainFields: props.mainFields,
      moduleTypes: RolldownBundler.moduleTypes(props.loader),
      tsconfig: props.tsconfig,
    };

    this.bundlerKey = BundlerKey.of("rolldown")
      .add(`v=${this.install?.version ?? "missing"}`)
      .add(`opts=${RolldownBundler.stableJson(this.request)}`)
      .add(
        `lock=${RolldownBundler.lockfileIdentity(projectRoot, props.depsLockFilePath)}`,
      )
      .toString();
  }

  public bundle(options: BundleOptions): BundleResult {
    if (!this.install) {
      // Declining lets ChainBundler.of(rolldown, esbuildOrDocker) fall through.
      return BundleResult.declined();
    }
    const cwd = options.source;
    const entry = path.resolve(cwd, this.request.entry as string);
    if (!fs.existsSync(entry) || !fs.statSync(entry).isFile()) {
      throw new Error(`Rolldown entry is not a file: ${entry}`);
    }

    const result = spawnSync(
      process.execPath,
      [path.join(__dirname, "..", "runner.mjs")],
      {
        input: JSON.stringify({
          ...this.request,
          entry,
          cwd,
          outDir: options.outputDir,
          rolldownEntry: this.install.entry,
        }),
        cwd,
        // stdout is never inherited: a jsii host may own this process's
        // stdout for its kernel protocol.
        stdio: ["pipe", "pipe", "pipe"],
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        timeout: this.timeoutMs,
        windowsHide: true,
      },
    );
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      throw new Error(
        `Rolldown failed to bundle ${entry} (${
          result.signal ? `signal ${result.signal}` : `status ${result.status}`
        }):\n${result.stderr}`,
      );
    }
    if (result.stderr) {
      process.stderr.write(result.stderr);
    }
    return BundleResult.directory(options.outputDir);
  }

  /**
   * Find Rolldown: the project's own copy first, then this package's.
   */
  private static locate(projectRoot: string): RolldownInstall | undefined {
    for (const from of [projectRoot, __dirname]) {
      let pkgJson: string;
      try {
        pkgJson = require.resolve("rolldown/package.json", { paths: [from] });
      } catch {
        continue;
      }
      const pkg = JSON.parse(fs.readFileSync(pkgJson, "utf8"));
      const main =
        typeof pkg.exports?.["."] === "string"
          ? pkg.exports["."]
          : pkg.exports?.["."]?.import ?? pkg.exports?.["."]?.default;
      if (typeof main !== "string") {
        continue;
      }
      return {
        entry: path.resolve(path.dirname(pkgJson), main),
        version: String(pkg.version),
      };
    }
    return undefined;
  }

  /**
   * `<name>:<sha256 prefix>` of the lockfile, or `none`.
   */
  private static lockfileIdentity(
    projectRoot: string,
    explicit?: string,
  ): string {
    let file = explicit ? path.resolve(projectRoot, explicit) : undefined;
    for (let dir = projectRoot; !file; ) {
      file = LOCKFILES.map((name) => path.join(dir, name)).find((candidate) =>
        fs.existsSync(candidate),
      );
      const parent = path.dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
    if (!file) {
      return "none";
    }
    const digest = createHash("sha256")
      .update(fs.readFileSync(file))
      .digest("hex")
      .slice(0, 16);
    return `${path.basename(file)}:${digest}`;
  }

  /**
   * Map the spec's esbuild-style loaders (`{".sql": "text"}`) onto Rolldown
   * module types, which use the same names for the portable subset.
   */
  private static moduleTypes(loader?: {
    [ext: string]: string;
  }): { [ext: string]: string } | undefined {
    if (!loader) {
      return undefined;
    }
    const out: { [ext: string]: string } = {};
    for (const [ext, type] of Object.entries(loader)) {
      out[ext.startsWith(".") ? ext : `.${ext}`] = type;
    }
    return out;
  }

  /**
   * JSON with sorted object keys and undefined fields dropped, so property
   * order and unset options cannot change the key.
   */
  private static stableJson(value: unknown): string {
    return JSON.stringify(value, (_key, v) =>
      v && typeof v === "object" && !Array.isArray(v)
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .filter((k) => v[k] !== undefined)
              .map((k) => [k, v[k]]),
          )
        : v,
    );
  }
}

/**
 * The {@link INodejsBundlerFactory} for Rolldown: what an L2
 * `NodejsFunction`-like construct accepts as its `bundler`, or what
 * `NodejsBundlerDefaults.setDefault()` stores for a whole scope.
 */
export class RolldownBundlerFactory implements INodejsBundlerFactory {
  public readonly toolName = "rolldown";

  private readonly options: RolldownToolOptions;

  constructor(options: RolldownToolOptions = {}) {
    this.options = options;
  }

  public unsupportedOptions(spec: NodejsBundleSpec): string[] {
    return RolldownBundler.unsupportedOptions(spec);
  }

  public bundler(spec: NodejsBundleSpec): IAssetBundler {
    return new RolldownBundler({ ...this.options, ...spec });
  }
}
