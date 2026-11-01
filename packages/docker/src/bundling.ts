// Copyright (c) cdktn-io
// SPDX-License-Identifier: MPL-2.0

import { randomUUID } from "crypto";
import { mkdtempSync, rmSync } from "fs";
import * as os from "os";
import * as path from "path";
import { dockerExec, runDockerImage } from "./docker";
import type { DockerRunOptions } from "./docker";

/**
 * A docker image referenced from a registry.
 */
export class DockerImage {
  /**
   * Reference an image by name or by name and tag from a registry.
   */
  public static fromRegistry(image: string): DockerImage {
    return new DockerImage(image);
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
