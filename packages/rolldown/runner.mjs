// Copyright (c) cdktn-io
// SPDX-License-Identifier: MPL-2.0
//
// Runs one Rolldown build in a child process, so RolldownBundler.bundle() can
// stay synchronous (IAssetBundler.bundle is sync because jsii cannot await a
// host-language callback) while Rolldown's JS API is async-only and ESM-only.
//
// Adapted from the runner in open-constructs/cdk-terrain#402 (garysassano):
// the JSON-over-stdin request, the native-regex externals and treating
// UNRESOLVED_IMPORT as an error all come from there. Unlike #402 this runner
// writes a plain directory and leaves archiving to cdktn's packaging, and it
// imports the Rolldown the parent resolved instead of its own copy.
//
// Protocol: one JSON request on stdin; exit 0 with the bundle in
// `request.outDir`, or exit 1 with the error on stderr. Nothing is written to
// stdout, which a jsii host process may be using for its kernel protocol (the
// parent also routes this process's stdout away from its own).
import { readFileSync, realpathSync } from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

try {
  const request = JSON.parse(readFileSync(0, "utf8"));
  // Rolldown resolves module ids to real paths and records them (region
  // comments, source maps) relative to cwd. A cwd reached through a symlink
  // (macOS /var -> /private/var, a symlinked checkout) would make those
  // relative paths climb out to the absolute location of the checkout.
  request.cwd = realpathSync(request.cwd);
  request.entry = realpathSync(request.entry);
  const { rolldown } = await import(pathToFileURL(request.rolldownEntry).href);
  const ext = request.format === "esm" ? "mjs" : "js";

  // A trailing "/*" matches subpaths only; a bare name matches itself and its
  // subpaths. Compiled to anchored regexes so the native resolver matches
  // without a JS callback per import (as in #402).
  const external = (request.externalModules ?? []).map((name) => {
    const wildcard = name.endsWith("/*");
    const prefix = (wildcard ? name.slice(0, -1) : name).replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&",
    );
    return new RegExp(`^${prefix}${wildcard ? "" : "(?:/|$)"}`);
  });

  const bundle = await rolldown({
    input: request.entry,
    cwd: request.cwd,
    platform: request.platform,
    external,
    tsconfig: request.tsconfig
      ? path.resolve(request.cwd, request.tsconfig)
      : undefined,
    resolve: request.mainFields ? { mainFields: request.mainFields } : undefined,
    moduleTypes: request.moduleTypes,
    transform: {
      target: request.target,
      define: request.define,
    },
    logLevel: "warn",
    onwarn(warning, warn) {
      // A misspelled dependency must fail the synth, not ship a broken import.
      if (warning.code === "UNRESOLVED_IMPORT") {
        throw new Error(warning.message);
      }
      warn(warning);
    },
  });

  try {
    await bundle.write({
      dir: request.outDir,
      format: request.format,
      entryFileNames: request.entryFileName,
      chunkFileNames: `chunks/[name]-[hash].${ext}`,
      assetFileNames: "assets/[name]-[hash][extname]",
      // One file, like esbuild --bundle without --splitting (and AWS CDK).
      codeSplitting: false,
      minify: request.minify,
      keepNames: request.keepNames,
      banner: request.banner,
      footer: request.footer,
      sourcemap: request.sourcemap,
      sourcemapExcludeSources: request.sourcesContent === false,
      // Record sources relative to the project root rather than to the
      // scratch output dir, so maps are identical on every machine and run.
      sourcemapPathTransform: (relative, mapPath) =>
        path
          .relative(request.cwd, path.resolve(path.dirname(mapPath), relative))
          .split(path.sep)
          .join("/"),
    });
  } finally {
    await bundle.close();
  }
} catch (error) {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
}
