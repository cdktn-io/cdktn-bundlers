// Copyright (c) cdktn-io
// SPDX-License-Identifier: MPL-2.0

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { LocalBundler } from "../local-bundler";
import { spawnSyncCrossPlatform } from "../windows-spawn";

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// These exercise cmd.exe-specific resolution and escaping, so they only
// mean anything run for real on Windows; `windows-spawn.ts`'s non-win32
// path is a thin pass-through already covered by local-bundler.test.ts.
const describeWindows = process.platform === "win32" ? describe : describe.skip;

describeWindows("spawnSyncCrossPlatform on Windows", () => {
  let root: string;

  beforeEach(() => {
    root = tmpDir("windows-spawn-");
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("round-trips tricky arguments through a node_modules/.bin shim unchanged", () => {
    const binDir = path.join(root, "node_modules", ".bin");
    fs.mkdirSync(binDir, { recursive: true });

    const recorderScript = path.join(root, "record-args.js");
    const outFile = path.join(root, "args.json");
    fs.writeFileSync(
      recorderScript,
      'require("fs").writeFileSync(process.env.OUT_FILE, JSON.stringify(process.argv.slice(2)));',
    );
    // A real npm-generated .cmd shim has this same shape: it re-invokes node
    // on a script and forwards its own already-escaped arguments via `%*`.
    fs.writeFileSync(
      path.join(binDir, "echoargs.cmd"),
      `@node "${recorderScript}" %*\n`,
    );

    const args = ["a b", "a&b", 'a"b', "a^b", "a!b", "a%b", "trailing\\", ""];
    const result = spawnSyncCrossPlatform(
      path.join("node_modules", ".bin", "echoargs.cmd"),
      args,
      { cwd: root, env: { ...process.env, OUT_FILE: outFile } },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(outFile, "utf8"))).toEqual(args);
  });

  test("a relative command that exits non-zero throws, rather than being mistaken for a missing toolchain", () => {
    const scriptsDir = path.join(root, "scripts");
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(path.join(scriptsDir, "fail.cmd"), "@exit /b 1\n");

    const bundler = new LocalBundler({ command: ["scripts/fail.cmd"] });

    expect(() =>
      bundler.bundle({ source: root, outputDir: tmpDir("windows-spawn-out-") }),
    ).toThrow(/status 1/);
  });

  test("honours a PATHEXT override passed through `environment`", () => {
    // With `.cmd` excluded, neither this module's own resolution nor
    // cmd.exe's (which inherits the same environment) can find `npm`, so
    // this must decline like a missing toolchain rather than throw.
    const bundler = new LocalBundler({
      command: ["npm", "--version"],
      environment: { PATHEXT: ".EXE" },
    });

    const result = bundler.bundle({
      source: tmpDir("windows-spawn-src-"),
      outputDir: tmpDir("windows-spawn-out-"),
    });

    expect(result.isDeclined).toBe(true);
  });
});
