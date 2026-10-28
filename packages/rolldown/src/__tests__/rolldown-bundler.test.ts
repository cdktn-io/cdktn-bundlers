// Copyright (c) cdktn-io
// SPDX-License-Identifier: MPL-2.0

import * as fs from "fs";
import * as path from "path";
import {
  NodejsOutputFormat,
  NodejsSourceMapMode,
} from "@cdktn/bundler-nodejs-spec";
import { AssetHashType, AssetType, TerraformAsset } from "cdktn";
import { RolldownBundler, RolldownBundlerProps } from "..";
import {
  cleanupTmp,
  makeProject,
  sha256,
  staged,
  synthApp,
  tmpDir,
  unzip,
} from "./fixtures";

// Rolldown runs in a child process per build.
jest.setTimeout(60_000);

afterEach(cleanupTmp);

const ROLLDOWN_VERSION: string = JSON.parse(
  fs.readFileSync(require.resolve("rolldown/package.json"), "utf8"),
).version;

/** Synth one ARCHIVE + OUTPUT TerraformAsset bundled by Rolldown. */
function synthAsset(
  projectRoot: string,
  props: Partial<RolldownBundlerProps> = {},
) {
  let asset!: TerraformAsset;
  const { stackDir } = synthApp((stack) => {
    asset = new TerraformAsset(stack, "Code", {
      path: projectRoot,
      type: AssetType.ARCHIVE,
      assetHashType: AssetHashType.OUTPUT,
      bundler: new RolldownBundler({
        entry: "src/handler.ts",
        projectRoot,
        ...props,
      }),
    });
  });
  const zip = staged(stackDir, asset);
  return { asset, zip, entries: unzip(zip) };
}

describe("RolldownBundler with a real TerraformAsset (AssetHashType.OUTPUT)", () => {
  test("produces a zip holding the bundled entry", () => {
    const project = makeProject();
    const { asset, entries } = synthAsset(project);

    expect(asset.path).toMatch(/^assets\/.+\/[0-9A-F]{32}\/archive\.zip$/);
    expect([...entries.keys()]).toEqual(["index.js"]);
    const code = entries.get("index.js")!.toString();
    // The local import is inlined, the node built-in stays a require.
    expect(code).toContain("hello ");
    expect(code).toMatch(/require\("node:path"\)/);
    expect(code).not.toContain("./lib/greet");
  });

  test("is deterministic: same input, same hash and same zip bytes, across runs and checkout paths", () => {
    const projectA = makeProject();
    const projectB = makeProject(); // identical content at another absolute path
    // Unminified, so Rolldown's `// <module path>` comments are kept.
    const props = { sourceMap: true };

    const first = synthAsset(projectA, props);
    const second = synthAsset(projectA, props);
    const elsewhere = synthAsset(projectB, props);

    expect(second.asset.assetHash).toBe(first.asset.assetHash);
    expect(sha256(second.zip)).toBe(sha256(first.zip));
    // Source map paths are recorded relative to the project root, so a
    // different checkout location does not change a byte.
    expect(elsewhere.asset.assetHash).toBe(first.asset.assetHash);
    expect(sha256(elsewhere.zip)).toBe(sha256(first.zip));
    const code = first.entries.get("index.js")!.toString();
    expect(code).toContain("// src/lib/greet.ts");
    expect(code).not.toContain(projectA);
    const map = JSON.parse(first.entries.get("index.js.map")!.toString());
    expect(map.sources).toEqual(["src/lib/greet.ts", "src/handler.ts"]);
  });

  test("an option change changes the hash", () => {
    const project = makeProject();
    const base = synthAsset(project);
    const minified = synthAsset(project, { minify: true });
    const defined = synthAsset(project, {
      define: { "process.env.NODE_ENV": JSON.stringify("production") },
    });

    expect(minified.asset.assetHash).not.toBe(base.asset.assetHash);
    expect(defined.asset.assetHash).not.toBe(base.asset.assetHash);
    expect(defined.entries.get("index.js")!.toString()).toContain(
      '"production"',
    );
  });

  test("a source change changes the hash; an unrelated file does not", () => {
    const project = makeProject();
    const base = synthAsset(project);

    fs.writeFileSync(path.join(project, "README.md"), "not imported");
    expect(synthAsset(project).asset.assetHash).toBe(base.asset.assetHash);

    fs.writeFileSync(
      path.join(project, "src/lib/greet.ts"),
      "export function greet(name: string): string { return `hi ${name}`; }\n",
    );
    expect(synthAsset(project).asset.assetHash).not.toBe(base.asset.assetHash);
  });

  test("ESM output is written as index.mjs", () => {
    const { entries } = synthAsset(makeProject(), {
      format: NodejsOutputFormat.ESM,
    });
    expect([...entries.keys()]).toEqual(["index.mjs"]);
    expect(entries.get("index.mjs")!.toString()).toMatch(
      /import \* as \w+ from "node:path"|from "node:path"/,
    );
  });

  test("externals are left out; an unresolved import fails the synth", () => {
    const project = makeProject({
      "src/with-sdk.ts":
        'import { client } from "platform-sdk/client";\nexport const handler = () => client;\n',
    });

    const { entries } = synthAsset(project, {
      entry: "src/with-sdk.ts",
      externalModules: ["platform-sdk/*"],
    });
    expect(entries.get("index.js")!.toString()).toContain(
      'require("platform-sdk/client")',
    );

    expect(() => synthAsset(project, { entry: "src/with-sdk.ts" })).toThrow(
      /platform-sdk\/client/,
    );
  });
});

