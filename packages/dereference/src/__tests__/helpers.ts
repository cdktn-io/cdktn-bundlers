// Copyright (c) cdktn-io
// SPDX-License-Identifier: MPL-2.0

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  App,
  TerraformAsset,
  TerraformAssetConfig,
  TerraformStack,
} from "cdktn";
import { unzipSync, strFromU8 } from "fflate";

const created: string[] = [];

/**
 * A fresh temp directory, resolved to its real path (macOS `/var` is a link
 * to `/private/var`, which would otherwise make every fixture "external").
 */
export function tmpDir(prefix = "bundler-dereference-"): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  created.push(dir);
  return dir;
}

export function cleanupTmpDirs(): void {
  for (const dir of created.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Write a fixture tree. String values are file contents; `{ link }` values
 * are symlinks (target written verbatim); `{ dir: true }` is an empty dir.
 */
export type Entry = string | { link: string } | { dir: true };

export function writeTree(root: string, tree: Record<string, Entry>): void {
  for (const [rel, entry] of Object.entries(tree)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    if (typeof entry === "string") {
      fs.writeFileSync(full, entry);
    } else if ("link" in entry) {
      fs.symlinkSync(entry.link, full);
    } else {
      fs.mkdirSync(full, { recursive: true });
    }
  }
}

export interface SynthResult {
  readonly assetHash: string;
  /** Absolute path of the staged artifact (directory or archive.zip). */
  readonly staged: string;
}

/**
 * Synthesize one `TerraformAsset` in a real `App` and return its hash and the
 * absolute path of what core staged.
 */
export function synthAsset(
  config: TerraformAssetConfig,
  canonical = true,
): SynthResult {
  const outdir = tmpDir("bundler-dereference-out-");
  const app = new App({
    outdir,
    context: { canonicalAssetHashes: canonical },
  });
  const stack = new TerraformStack(app, "s");
  const asset = new TerraformAsset(stack, "fn", config);
  app.synth();
  return {
    assetHash: asset.assetHash,
    staged: path.join(outdir, "stacks", "s", asset.path),
  };
}

/**
 * Hash only (no synth), for comparisons that don't need the staged artifact.
 */
export function assetHash(
  config: TerraformAssetConfig,
  canonical = true,
): string {
  const app = new App({
    outdir: tmpDir("bundler-dereference-out-"),
    context: { canonicalAssetHashes: canonical },
  });
  const stack = new TerraformStack(app, "s");
  return new TerraformAsset(stack, "fn", config).assetHash;
}

export interface ZipEntry {
  readonly name: string;
  /** Unix file type: "file" or "symlink" (from the external attributes). */
  readonly kind: "file" | "symlink" | "other";
  /** File content, or the link target for a symlink entry. */
  readonly data: string;
}

/**
 * Read a zip's entries with their unix file type. fflate's `unzipSync` gives
 * the data but not the external attributes, so the central directory is read
 * directly for those.
 */
export function readZip(file: string): Record<string, ZipEntry> {
  const buf = fs.readFileSync(file);
  const data = unzipSync(new Uint8Array(buf));

  // End of central directory record: last occurrence of its signature.
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) {
    eocd--;
  }
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);

  const out: Record<string, ZipEntry> = {};
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("bad central directory entry");
    }
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const attrs = buf.readUInt32LE(offset + 38);
    const name = buf.toString("utf8", offset + 46, offset + 46 + nameLen);
    const type = (attrs >>> 16) & 0o170000;
    out[name] = {
      name,
      kind:
        type === 0o120000 ? "symlink" : type === 0o100000 ? "file" : "other",
      data: strFromU8(data[name]),
    };
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/**
 * Every entry below `root`, as `relPath -> "file:<content>" | "link:<target>"
 * | "dir"`, sorted, for whole-tree assertions.
 */
export function listTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, prefix: string) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const st = fs.lstatSync(full);
      if (st.isSymbolicLink()) {
        out[rel] = `link:${fs.readlinkSync(full)}`;
      } else if (st.isDirectory()) {
        out[rel] = "dir";
        walk(full, rel);
      } else {
        out[rel] = `file:${fs.readFileSync(full, "utf8")}`;
      }
    }
  };
  walk(root, "");
  return out;
}
