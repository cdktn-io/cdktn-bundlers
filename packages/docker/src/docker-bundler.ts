// Copyright (c) cdktn-io
// SPDX-License-Identifier: MPL-2.0

import { createHash, randomBytes } from "crypto";
import { readdirSync, statSync } from "fs";
import * as path from "path";
import { BundleOptions, BundleResult, BundlerKey, IAssetBundler } from "cdktn";
import { DockerImage } from "./bundling";
import { assertImageReference, dockerExec } from "./docker";

/**
 * Where the asset source is mounted inside the build container.
 */
export const BUNDLING_INPUT_DIR = "/asset-input";

/**
 * Where the build container writes its output.
 */
export const BUNDLING_OUTPUT_DIR = "/asset-output";

const SAFE_USER = /^\w[\w.:-]*$/;

/**
 * How the source and output cross the host/container boundary.
 */
export enum BundlingFileAccess {
  /**
   * Bind-mount the host source and output directories into the container.
   *
   * The fastest option, but requires the host paths to be shareable with the
   * docker daemon.
   */
  BIND_MOUNT = "bind-mount",

  /**
   * Copy the source into a named volume, run the build, then copy the output
   * back out.
   *
   * Works where bind mounts are unavailable (e.g. a remote docker daemon).
   */
  VOLUME_COPY = "volume-copy",
}

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
 * Configuration for {@link DockerBundler}.
 */
export interface DockerBundlerProps {
  /**
   * The image to run the build in, as a registry reference.
   *
   * Locally built images are not supported; build and push the image first.
   */
  readonly image: string;

  /**
   * The command to run in the container, as an argv array.
   *
   * The command reads the source from `/asset-input` and writes the built
   * artifact to `/asset-output`.
   */
  readonly command: string[];

  /**
   * How the command's output is interpreted.
   *
   * @default BundlingOutput.AUTO_DISCOVER
   */
  readonly outputType?: BundlingOutput;

  /**
   * The file name to stage a single-file artifact under.
   *
   * Only meaningful when the result is a single file staged as
   * `AssetType.FILE`.
   *
   * @default - the basename of the asset source path
   */
  readonly outputFileName?: string;

  /**
   * The user to run the container as.
   *
   * @default - the current host uid:gid
   */
  readonly user?: string;

  /**
   * Environment variables to set in the container.
   *
   * @default - no extra environment
   */
  readonly environment?: { [key: string]: string };

  /**
   * Override the image entrypoint.
   *
   * @default - the image's default entrypoint
   */
  readonly entrypoint?: string[];

  /**
   * The working directory inside the container.
   *
   * @default "/asset-input"
   */
  readonly workingDirectory?: string;

  /**
   * The container network to attach to.
   *
   * @default - the default docker network
   */
  readonly network?: string;

  /**
   * The platform to run the container as.
   *
   * @default - the host platform
   */
  readonly platform?: string;

  /**
   * A `--security-opt` value passed to the container.
   *
   * @default - none
   */
  readonly securityOpt?: string;

  /**
   * How the source and output cross the host/container boundary.
   *
   * @default BundlingFileAccess.BIND_MOUNT
   */
  readonly bundlingFileAccess?: BundlingFileAccess;

  /**
   * The image used for the short-lived helper container that seeds the input
   * volume and fixes volume ownership under `VOLUME_COPY`.
   *
   * The build image is reused by default, so no second image is pulled and the
   * caller controls every reference the bundler touches. Override this only
   * when the build image has no POSIX shell or `chown` (e.g. a `scratch`- or
   * distroless-based image), pointing it at any small image that does.
   *
   * Ignored under `BIND_MOUNT`.
   *
   * @default - the build image
   */
  readonly volumeCopyHelperImage?: string;
}

/**
 * Runs a build inside a docker container and stages its output as a CDK for
 * Terraform asset.
 *
 * The build runs in an image the caller specifies, isolated from the host
 * toolchain, which makes the artifact reproducible across machines that share
 * the same image. The source directory is mounted read-only at `/asset-input`
 * under `BIND_MOUNT`, or copied into a named volume under `VOLUME_COPY`. The
 * build writes to `/asset-output`. File sources are not supported.
 *
 * `bundle` throws when the docker binary is missing and never declines, so a
 * bundler chain does not fall through to the next bundler.
 */
export class DockerBundler implements IAssetBundler {
  public readonly bundlerKey?: string;
  public readonly outputFileName?: string;

  private readonly props: DockerBundlerProps;
  private readonly fileAccess: BundlingFileAccess;
  private readonly outputType: BundlingOutput;

  constructor(props: DockerBundlerProps) {
    this.props = props;
    this.fileAccess = props.bundlingFileAccess ?? BundlingFileAccess.BIND_MOUNT;
    this.outputType = props.outputType ?? BundlingOutput.AUTO_DISCOVER;
    this.outputFileName = props.outputFileName;
    assertImageReference(props.image);
    if (props.volumeCopyHelperImage) {
      assertImageReference(props.volumeCopyHelperImage);
    }

    // Every segment is labelled so a value in one field can never serialise
    // to the same string as a value in another (e.g. an environment entry vs.
    // the helper image). The transfer mode is included because it can change
    // the resulting file ownership and layout.
    let key = BundlerKey.of("docker")
      .add(`image=${props.image}`)
      .add(`cmd=${JSON.stringify(props.command)}`)
      .add(`out=${this.outputType}`)
      .add(`access=${this.fileAccess}`)
      .add(`entrypoint=${JSON.stringify(props.entrypoint ?? null)}`)
      .add(`workdir=${props.workingDirectory ?? ""}`)
      .add(`platform=${props.platform ?? ""}`)
      .add(`network=${props.network ?? ""}`)
      .add(`securityOpt=${props.securityOpt ?? ""}`)
      .add(`user=${props.user ?? ""}`);
    if (this.fileAccess === BundlingFileAccess.VOLUME_COPY) {
      key = key.add(`helper=${props.volumeCopyHelperImage ?? ""}`);
    }
    const environment = props.environment;
    if (environment) {
      key = key.add(
        ...Object.keys(environment)
          .sort()
          .map((k) => `env=${k}=${environment[k]}`),
      );
    }
    // Digested like LocalBundler's key: keeps bundlerKey short and fixed-length
    // regardless of how long the image reference or command gets.
    this.bundlerKey = `docker::${createHash("sha256")
      .update(key.toString())
      .digest("hex")
      .slice(0, 16)}`;
  }