describe("bundlerKey", () => {
  const key = (props: Partial<RolldownBundlerProps>, root = makeProject()) =>
    new RolldownBundler({ entry: "src/handler.ts", projectRoot: root, ...props })
      .bundlerKey!;

  test("names the Rolldown version, the options and the lockfile", () => {
    const bundler = new RolldownBundler({
      entry: "src/handler.ts",
      projectRoot: makeProject(),
    });
    expect(bundler.rolldownVersion).toBe(ROLLDOWN_VERSION);
    expect(bundler.bundlerKey).toContain(`v=${ROLLDOWN_VERSION}`);
    expect(bundler.bundlerKey).toContain('"entry"\\:"src/handler.ts"');
    expect(bundler.bundlerKey).toMatch(/lock=package-lock\.json\\:[0-9a-f]{16}/);
  });

  test("ignores property order and unset options", () => {
    const root = makeProject();
    expect(key({ define: { A: "1", B: "2" } }, root)).toBe(
      key({ define: { B: "2", A: "1" } }, root),
    );
    expect(key({ minify: undefined }, root)).toBe(key({ minify: false }, root));
  });

  test("moves with every option and with the lockfile content", () => {
    const root = makeProject();
    const base = key({}, root);
    for (const change of [
      { target: "node20" },
      { format: NodejsOutputFormat.ESM },
      { minify: true },
      { sourceMap: true },
      { sourceMapMode: NodejsSourceMapMode.INLINE },
      { sourcesContent: false },
      { keepNames: true },
      { banner: "/* b */" },
      { footer: "/* f */" },
      { externalModules: ["x"] },
      { mainFields: ["module", "main"] },
      { loader: { ".sql": "text" } },
      { tsconfig: "tsconfig.build.json" },
      { define: { A: "1" } },
    ] as Partial<RolldownBundlerProps>[]) {
      expect(key(change, root)).not.toBe(base);
    }

    fs.writeFileSync(path.join(root, "package-lock.json"), "{}");
    expect(key({}, root)).not.toBe(base);
  });

  test("finds a lockfile above the project root (monorepos)", () => {
    const repo = tmpDir("repo");
    fs.writeFileSync(path.join(repo, "pnpm-lock.yaml"), "lockfileVersion: 9");
    const pkg = path.join(repo, "packages", "fn");
    fs.mkdirSync(pkg, { recursive: true });
    expect(
      new RolldownBundler({ entry: "index.ts", projectRoot: pkg }).bundlerKey,
    ).toMatch(/lock=pnpm-lock\.yaml\\:/);
  });
});

describe("unsupported options", () => {
  test.each([
    [{ sourceMapMode: NodejsSourceMapMode.BOTH }, /BOTH/],
    [{ loader: { ".png": "file" } }, /loader "file"/],
    [
      { sourceMap: false, sourceMapMode: NodejsSourceMapMode.INLINE },
      /sourceMap is false/,
    ],
  ])("%j is rejected", (props, message) => {
    expect(
      RolldownBundler.unsupportedOptions({ entry: "x.ts", ...props }),
    ).toEqual([expect.stringMatching(message)]);
    expect(
      () => new RolldownBundler({ entry: "x.ts", ...props }),
    ).toThrow(message);
  });
});
