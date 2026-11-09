// Copyright (c) cdktn-io
// SPDX-License-Identifier: MPL-2.0

import { runDockerImage } from "./docker";
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
}
