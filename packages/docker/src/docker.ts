// Copyright (c) cdktn-io
// SPDX-License-Identifier: MPL-2.0

import { spawnSync } from "child_process";
import * as path from "path";

/**
 * The docker binary to invoke.
 *
 * Honours the `CDK_DOCKER` environment variable so an alternative runtime
 * (e.g. `podman`) can be swapped in, matching the convention used by the AWS
 * CDK and TerraConstructs.
 */
function dockerBinary(): string {
  return process.env.CDK_DOCKER ?? "docker";
}

/**
 * Result of a docker invocation.
 */
export interface DockerExecResult {
  /**
   * The process exit status.
   */
  readonly status: number;

  /**
   * The captured standard output.
   */
  readonly stdout: string;
}

/**
 * A single docker container filesystem mount.
 */
export interface DockerVolume {
  /**
   * Absolute path on the host.
   */
  readonly hostPath: string;

  /**
   * Absolute path inside the container.
   */
  readonly containerPath: string;
}

/**
 * Options for {@link DockerImage.run}.
 */
export interface DockerRunOptions {
  /**
   * The command to run in the container, as an argv array.
   *
   * @default - the image's default command
   */
  readonly command?: string[];

  /**
   * The user to run the container as (`-u`).
   *
   * @default - the image's default user
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
   * The working directory inside the container (`-w`).
   *
   * @default - the image's default working directory
   */
  readonly workingDirectory?: string;

  /**
   * Bind mounts to attach to the container.
   *
   * @default - no bind mounts
   */
  readonly volumes?: DockerVolume[];

  /**
   * Containers whose volumes are mounted with `--volumes-from`.
   *
   * @default - none
   */
  readonly volumesFrom?: string[];

  /**
   * The container network to attach to (`--network`).
   *
   * @default - the default docker network
   */
  readonly network?: string;

  /**
   * The platform to run the container as (`--platform`).
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
}

/**
 * Options for {@link dockerExec}.
 */
export interface DockerExecOptions {
  /**
   * Capture standard output instead of forwarding it to standard error.
   *
   * @default false
   */
  readonly captureStdout?: boolean;
}

/**
 * Renders a bind mount as a `--mount` value that tolerates `:`, `,` and `"` in host paths.
 */
export function bindMountSpec(volume: DockerVolume): string {
  const csv = (field: string) =>
    /[",]/.test(field) ? `"${field.replace(/"/g, '""')}"` : field;
  return [
    "type=bind",
    csv(`source=${path.resolve(volume.hostPath)}`),
    csv(`target=${volume.containerPath}`),
  ].join(",");
}

const REDACTED_ASSIGNMENT_FLAGS = new Set(["-e", "--env", "--build-arg"]);
const REDACTED_WHOLE_FLAGS = new Set(["--secret", "--ssh", "--cache-to"]);

function redactAssignment(arg: string): string {
  const eq = arg.indexOf("=");
  return eq === -1 ? arg : `${arg.slice(0, eq)}=***`;
}

/**
 * Renders docker arguments for error messages without secret-bearing values.
 *
 * Redaction is applied to every matching flag in the argument list, including
 * flags inside the user command, so it can over-redact but never under-redact.
 */
export function redactArgs(args: string[]): string[] {
  return args.map((arg, i) => {
    const previous = i > 0 ? args[i - 1] : undefined;
    if (previous && REDACTED_WHOLE_FLAGS.has(previous)) {
      return "***";
    }
    if (previous && REDACTED_ASSIGNMENT_FLAGS.has(previous)) {
      return redactAssignment(arg);
    }
    const eq = arg.indexOf("=");
    if (eq > 0) {
      const flag = arg.slice(0, eq);
      if (REDACTED_WHOLE_FLAGS.has(flag)) {
        return `${flag}=***`;
      }
      if (REDACTED_ASSIGNMENT_FLAGS.has(flag)) {
        return `${flag}=${redactAssignment(arg.slice(eq + 1))}`;
      }
    }
    return arg;
  });
}

/**
 * Throws when an image reference would be parsed by docker as a flag.
 */
export function assertImageReference(image: string): void {
  if (image.startsWith("-")) {
    throw new Error(`Invalid image "${image}": must not start with "-"`);
  }
}

/**
 * Runs a docker command and throws on a non-zero exit.
 *
 * Standard output is forwarded to standard error unless `captureStdout` is set,
 * so long build logs cannot overflow the capture buffer.
 */
export function dockerExec(
  args: string[],
  options: DockerExecOptions = {},
): DockerExecResult {
  const binary = dockerBinary();
  const proc = spawnSync(binary, args, {
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", options.captureStdout ? "pipe" : 2, "inherit"],
  });
  if (proc.error) {
    throw proc.error;
  }
  if (proc.status !== 0) {
    const reason =
      proc.signal != null ? `signal ${proc.signal}` : `status ${proc.status}`;
    throw new Error(
      `${binary} exited with ${reason}\n` +
        `--> Command: ${binary} ${redactArgs(args).join(" ")}`,
    );
  }
  return { status: proc.status ?? 0, stdout: String(proc.stdout ?? "") };
}

/**
 * Run a docker image once with the given options and wait for it to exit.
 *
 * The `DockerImage` class in `./bundling` is the public entry point; this is
 * the shared arg-building/exec step beneath both `fromRegistry` and
 * `fromBuild` images.
 */
export function runDockerImage(
  image: string,
  options: DockerRunOptions = {},
): void {
  assertImageReference(image);
  const args = ["run", "--rm"];
  if (options.securityOpt) {
    args.push("--security-opt", options.securityOpt);
  }
  if (options.user) {
    args.push("-u", options.user);
  }
  for (const [key, value] of Object.entries(options.environment ?? {})) {
    args.push("-e", `${key}=${value}`);
  }
  if (options.workingDirectory) {
    args.push("-w", options.workingDirectory);
  }
  const [entrypointBinary, ...entrypointArgs] = options.entrypoint ?? [];
  if (entrypointBinary) {
    args.push("--entrypoint", entrypointBinary);
  }
  for (const volume of options.volumes ?? []) {
    args.push("--mount", bindMountSpec(volume));
  }
  for (const from of options.volumesFrom ?? []) {
    args.push("--volumes-from", from);
  }
  if (options.network) {
    args.push("--network", options.network);
  }
  if (options.platform) {
    args.push("--platform", options.platform);
  }
  args.push(image, ...entrypointArgs, ...(options.command ?? []));
  dockerExec(args);
}
