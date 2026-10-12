// Copyright (c) cdktn-io
// SPDX-License-Identifier: MPL-2.0

import { spawnSync } from "child_process";
import { createHash } from "crypto";
import { existsSync, readdirSync, statSync } from "fs";
import * as path from "path";
import { BundleOptions, BundleResult, BundlerKey, IAssetBundler } from "cdktn";

/**
 * How the bundler interprets what its command wrote to the output directory.
 */
export enum BundlingOutput {
  /**
   * The output directory contains a single archive file that is the artifact.
   */
  ARCHIVED = "archived",

  /**
   * The output directory holds the artifact as a tree of files.
   */
  NOT_ARCHIVED = "not-archived",

  /**
   * The output directory contains a single file that is the artifact.
   */
  SINGLE_FILE = "single-file",

  /**
   * A single file in the output directory is treated as the artifact;
   * otherwise the directory itself is.
   */
  AUTO_DISCOVER = "auto-discover",
}

/**
 * Configuration for {@link LocalBundler}.
 */
export interface LocalBundlerProps {
  /**
   * The command to run on the host, as an argv array.
   *
   * The first element is the program; the rest are its arguments. The command
   * runs with `ASSET_INPUT_DIR` set to the source and `ASSET_OUTPUT_DIR` set
   * to the output directory, and it is expected to write the built artifact
   * into `ASSET_OUTPUT_DIR`.
   */
  readonly command: string[];

  /**
   * Environment variables to set for the command.
   *
   * @default - only the caller's environment plus `ASSET_INPUT_DIR` and
   * `ASSET_OUTPUT_DIR`
   */
  readonly environment?: { [key: string]: string };

  /**
   * The working directory the command runs in.
   *
   * @default - the asset source directory
   */
  readonly workingDirectory?: string;

  /**
   * How the command's output is interpreted.
   *
   * @default BundlingOutput.AUTO_DISCOVER
   */
  readonly outputType?: BundlingOutput;

  /**
   * Extra content folded into the bundler key so a change to it invalidates
   * the asset hash even when the source and command are unchanged.
   *
   * @default - nothing extra is folded in
   */
  readonly extraHash?: string;

  /**
   * The file name to stage a single-file artifact under.
   *
   * Only meaningful when the result is a single file staged as
   * `AssetType.FILE`. Without it, a file produced from a directory source is
   * staged under the source directory's basename.
   *
   * @default - the artifact's own basename
   */
  readonly outputFileName?: string;
}

/**
 * Runs a build command on the host and stages its output as a CDK for
 * Terraform asset.
 *
 * The command is spawned with the asset source and a caller-owned output
 * directory exposed through the `ASSET_INPUT_DIR` and `ASSET_OUTPUT_DIR`
 * environment variables. Unlike a container bundler, the build runs directly
 * on the machine performing the synth, so the required toolchain must already
 * be installed there.
 */
export class LocalBundler implements IAssetBundler {
  public readonly bundlerKey?: string;
  public readonly outputFileName?: string;

  private readonly command: string[];
  private readonly environment?: { [key: string]: string };
  private readonly workingDirectory?: string;
  private readonly outputType: BundlingOutput;

  constructor(props: LocalBundlerProps) {
    this.command = props.command;
    this.environment = props.environment;
    this.workingDirectory = props.workingDirectory;
    this.outputType = props.outputType ?? BundlingOutput.AUTO_DISCOVER;
    this.outputFileName = props.outputFileName;

    // The source tree cannot observe the build, so every input that can move
    // the output has to reach identity through the key: command, working
    // directory, environment and the declared output shape. Each segment is
    // labelled so a value in one field can never serialise to the same string
    // as a value in another (e.g. an environment entry vs. an extraHash).
    let key = BundlerKey.of("local")
      .add(`cmd=${JSON.stringify(this.command)}`)
      .add(`out=${this.outputType}`)
      .add(`cwd=${this.workingDirectory ?? ""}`);
    if (this.environment) {
      key = key.withEnv(this.environment);
    }
    if (props.extraHash) {
      key = key.add(`extra=${props.extraHash}`);
    }
    this.bundlerKey = `local::${createHash("sha256")
      .update(key.toString())
      .digest("hex")
      .slice(0, 16)}`;
  }

  public bundle(options: BundleOptions): BundleResult {
    const { source, outputDir } = options;
    const [program, ...args] = this.command;

    const result = spawnSync(program, args, {
      cwd: this.workingDirectory ?? source,
      // Stream the build's output straight through instead of capturing it:
      // capturing is bounded by spawnSync's 1 MiB maxBuffer, which SIGTERMs a
      // verbose build (e.g. `npm ci`) with ENOBUFS, and hides output until the
      // build exits.
      stdio: ["ignore", process.stderr, "inherit"],
      env: {
        ...process.env,
        ...this.environment,
        ASSET_INPUT_DIR: source,
        ASSET_OUTPUT_DIR: outputDir,
      },
    });

    if (result.error) {
      // A missing toolchain is not a hard failure: declining lets a
      // ChainBundler fall through to its next bundler (the local-then-Docker
      // case the ChainBundler docs describe). Any other spawn error is real.
      if (isSpawnUnavailable(result.error)) {
        return BundleResult.declined();
      }
      throw result.error;
    }
    if (result.status !== 0) {
      const reason =
        result.signal != null
          ? `signal ${result.signal}`
          : `status ${result.status}`;
      throw new Error(
        `Local bundling exited with ${reason} (${program} ${args.join(" ")})`,
      );
    }
    if (!existsSync(outputDir)) {
      throw new Error(
        `Local bundling did not create the output directory ${outputDir}`,
      );
    }

    const artifact = determineBundledArtifact(outputDir, this.outputType);
    return statSync(artifact).isDirectory()
      ? BundleResult.directory(artifact)
      : BundleResult.file(artifact);
  }
}

/**
 * Whether a spawn error means the command could not be run at all.
 *
 * These signal an absent or non-executable toolchain, which a chain of
 * bundlers should be allowed to skip past rather than fail on.
 */
function isSpawnUnavailable(error: NodeJS.ErrnoException): boolean {
  return error.code === "ENOENT" || error.code === "EACCES";
}

/**
 * Resolves the built artifact inside an output directory according to the
 * declared output type.
 */
export function determineBundledArtifact(
  outputDir: string,
  outputType: BundlingOutput = BundlingOutput.AUTO_DISCOVER,
): string {
  const entries = readdirSync(outputDir);
  const files = entries.filter((entry) =>
    statSync(path.join(outputDir, entry)).isFile(),
  );

  switch (outputType) {
    case BundlingOutput.NOT_ARCHIVED:
      return outputDir;
    case BundlingOutput.ARCHIVED:
    case BundlingOutput.SINGLE_FILE:
      // Require exactly one file. Picking the first of several in readdir
      // order would stage a different artifact depending on the filesystem
      // (e.g. bundle.zip vs. its sibling bundle.zip.sha256).
      if (files.length !== 1) {
        throw new Error(
          `Bundling output directory must contain exactly one file for ` +
            `output type ${outputType}, found ${files.length}: ${outputDir}`,
        );
      }
      return path.join(outputDir, files[0]);
    case BundlingOutput.AUTO_DISCOVER:
      return entries.length === 1 && files.length === 1
        ? path.join(outputDir, files[0])
        : outputDir;
    default:
      throw new Error(`Unsupported bundling output type: ${outputType}`);
  }
}
