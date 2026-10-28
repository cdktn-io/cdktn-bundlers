// Copyright (c) cdktn-io
// SPDX-License-Identifier: MPL-2.0

import { IAssetBundler } from "cdktn";

/**
 * The module format of the bundled output.
 */
export enum NodejsOutputFormat {
  /**
   * CommonJS. The entry file is written as `index.js`.
   */
  CJS = "cjs",

  /**
   * ECMAScript modules. The entry file is written as `index.mjs`.
   */
  ESM = "esm",
}

/**
 * The environment the bundle targets, which drives built-in module and
 * package `exports` condition resolution.
 */
export enum NodejsPlatform {
  /**
   * Node.js: built-in modules (`fs`, `node:path`, ...) stay external.
   */
  NODE = "node",

  /**
   * A browser-like environment.
   */
  BROWSER = "browser",

  /**
   * Neither: no platform-specific resolution.
   */
  NEUTRAL = "neutral",
}

/**
 * How a source map is emitted, mirroring AWS CDK's `SourceMapMode`.
 */
export enum NodejsSourceMapMode {
  /**
   * A separate `.map` file, referenced by a `//# sourceMappingURL` comment.
   */
  DEFAULT = "default",

  /**
   * A separate `.map` file with no reference comment in the bundle.
   */
  EXTERNAL = "external",

  /**
   * The map is inlined into the bundle as a data URL.
   */
  INLINE = "inline",

  /**
   * Both an inline map and a separate `.map` file.
   */
  BOTH = "both",
}

/**
 * A bundler-agnostic description of one Node.js bundle.
 *
 * This is the intersection of the AWS CDK / TerraConstructs `NodejsFunction`
 * bundling options and what the Node.js bundlers in this repository (esbuild,
 * Rolldown) can all express. Anything cloud-specific (a Lambda runtime, the
 * AWS SDK default externals) is resolved by the L2 into these plain fields
 * before the spec reaches a bundler. Anything tool-specific (esbuild CLI
 * arguments, a Rolldown config module, a Docker image) stays on that tool's
 * own props.
 *
 * Every field is plain data so the spec can be serialized into a
 * `bundlerKey` and handed across the jsii boundary.
 */
export interface NodejsBundleSpec {
  /**
   * The entry file, relative to the asset source directory.
   *
   * The asset source is the project root (the directory holding
   * `package.json` and `node_modules`), as in AWS CDK's `projectRoot`.
   */
  readonly entry: string;

  /**
   * Syntax target, e.g. `node22` or `es2022`.
   *
   * @default - the bundler's own default
   */
  readonly target?: string;

  /**
   * The platform the bundle runs on.
   *
   * @default NodejsPlatform.NODE
   */
  readonly platform?: NodejsPlatform;

  /**
   * Output module format.
   *
   * @default NodejsOutputFormat.CJS
   */
  readonly format?: NodejsOutputFormat;

  /**
   * Modules left out of the bundle and resolved at runtime instead.
   *
   * A trailing `/*` matches every subpath (`@aws-sdk/*`); a bare name also
   * matches its own subpaths (`lodash` matches `lodash/fp`).
   *
   * @default - nothing is external besides the platform's built-ins
   */
  readonly externalModules?: string[];

  /**
   * Whether to minify the output.
   *
   * @default false
   */
  readonly minify?: boolean;

  /**
   * Whether to emit a source map.
   *
   * @default false
   */
  readonly sourceMap?: boolean;

  /**
   * How the source map is emitted. Implies `sourceMap: true`.
   *
   * @default NodejsSourceMapMode.DEFAULT
   */
  readonly sourceMapMode?: NodejsSourceMapMode;

  /**
   * Whether the source map embeds the original sources.
   *
   * @default true
   */
  readonly sourcesContent?: boolean;

  /**
   * Compile-time replacements: identifier to JavaScript expression.
   *
   * Values are expressions, so a string literal must carry its own quotes
   * (`JSON.stringify("production")`).
   *
   * @default - no replacements
   */
  readonly define?: { [key: string]: string };

  /**
   * Text prepended verbatim to each output JavaScript file.
   *
   * @default - no banner
   */
  readonly banner?: string;

  /**
   * Text appended verbatim to each output JavaScript file.
   *
   * @default - no footer
   */
  readonly footer?: string;

  /**
   * Preserve the `name` of functions and classes when minifying.
   *
   * @default false
   */
  readonly keepNames?: boolean;

  /**
   * Package.json fields to try, in order, when resolving a package.
   *
   * @default - the bundler's platform default
   */
  readonly mainFields?: string[];

  /**
   * How to load files by extension, e.g. `{ ".sql": "text" }`.
   *
   * Only the loaders every bundler shares are portable: `js`, `jsx`, `ts`,
   * `tsx`, `json`, `text`, `base64`, `dataurl`, `binary` and `empty`.
   *
   * @default - the bundler's defaults
   */
  readonly loader?: { [ext: string]: string };

  /**
   * Path to a `tsconfig.json`, relative to the asset source directory.
   *
   * @default - the bundler's own discovery
   */
  readonly tsconfig?: string;
}

/**
 * Produces an {@link IAssetBundler} for a {@link NodejsBundleSpec}.
 *
 * This is what an L2 `NodejsFunction`-like construct consumes, so its users
 * can choose esbuild, Rolldown or anything else without the L2 depending on
 * any one of them. Tool-wide settings (where to resolve the tool from, a
 * lockfile, a Docker fallback) are given to the factory once; the per-function
 * spec is given to `bundler()`.
 *
 * Output contract: the returned bundler produces a **directory** whose root
 * holds the entry chunk named by {@link NodejsBundleOutput.entryFileName}
 * (plus any source maps and chunks). The L2 stages it with
 * `AssetType.ARCHIVE` (zip) or `AssetType.DIRECTORY`, and should use
 * `AssetHashType.OUTPUT`: an entry-graph bundler reads only what the entry
 * imports, so hashing the whole project root would rebuild on unrelated
 * changes.
 */
export interface INodejsBundlerFactory {
  /**
   * A short name for the tool, e.g. `rolldown` or `esbuild`, for diagnostics.
   */
  readonly toolName: string;

  /**
   * The spec fields this tool cannot honor, as human-readable messages.
   *
   * The L2 decides whether that is a warning or an error. An empty list means
   * the spec is fully supported.
   */
  unsupportedOptions(spec: NodejsBundleSpec): string[];

  /**
   * Create the bundler for one spec.
   */
  bundler(spec: NodejsBundleSpec): IAssetBundler;
}

/**
 * Naming conventions every {@link INodejsBundlerFactory} output follows.
 */
export class NodejsBundleOutput {
  /**
   * The entry file name at the root of the bundle output for a format:
   * `index.mjs` for ESM, `index.js` otherwise (matching AWS CDK).
   */
  public static entryFileName(format?: NodejsOutputFormat): string {
    return format === NodejsOutputFormat.ESM ? "index.mjs" : "index.js";
  }

  private constructor() {}
}
