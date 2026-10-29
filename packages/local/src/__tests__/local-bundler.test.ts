// Copyright (c) cdktn-io
// SPDX-License-Identifier: MPL-2.0

import * as child_process from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { BundleOutputType } from "cdktn";
import {
  BundlingOutput,
  LocalBundler,
  determineBundledArtifact,
} from "../local-bundler";

jest.mock("child_process");

const spawnSyncMock = child_process.spawnSync as unknown as jest.Mock;

function mockSpawn(result: {
  status?: number | null;
  signal?: string | null;
  stdout?: string;
  stderr?: string;
  error?: Error;
}): jest.Mock {
  spawnSyncMock.mockReset();
  spawnSyncMock.mockReturnValue(result as any);
  return spawnSyncMock;
}

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("LocalBundler", () => {
  let source: string;
  let outputDir: string;

  beforeEach(() => {
    source = tmpDir("bundler-local-src-");
    outputDir = tmpDir("bundler-local-out-");
    fs.writeFileSync(path.join(source, "index.ts"), "export const x = 1;");
  });

  afterEach(() => {
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  test("runs the command with the input and output dirs in the environment", () => {
    const bundler = new LocalBundler({
      command: ["sh", "-c", "true"],
      environment: { FOO: "bar" },
      outputType: BundlingOutput.NOT_ARCHIVED,
    });

    const spy = mockSpawn({ status: 0, signal: null });

    const result = bundler.bundle({ source, outputDir });

    expect(result.outputType).toBe(BundleOutputType.DIRECTORY);
    expect(result.path).toBe(outputDir);
    const [program, args, options] = spy.mock.calls[0];
    expect(program).toBe("sh");
    expect(args).toEqual(["-c", "true"]);
    expect(options?.cwd).toBe(source);
    expect(options?.env).toMatchObject({
      FOO: "bar",
      ASSET_INPUT_DIR: source,
      ASSET_OUTPUT_DIR: outputDir,
    });
  });

  test("defaults the working directory to the source", () => {
    const bundler = new LocalBundler({ command: ["sh", "-c", "true"] });
    const spy = mockSpawn({ status: 0, signal: null });

    bundler.bundle({ source, outputDir });

    expect(spy.mock.calls[0][2]?.cwd).toBe(source);
  });

  test("honours an explicit working directory", () => {
    const workingDirectory = tmpDir("bundler-local-cwd-");
    try {
      const bundler = new LocalBundler({
        command: ["sh", "-c", "true"],
        workingDirectory,
      });
      const spy = mockSpawn({ status: 0, signal: null });

      bundler.bundle({ source, outputDir });

      expect(spy.mock.calls[0][2]?.cwd).toBe(workingDirectory);
    } finally {
      fs.rmSync(workingDirectory, { recursive: true, force: true });
    }
  });

  test("throws, rather than declines, when the working directory is missing", () => {
    const bundler = new LocalBundler({
      command: ["sh", "-c", "true"],
      workingDirectory: "/no/such/dir",
    });
    const spy = mockSpawn({ status: 0, signal: null });

    expect(() => bundler.bundle({ source, outputDir })).toThrow(
      /working directory does not exist: \/no\/such\/dir/,
    );
    expect(spy).not.toHaveBeenCalled();
  });

  test("throws when the command exits non-zero", () => {
    const bundler = new LocalBundler({ command: ["sh", "-c", "exit 3"] });
    mockSpawn({ status: 3, signal: null, stdout: "out", stderr: "boom" });

    expect(() => bundler.bundle({ source, outputDir })).toThrow(/status 3/);
  });

  test("throws when the command is killed by a signal", () => {
    const bundler = new LocalBundler({ command: ["sh", "-c", "true"] });
    mockSpawn({ status: null, signal: "SIGKILL" });

    expect(() => bundler.bundle({ source, outputDir })).toThrow(
      /signal SIGKILL/,
    );
  });

  test("declines when the toolchain is missing (ENOENT)", () => {
    const bundler = new LocalBundler({ command: ["does-not-exist"] });
    const error: NodeJS.ErrnoException = new Error("spawn ENOENT");
    error.code = "ENOENT";
    mockSpawn({ error });

    const result = bundler.bundle({ source, outputDir });

    expect(result.isDeclined).toBe(true);
  });

  test("declines when the command is not executable (EACCES)", () => {
    const bundler = new LocalBundler({ command: ["not-executable"] });
    const error: NodeJS.ErrnoException = new Error("spawn EACCES");
    error.code = "EACCES";
    mockSpawn({ error });

    expect(bundler.bundle({ source, outputDir }).isDeclined).toBe(true);
  });

  test("propagates other spawn errors", () => {
    const bundler = new LocalBundler({ command: ["sh", "-c", "true"] });
    const error: NodeJS.ErrnoException = new Error("EMFILE");
    error.code = "EMFILE";
    mockSpawn({ error });

    expect(() => bundler.bundle({ source, outputDir })).toThrow(/EMFILE/);
  });

  test("returns a file result when the command produces a single file", () => {
    const bundler = new LocalBundler({
      command: ["sh", "-c", "true"],
      outputType: BundlingOutput.SINGLE_FILE,
    });
    mockSpawn({ status: 0, signal: null });
    fs.writeFileSync(path.join(outputDir, "bundle.zip"), "z");

    const result = bundler.bundle({ source, outputDir });

    expect(result.outputType).toBe(BundleOutputType.FILE);
    expect(result.path).toBe(path.join(outputDir, "bundle.zip"));
  });

  test("throws when the output directory is missing", () => {
    const bundler = new LocalBundler({ command: ["sh", "-c", "true"] });
    mockSpawn({ status: 0, signal: null });
    fs.rmSync(outputDir, { recursive: true, force: true });

    expect(() => bundler.bundle({ source, outputDir })).toThrow(
      /did not create the output directory/,
    );
  });

  describe("bundlerKey", () => {
    test("is stable for the same configuration", () => {
      const props = {
        command: ["sh", "-c", "build"],
        environment: { A: "1" },
      };
      expect(new LocalBundler(props).bundlerKey).toBe(
        new LocalBundler(props).bundlerKey,
      );
    });

    test("changes when the command changes", () => {
      const a = new LocalBundler({ command: ["sh", "-c", "a"] });
      const b = new LocalBundler({ command: ["sh", "-c", "b"] });
      expect(a.bundlerKey).not.toBe(b.bundlerKey);
    });

    test("changes when the environment changes", () => {
      const a = new LocalBundler({
        command: ["sh", "-c", "build"],
        environment: { A: "1" },
      });
      const b = new LocalBundler({
        command: ["sh", "-c", "build"],
        environment: { A: "2" },
      });
      expect(a.bundlerKey).not.toBe(b.bundlerKey);
    });

    test("changes when extraHash changes", () => {
      const a = new LocalBundler({
        command: ["sh", "-c", "b"],
        extraHash: "1",
      });
      const b = new LocalBundler({
        command: ["sh", "-c", "b"],
        extraHash: "2",
      });
      expect(a.bundlerKey).not.toBe(b.bundlerKey);
    });

    test("changes when the output type changes", () => {
      const a = new LocalBundler({
        command: ["sh", "-c", "b"],
        outputType: BundlingOutput.NOT_ARCHIVED,
      });
      const b = new LocalBundler({
        command: ["sh", "-c", "b"],
        outputType: BundlingOutput.SINGLE_FILE,
      });
      expect(a.bundlerKey).not.toBe(b.bundlerKey);
    });

    test("changes when the working directory changes", () => {
      const a = new LocalBundler({
        command: ["sh", "-c", "build"],
        workingDirectory: "./app-v1",
      });
      const b = new LocalBundler({
        command: ["sh", "-c", "build"],
        workingDirectory: "./app-v2",
      });
      expect(a.bundlerKey).not.toBe(b.bundlerKey);
    });

    test("does not collide an environment entry with an extraHash", () => {
      const withEnv = new LocalBundler({
        command: ["b"],
        environment: { A: "1" },
      });
      const withHash = new LocalBundler({ command: ["b"], extraHash: "A=1" });
      expect(withEnv.bundlerKey).not.toBe(withHash.bundlerKey);
    });

    test("does not collide an environment key named extra with extraHash", () => {
      const withEnv = new LocalBundler({
        command: ["b"],
        environment: { extra: "1" },
      });
      const withHash = new LocalBundler({ command: ["b"], extraHash: "1" });
      expect(withEnv.bundlerKey).not.toBe(withHash.bundlerKey);
    });
  });

  describe("outputFileName", () => {
    test("is undefined by default", () => {
      expect(
        new LocalBundler({ command: ["sh", "-c", "true"] }).outputFileName,
      ).toBeUndefined();
    });

    test("is exposed when set", () => {
      const bundler = new LocalBundler({
        command: ["sh", "-c", "true"],
        outputFileName: "lambda.zip",
      });
      expect(bundler.outputFileName).toBe("lambda.zip");
    });
  });
});

describe("determineBundledArtifact", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir("bundler-local-artifact-");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("NOT_ARCHIVED returns the directory", () => {
    fs.writeFileSync(path.join(dir, "a.txt"), "a");
    expect(determineBundledArtifact(dir, BundlingOutput.NOT_ARCHIVED)).toBe(
      dir,
    );
  });

  test("SINGLE_FILE returns the single file", () => {
    fs.writeFileSync(path.join(dir, "bundle.zip"), "z");
    expect(determineBundledArtifact(dir, BundlingOutput.SINGLE_FILE)).toBe(
      path.join(dir, "bundle.zip"),
    );
  });

  test("SINGLE_FILE throws when there is no file", () => {
    fs.mkdirSync(path.join(dir, "sub"));
    expect(() =>
      determineBundledArtifact(dir, BundlingOutput.SINGLE_FILE),
    ).toThrow(/exactly one file.*found 0/);
  });

  test("SINGLE_FILE throws when there is more than one file", () => {
    fs.writeFileSync(path.join(dir, "bundle.zip"), "z");
    fs.writeFileSync(path.join(dir, "bundle.zip.sha256"), "h");
    expect(() =>
      determineBundledArtifact(dir, BundlingOutput.SINGLE_FILE),
    ).toThrow(/exactly one file.*found 2/);
  });

  test("ARCHIVED throws when there is more than one file", () => {
    fs.writeFileSync(path.join(dir, "a.zip"), "a");
    fs.writeFileSync(path.join(dir, "b.zip"), "b");
    expect(() =>
      determineBundledArtifact(dir, BundlingOutput.ARCHIVED),
    ).toThrow(/exactly one file/);
  });

  test("AUTO_DISCOVER returns the file when it is the only entry", () => {
    fs.writeFileSync(path.join(dir, "only.js"), "j");
    expect(determineBundledArtifact(dir, BundlingOutput.AUTO_DISCOVER)).toBe(
      path.join(dir, "only.js"),
    );
  });

  test("AUTO_DISCOVER returns the directory when there are several entries", () => {
    fs.writeFileSync(path.join(dir, "a.js"), "a");
    fs.writeFileSync(path.join(dir, "b.js"), "b");
    expect(determineBundledArtifact(dir, BundlingOutput.AUTO_DISCOVER)).toBe(
      dir,
    );
  });
});
