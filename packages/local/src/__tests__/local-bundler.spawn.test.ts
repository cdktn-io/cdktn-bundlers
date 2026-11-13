// Copyright (c) cdktn-io
// SPDX-License-Identifier: MPL-2.0

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { LocalBundler } from "../local-bundler";

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("LocalBundler (real process spawn)", () => {
  let source: string;
  let outputDir: string;

  beforeEach(() => {
    source = tmpDir("bundler-local-spawn-src-");
    outputDir = tmpDir("bundler-local-spawn-out-");
  });

  afterEach(() => {
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  // Regression test for cdktn-io/cdktn-bundlers#14: on Windows, npm/npx/pnpm
  // are `.cmd` shims that `child_process.spawnSync` cannot run without a
  // shell, which a mocked child_process would not catch.
  test("runs npm without declining", () => {
    const bundler = new LocalBundler({ command: ["npm", "--version"] });

    const result = bundler.bundle({ source, outputDir });

    expect(result.isDeclined).toBe(false);
  });
});
