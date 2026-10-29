// Copyright (c) cdktn-io
// SPDX-License-Identifier: MPL-2.0

import { createHash, randomUUID } from "crypto";
import { mkdtempSync, rmSync } from "fs";
import * as os from "os";
import * as path from "path";
import { dockerExec, runDockerImage } from "./docker";
import type { DockerRunOptions } from "./docker";

/**
 * A `--cache-from`/`--cache-to` entry passed to `docker build`.
 *
 * @see https://docs.docker.com/engine/reference/commandline/buildx_build/#cache-from
 */
export interface DockerCacheOption {
  /**
   * The cache type, e.g. `registry`, `local`, `gha`.
   */
  readonly type: string;

  /**
   * Any parameters to pass along with the cache type, e.g. `mode=max`.
   *
   * @default - no parameters are passed
   */
  readonly params?: { [key: string]: string };
}

/**
 * Options for {@link DockerImage.fromBuild}.
 */
export interface DockerBuildOptions {
  /**
   * Build args to pass to the `docker build` command.
   *
   * @default - no build args are passed
   */
  readonly buildArgs?: { [key: string]: string };

  /**
   * Build secrets to pass to the `docker build` command.
   *
   * Docker BuildKit must be enabled to use build secrets.
   *
   * @see https://docs.docker.com/build/buildkit/
   *
   * @default - no build secrets are passed
   */
  readonly buildSecrets?: { [key: string]: string };

  /**
   * SSH agent socket or keys to pass to the `docker build` command.
   *
   * Docker BuildKit must be enabled to use the `ssh` option.
   *
   * @see https://docs.docker.com/build/buildkit/
   *
   * @default - no ssh arg is passed
   */
  readonly buildSsh?: string;

  /**
   * Name of the Dockerfile, relative to `buildPath`.
   *
   * @default "Dockerfile"
   */
  readonly file?: string;

  /**
   * Networking mode for the `RUN` commands during build. Supports docker API
   * 1.25+.
   *
   * @default - no networking mode specified
   */
  readonly networkMode?: string;

  /**
   * Platform to build for. Requires Docker Buildx.
   *
   * @default - current machine platform
   */
  readonly platform?: string;

  /**
   * Docker target to build to.
   *
   * @default - no target
   */
  readonly targetStage?: string;

  /**
   * Outputs to pass to the `docker build` command.
   *
   * @see https://docs.docker.com/engine/reference/commandline/build/#custom-build-outputs
   *
   * @default - no outputs are passed to the build command (default outputs
   * are used)
   */
  readonly outputs?: string[];

  /**
   * Disable the build cache by passing `--no-cache` to `docker build`.
   *
   * @default false
   */
  readonly cacheDisabled?: boolean;

  /**
   * Cache from options to pass to the `docker build` command.
   *
   * @default - no cache from args are passed
   */
  readonly cacheFrom?: DockerCacheOption[];

  /**
   * Cache to options to pass to the `docker build` command.
   *
   * @default - no cache to args are passed
   */
  readonly cacheTo?: DockerCacheOption;
}

/**
 * Methods to build Docker CLI arguments for builds using secrets.
 *
 * Docker BuildKit must be enabled to use build secrets.
 *
 * @see https://docs.docker.com/build/buildkit/
 */
export class DockerBuildSecret {
  /**
   * A Docker build secret from a file source.
   */
  public static fromSrc(src: string): string {
    return `src=${src}`;
  }
}

/**
 * Renders `--build-arg` flags for a `docker build` invocation.
 */
function flattenBuildArgs(buildArgs?: { [key: string]: string }): string[] {
  return Object.entries(buildArgs ?? {}).flatMap(([k, v]) => [
    "--build-arg",
    `${k}=${v}`,
  ]);
}

/**
 * Renders `--secret` flags for a `docker build` invocation.
 */
function flattenBuildSecrets(buildSecrets?: {
  [key: string]: string;
}): string[] {
  return Object.entries(buildSecrets ?? {}).flatMap(([id, src]) => [
    "--secret",
    `id=${id},${src}`,
  ]);
}

/**
 * Renders a single `DockerCacheOption` into its `type=...,key=value` form.
 */
function renderCache(cache: DockerCacheOption): string {
  const params = Object.entries(cache.params ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
  return `type=${cache.type}${params ? `,${params}` : ""}`;
}

/**
 * Renders `--cache-from` flags for a `docker build` invocation.
 */
function flattenCacheFrom(cacheFrom?: DockerCacheOption[]): string[] {
  return (cacheFrom ?? []).flatMap((c) => ["--cache-from", renderCache(c)]);
}

/**
 * Renders the `--cache-to` flag for a `docker build` invocation.
 */
function flattenCacheTo(cacheTo?: DockerCacheOption): string[] {
  return cacheTo ? ["--cache-to", renderCache(cacheTo)] : [];
}

/**
 * A docker image, either referenced from a registry or built from a local
 * Dockerfile.
 */
export class DockerImage {
  /**
   * Reference an image by name or by name and tag from a registry.
   */
  public static fromRegistry(image: string): DockerImage {
    return new DockerImage(image);
  }

  /**
   * Build a docker image from a directory containing a Dockerfile.
   */
  public static fromBuild(
    buildPath: string,
    options: DockerBuildOptions = {},
  ): DockerImage {
    const tag = `cdktn-${createHash("sha256")
      .update(JSON.stringify([buildPath, options]))
      .digest("hex")
      .slice(0, 32)}`;
    const args = [
      "build",
      "-t",
      tag,
      ...flattenBuildArgs(options.buildArgs),
      ...flattenBuildSecrets(options.buildSecrets),
      ...(options.buildSsh ? ["--ssh", options.buildSsh] : []),
      ...(options.file ? ["-f", path.join(buildPath, options.file)] : []),
      ...(options.networkMode ? ["--network", options.networkMode] : []),
      ...(options.platform ? ["--platform", options.platform] : []),
      ...(options.targetStage ? ["--target", options.targetStage] : []),
      ...(options.outputs ?? []).flatMap((o) => ["--output", o]),
      ...flattenCacheFrom(options.cacheFrom),
      ...flattenCacheTo(options.cacheTo),
      ...(options.cacheDisabled ? ["--no-cache"] : []),
      buildPath,
    ];
    dockerExec(args);
    return new DockerImage(tag);
  }

  private constructor(
    /**
     * The image reference (name and optional tag) this instance runs.
     */
    public readonly image: string,
  ) {}

  /**
   * Run the image once with the given options and wait for it to exit.
   */
  public run(options: DockerRunOptions = {}): void {
    runDockerImage(this.image, options);
  }

  /**
   * Copy a path out of a container run from this image, into `outputPath`
   * (or a fresh temp directory if omitted), returning the resulting path.
   */
  public cp(imagePath: string, outputPath?: string): string {
    const containerName = `cdktn-cp-${randomUUID()}`;
    dockerExec(["create", "--name", containerName, this.image]);
    let tempDir: string | undefined;
    try {
      const destination =
        outputPath ??
        (tempDir = mkdtempSync(path.join(os.tmpdir(), "cdktn-docker-cp-")));
      dockerExec(["cp", `${containerName}:${imagePath}`, destination]);
      return destination;
    } catch (error) {
      if (tempDir) {
        rmSync(tempDir, { recursive: true, force: true });
      }
      throw error;
    } finally {
      try {
        dockerExec(["rm", "-v", containerName]);
      } catch {
        // Best effort: a cleanup failure must not mask the original error.
      }
    }
  }

  public toJSON(): string {
    return this.image;
  }
}