  public bundle(options: BundleOptions): BundleResult {
    if (!statSync(options.source).isDirectory()) {
      throw new Error(
        `DockerBundler supports only directory sources, got a file: ${options.source}`,
      );
    }
    if (this.fileAccess === BundlingFileAccess.VOLUME_COPY) {
      this.volumeCopy(options.source, options.outputDir);
    } else {
      this.bindMount(options.source, options.outputDir);
    }
    const artifact = determineBundledArtifact(
      options.outputDir,
      this.outputType,
    );
    return statSync(artifact).isDirectory()
      ? BundleResult.directory(artifact)
      : BundleResult.file(artifact);
  }

  private bindMount(source: string, outputDir: string): void {
    DockerImage.fromRegistry(this.props.image).run({
      command: this.props.command,
      user: this.resolveUser(),
      environment: this.props.environment,
      entrypoint: this.props.entrypoint,
      workingDirectory: this.props.workingDirectory ?? BUNDLING_INPUT_DIR,
      volumes: [
        {
          hostPath: source,
          containerPath: BUNDLING_INPUT_DIR,
          readOnly: true,
        },
        { hostPath: outputDir, containerPath: BUNDLING_OUTPUT_DIR },
      ],
      network: this.props.network,
      platform: this.props.platform,
      securityOpt: this.props.securityOpt,
    });
  }

  private volumeCopy(sourceDir: string, outputDirectory: string): void {
    const source = path.resolve(sourceDir);
    const outputDir = path.resolve(outputDirectory);
    const suffix = randomBytes(12).toString("hex");
    const inputVolume = `assetInput${suffix}`;
    const outputVolume = `assetOutput${suffix}`;
    const helperContainer = `copyContainer${suffix}`;
    const user = this.resolveUser();
    if (!SAFE_USER.test(user)) {
      throw new Error(
        `Invalid user "${user}": only letters, digits, "_", ".", ":" and "-" are allowed`,
      );
    }

    try {
      dockerExec(["volume", "create", inputVolume]);
      dockerExec(["volume", "create", outputVolume]);
      dockerExec([
        "run",
        "--name",
        helperContainer,
        "-u",
        "0",
        ...this.helperOptions(),
        "--entrypoint",
        "sh",
        "-v",
        `${inputVolume}:${BUNDLING_INPUT_DIR}`,
        "-v",
        `${outputVolume}:${BUNDLING_OUTPUT_DIR}`,
        this.props.volumeCopyHelperImage ?? this.props.image,
        "-c",
        `mkdir -p ${BUNDLING_INPUT_DIR} && chown -R ${user} ${BUNDLING_OUTPUT_DIR}`,
      ]);
      dockerExec([
        "cp",
        `${source}/.`,
        `${helperContainer}:${BUNDLING_INPUT_DIR}`,
      ]);
      // `docker cp` creates files as root, so ownership is fixed afterwards.
      dockerExec([
        "run",
        "--rm",
        "-u",
        "0",
        ...this.helperOptions(),
        "--entrypoint",
        "sh",
        "--volumes-from",
        helperContainer,
        this.props.volumeCopyHelperImage ?? this.props.image,
        "-c",
        `chown -R ${user} ${BUNDLING_INPUT_DIR}`,
      ]);

      DockerImage.fromRegistry(this.props.image).run({
        command: this.props.command,
        user,
        environment: this.props.environment,
        entrypoint: this.props.entrypoint,
        workingDirectory: this.props.workingDirectory ?? BUNDLING_INPUT_DIR,
        volumesFrom: [helperContainer],
        network: this.props.network,
        platform: this.props.platform,
        securityOpt: this.props.securityOpt,
      });

      dockerExec([
        "cp",
        `${helperContainer}:${BUNDLING_OUTPUT_DIR}/.`,
        outputDir,
      ]);
    } finally {
      // Unlike the upstream volume-copy path, cleanup runs even on a failed
      // build so a stranded helper container and volumes do not accumulate.
      this.tryRemove(["rm", "-f", helperContainer]);
      this.tryRemove(["volume", "rm", inputVolume]);
      this.tryRemove(["volume", "rm", outputVolume]);
    }
  }

  private helperOptions(): string[] {
    const { platform, network, securityOpt } = this.props;
    return [
      ...(platform ? ["--platform", platform] : []),
      ...(network ? ["--network", network] : []),
      ...(securityOpt ? ["--security-opt", securityOpt] : []),
    ];
  }

  private tryRemove(args: string[]): void {
    try {
      dockerExec(args);
    } catch {
      // Best effort: a cleanup failure must not mask the build result.
    }
  }

  private resolveUser(): string {
    if (this.props.user) {
      return this.props.user;
    }
    const uid = process.getuid?.() ?? 1000;
    const gid = process.getgid?.() ?? 1000;
    return `${uid}:${gid}`;
  }
}

/**
 * Resolves the built artifact inside an output directory according to the
 * declared output type.
 */
function determineBundledArtifact(
  outputDir: string,
  outputType: BundlingOutput,
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
