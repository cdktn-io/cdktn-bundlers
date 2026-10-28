// Copyright (c) cdktn-io
// SPDX-License-Identifier: MPL-2.0

import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  INodejsBundlerFactory,
  NodejsBundleOutput,
  NodejsBundleSpec,
} from "@cdktn/bundler-nodejs-spec";
import {
  App,
  BundleOptions,
  BundleResult,
  IAssetBundler,
  TerraformAsset,
  TerraformStack,
} from "cdktn";

const tmpRoots: string[] = [];

export function tmpDir(prefix: string): string {
  // Deliberately not realpath'd: on macOS os.tmpdir() sits behind the
  // /var -> /private/var symlink, which is how real checkouts often look too.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cdktn-rolldown-${prefix}-`));
  tmpRoots.push(dir);
  return dir;
}

export function cleanupTmp(): void {
  for (const dir of tmpRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** A small TS project: an entry, a local import, a node built-in, a lockfile. */
export function makeProject(extraFiles: Record<string, string> = {}): string {
  const root = tmpDir("project");
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ name: "fixture", version: "1.0.0" }),
    "package-lock.json": JSON.stringify({ lockfileVersion: 3, packages: {} }),
    "src/lib/greet.ts":
      "export function greet(name: string): string {\n  return `hello ${name}`;\n}\n",
    "src/handler.ts": [
      'import * as path from "node:path";',
      'import { greet } from "./lib/greet";',
      "export const handler = async (event: { name: string }) => ({",
      "  body: greet(event.name),",
      "  sep: path.sep,",
      "  mode: process.env.NODE_ENV,",
      "});",
      "",
    ].join("\n"),
    ...extraFiles,
  };
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return root;
}

/** Synthesize a fresh App with one stack; returns where the stack was written. */
export function synthApp(build: (stack: TerraformStack) => void): {
  app: App;
  stack: TerraformStack;
  stackDir: string;
} {
  const outdir = tmpDir("out");
  const app = new App({ outdir });
  const stack = new TerraformStack(app, "stack");
  build(stack);
  app.synth();
  return { app, stack, stackDir: path.join(outdir, "stacks", "stack") };
}

/** The staged artifact of an asset after synth. */
export function staged(stackDir: string, asset: TerraformAsset): Buffer {
  return fs.readFileSync(path.join(stackDir, asset.path));
}

export function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Stand-in for a second tool (e.g. a future `@cdktn/bundler-esbuild`): copies
 * the entry verbatim behind a marker comment. Enough to show which factory
 * an L2 resolved without needing esbuild installed.
 */
export class FakeBundlerFactory implements INodejsBundlerFactory {
  constructor(public readonly toolName: string) {}

  public unsupportedOptions(): string[] {
    return [];
  }

  public bundler(spec: NodejsBundleSpec): IAssetBundler {
    const toolName = this.toolName;
    return {
      bundlerKey: `fake:${toolName}:${JSON.stringify(spec)}`,
      bundle(options: BundleOptions): BundleResult {
        const source = fs.readFileSync(
          path.join(options.source, spec.entry),
          "utf8",
        );
        fs.writeFileSync(
          path.join(
            options.outputDir,
            NodejsBundleOutput.entryFileName(spec.format),
          ),
          `/* built-by:${toolName} */\n${source}`,
        );
        return BundleResult.directory(options.outputDir);
      },
    };
  }
}

/** Entries of a zip, read from its central directory (stored or deflated). */
export function unzip(zip: Buffer): Map<string, Buffer> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { inflateRawSync } = require("zlib") as typeof import("zlib");
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(eocd + 10);
  let offset = zip.readUInt32LE(eocd + 16);
  const entries = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const nameLen = zip.readUInt16LE(offset + 28);
    const extraLen = zip.readUInt16LE(offset + 30);
    const commentLen = zip.readUInt16LE(offset + 32);
    const local = zip.readUInt32LE(offset + 42);
    const name = zip.toString("utf8", offset + 46, offset + 46 + nameLen);
    const dataStart =
      local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(dataStart, dataStart + compressedSize);
    entries.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data));
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}
