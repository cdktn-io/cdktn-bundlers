// Copyright (c) cdktn-io
// SPDX-License-Identifier: MPL-2.0

import * as fs from "fs";
import * as path from "path";
import {
  AssetHashType,
  AssetType,
  BundleOutputType,
  ExcludeIgnoreStrategy,
} from "cdktn";
import { DereferenceBundler, SymlinkFollow } from "../dereference-bundler";
import {
  assetHash,
  cleanupTmpDirs,
  listTree,
  readZip,
  synthAsset,
  tmpDir,
  writeTree,
} from "./helpers";

afterEach(cleanupTmpDirs);

/**
 * A monorepo-shaped fixture: `app/` is the asset source; `shared/` and
 * `config.json` live beside it and are symlinked in.
 */
function monorepo(): { base: string; app: string } {
  const base = tmpDir();
  writeTree(base, {
    "shared/index.js": "shared v1",
    "shared/lib/deep.js": "deep",
    "config.json": '{"v":1}',
    "app/index.js": "app",
    "app/lib/util.js": "util",
    "app/util-link.js": { link: "lib/util.js" },
    "app/lib-link": { link: "lib" },
    "app/shared": { link: "../shared" },
    "app/config.json": { link: "../config.json" },
  });
  return { base, app: path.join(base, "app") };
}

/** Run the bundler directly, without core, into a fresh output dir. */
function bundleDirect(
  source: string,
  bundler = new DereferenceBundler(),
): string {
  const outputDir = tmpDir("bundler-dereference-direct-");
  const result = bundler.bundle({ source, outputDir });
  expect(result.outputType).toBe(BundleOutputType.DIRECTORY);
  expect(result.path).toBe(outputDir);
  return outputDir;
}

describe("DereferenceBundler", () => {
  test("has no bundlerKey and defaults to EXTERNAL", () => {
    const bundler = new DereferenceBundler();
    expect(bundler.bundlerKey).toBeUndefined();
    expect(bundler.follow).toBe(SymlinkFollow.EXTERNAL);
  });

  // (a)
  describe("a change behind an external link", () => {
    test.each([
      ["DIRECTORY", AssetType.DIRECTORY],
      ["ARCHIVE", AssetType.ARCHIVE],
    ])(
      "changes the OUTPUT hash and the staged content (%s)",
      (_label, type) => {
        const { base, app } = monorepo();
        const config = {
          path: app,
          type,
          assetHashType: AssetHashType.OUTPUT,
          bundler: new DereferenceBundler(),
        };

        const before = synthAsset(config);
        fs.writeFileSync(path.join(base, "shared/index.js"), "shared v2");
        const after = synthAsset({
          ...config,
          bundler: new DereferenceBundler(),
        });

        expect(after.assetHash).not.toEqual(before.assetHash);
        const read = (staged: string) =>
          type === AssetType.ARCHIVE
            ? readZip(staged)["shared/index.js"].data
            : fs.readFileSync(path.join(staged, "shared/index.js"), "utf8");
        expect(read(before.staged)).toBe("shared v1");
        expect(read(after.staged)).toBe("shared v2");
      },
    );

    test("is missed under SOURCE hashing (why OUTPUT is required)", () => {
      const { base, app } = monorepo();
      const config = {
        path: app,
        type: AssetType.ARCHIVE,
        assetHashType: AssetHashType.SOURCE,
        bundler: new DereferenceBundler(),
      };
      const before = synthAsset(config);
      fs.writeFileSync(path.join(base, "shared/index.js"), "shared v2");
      const after = synthAsset({
        ...config,
        bundler: new DereferenceBundler(),
      });

      // Same hash, different bytes: the stale-deploy failure mode.
      expect(after.assetHash).toEqual(before.assetHash);
      expect(readZip(after.staged)["shared/index.js"].data).toBe("shared v2");
    });
  });

  // (b)
  describe("a tree with no external links hashes as it does without a bundler", () => {
    function linkFreeOfExternals(): string {
      const base = tmpDir();
      writeTree(base, {
        "src/index.js": "index",
        "src/lib/a.js": "a",
        "src/lib/nested/b.js": "b",
        "src/empty": { dir: true },
        "src/bin/run.sh": "#!/bin/sh\necho hi\n",
        "src/a-link.js": { link: "lib/a.js" },
        "src/lib-link": { link: "lib" },
        "src/lib/nested/up.js": { link: "../a.js" },
      });
      fs.chmodSync(path.join(base, "src/bin/run.sh"), 0o755);
      return path.join(base, "src");
    }

    const matrix: Array<[string, boolean, AssetType]> = [
      ["canonical, DIRECTORY", true, AssetType.DIRECTORY],
      ["canonical, ARCHIVE", true, AssetType.ARCHIVE],
      ["legacy, DIRECTORY", false, AssetType.DIRECTORY],
      ["legacy, ARCHIVE", false, AssetType.ARCHIVE],
    ];

    test.each(matrix)("%s", (_label, canonical, type) => {
      const src = linkFreeOfExternals();
      const plain = assetHash({ path: src, type }, canonical);
      const bundled = assetHash(
        {
          path: src,
          type,
          assetHashType: AssetHashType.OUTPUT,
          bundler: new DereferenceBundler(),
        },
        canonical,
      );
      expect(bundled).toEqual(plain);
    });

    test.each(matrix)(
      "%s: except an absolute internal link, which is rewritten",
      (_label, canonical, type) => {
        const src = linkFreeOfExternals();
        fs.symlinkSync(
          path.join(src, "lib/a.js"),
          path.join(src, "abs-link.js"),
        );
        const plain = assetHash({ path: src, type }, canonical);
        const bundled = assetHash(
          {
            path: src,
            type,
            assetHashType: AssetHashType.OUTPUT,
            bundler: new DereferenceBundler(),
          },
          canonical,
        );
        expect(bundled).not.toEqual(plain);
      },
    );
  });

  // (c)
  describe("internal links", () => {
    test("are preserved as links under EXTERNAL; external ones are dereferenced", () => {
      const { app } = monorepo();
      expect(listTree(bundleDirect(app))).toEqual({
        "config.json": 'file:{"v":1}',
        "index.js": "file:app",
        lib: "dir",
        "lib/util.js": "file:util",
        "lib-link": "link:lib",
        shared: "dir",
        "shared/index.js": "file:shared v1",
        "shared/lib": "dir",
        "shared/lib/deep.js": "file:deep",
        "util-link.js": "link:lib/util.js",
      });
    });

    test("are dereferenced under ALWAYS", () => {
      const { app } = monorepo();
      const out = bundleDirect(
        app,
        new DereferenceBundler({ follow: SymlinkFollow.ALWAYS }),
      );
      const tree = listTree(out);
      expect(Object.values(tree).some((v) => v.startsWith("link:"))).toBe(
        false,
      );
      expect(tree["util-link.js"]).toBe("file:util");
      expect(tree["lib-link/util.js"]).toBe("file:util");
    });

    test("absolute internal links are rewritten relative and stay valid", () => {
      const { app } = monorepo();
      fs.symlinkSync(
        path.join(app, "lib/util.js"),
        path.join(app, "lib/abs.js"),
      );
      const out = bundleDirect(app);
      expect(fs.readlinkSync(path.join(out, "lib/abs.js"))).toBe("util.js");
      expect(fs.readFileSync(path.join(out, "lib/abs.js"), "utf8")).toBe(
        "util",
      );
    });

    test("a link inside dereferenced content that points back into the source is rewritten for its new location", () => {
      const { base, app } = monorepo();
      // shared/back -> ../app/lib (internal by target, but written relative
      // to shared/, which lands at app-output/shared/).
      fs.symlinkSync("../app/lib", path.join(base, "shared/back"));
      const out = bundleDirect(app);
      expect(fs.readlinkSync(path.join(out, "shared/back"))).toBe("../lib");
      expect(
        fs.readFileSync(path.join(out, "shared/back/util.js"), "utf8"),
      ).toBe("util");
    });
  });

  // (d)
  describe("cycles", () => {
    test("a link to an ancestor throws under ALWAYS, naming the chain", () => {
      const base = tmpDir();
      writeTree(base, { "a/file": "x", "a/link": { link: "../" } });
      expect(() =>
        bundleDirect(
          base,
          new DereferenceBundler({ follow: SymlinkFollow.ALWAYS }),
        ),
      ).toThrow(
        'DereferenceBundler: symlink cycle at "a/link": it leads back to "."',
      );
      expect(() =>
        bundleDirect(
          base,
          new DereferenceBundler({ follow: SymlinkFollow.ALWAYS }),
        ),
      ).toThrow("Chain: . => a => a/link -> ../");
    });

    test("the same link is kept as a link under EXTERNAL", () => {
      const base = tmpDir();
      writeTree(base, { "a/file": "x", "a/link": { link: "../" } });
      expect(fs.readlinkSync(path.join(bundleDirect(base), "a/link"))).toBe(
        "../",
      );
    });

    test("an external link to a directory containing the source throws under EXTERNAL", () => {
      const base = tmpDir();
      writeTree(base, { "app/index.js": "x", "app/up": { link: ".." } });
      expect(() => bundleDirect(path.join(base, "app"))).toThrow(
        /symlink cycle at "up\/app": it leads back to "\." .*Chain: \. => up -> \.\. => up\/app/,
      );
    });

    test("a cycle between external directories throws", () => {
      const base = tmpDir();
      writeTree(base, {
        "app/index.js": "x",
        "app/ext": { link: "../ext" },
        "ext/file": "y",
        "ext/again": { link: "../ext" },
      });
      expect(() => bundleDirect(path.join(base, "app"))).toThrow(
        /symlink cycle at "ext\/again".*Chain: \. => ext -> \.\.\/ext => ext\/again -> \.\.\/ext/,
      );
    });

    test("a loop of links (ELOOP) throws", () => {
      const base = tmpDir();
      writeTree(base, {
        "a.js": { link: "b.js" },
        "b.js": { link: "a.js" },
      });
      expect(() => bundleDirect(base)).toThrow(
        /DereferenceBundler: symlink cycle at symlink "a.js" -> "b.js"/,
      );
    });
  });

  // (e)
  describe("dangling links", () => {
    test.each([SymlinkFollow.EXTERNAL, SymlinkFollow.ALWAYS])(
      "throw with the link path (%s)",
      (follow) => {
        const base = tmpDir();
        writeTree(base, {
          "index.js": "x",
          "lib/missing.js": { link: "../nope.js" },
        });
        expect(() =>
          bundleDirect(base, new DereferenceBundler({ follow })),
        ).toThrow(
          'DereferenceBundler: dangling symlink "lib/missing.js" -> "../nope.js"',
        );
      },
    );

    test("are skipped when ignoreStrategy excludes them", () => {
      const base = tmpDir();
      writeTree(base, {
        "index.js": "x",
        "lib/missing.js": { link: "../nope.js" },
      });
      const out = bundleDirect(
        base,
        new DereferenceBundler({
          ignoreStrategy: new ExcludeIgnoreStrategy(["lib/missing.js"]),
        }),
      );
      expect(listTree(out)).toEqual({ "index.js": "file:x", lib: "dir" });
    });
  });

  // (f)
  describe("ignoreStrategy", () => {
    test("filters the output, matching dereferenced content under the link's path", () => {
      const { base, app } = monorepo();
      writeTree(base, {
        "shared/node_modules/dep/index.js": "dep",
        "shared/index.js.map": "map",
        "app/index.js.map": "map",
      });
      const out = bundleDirect(
        app,
        new DereferenceBundler({
          ignoreStrategy: new ExcludeIgnoreStrategy([
            "*.map",
            "shared/node_modules",
          ]),
        }),
      );
      const tree = listTree(out);
      expect(tree["shared/index.js"]).toBe("file:shared v1");
      expect(Object.keys(tree).filter((k) => k.endsWith(".map"))).toEqual([]);
      expect(tree["shared/node_modules"]).toBeUndefined();
    });

    test("is the C1 workaround: exclusions on the bundler keep escaping links resolvable", () => {
      const { app } = monorepo();
      fs.writeFileSync(path.join(app, "index.js.map"), "map");
      const { staged } = synthAsset({
        path: app,
        type: AssetType.ARCHIVE,
        assetHashType: AssetHashType.OUTPUT,
        bundler: new DereferenceBundler({
          ignoreStrategy: new ExcludeIgnoreStrategy(["*.map"]),
        }),
      });
      const zip = readZip(staged);
      expect(zip["shared/index.js"].data).toBe("shared v1");
      expect(zip["index.js.map"]).toBeUndefined();
    });
  });

  // (g)
  describe("known core issue C1 (documents current cdktn behavior)", () => {
    // When the *asset* sets exclude/ignoreStrategy, core hands the bundler a
    // filtered copy under os.tmpdir() (AssetStaging.filteredSource). Core's
    // copySync recreates links verbatim, so a relative link escaping the
    // source root (`shared -> ../shared`) dangles in that copy. If core is
    // fixed to absolutize escaping links in the filtered copy, this test
    // should flip to expecting success.
    test("asset-level exclude + relative escaping link dangles in the bundler input", () => {
      const { app } = monorepo();
      fs.writeFileSync(path.join(app, "index.js.map"), "map");
      expect(() =>
        synthAsset({
          path: app,
          type: AssetType.ARCHIVE,
          assetHashType: AssetHashType.OUTPUT,
          exclude: ["*.map"],
          bundler: new DereferenceBundler(),
        }),
      ).toThrow(/dangling symlink "config.json" -> "..\/config.json"/);
    });

    test("an absolute escaping link survives the filtered copy", () => {
      const { base } = monorepo();
      const app2 = path.join(base, "app2");
      writeTree(app2, {
        "index.js": "app2",
        "index.js.map": "map",
        shared: { link: path.join(base, "shared") },
      });
      const { staged } = synthAsset({
        path: app2,
        type: AssetType.ARCHIVE,
        assetHashType: AssetHashType.OUTPUT,
        exclude: ["*.map"],
        bundler: new DereferenceBundler(),
      });
      const zip = readZip(staged);
      expect(zip["shared/index.js"].data).toBe("shared v1");
      expect(zip["index.js.map"]).toBeUndefined();
    });
  });

  // (h)
  describe("ARCHIVE contents", () => {
    test("EXTERNAL: external targets are regular entries, internal links stay symlink entries", () => {
      const { app } = monorepo();
      const { staged } = synthAsset({
        path: app,
        type: AssetType.ARCHIVE,
        assetHashType: AssetHashType.OUTPUT,
        bundler: new DereferenceBundler(),
      });
      expect(path.basename(staged)).toBe("archive.zip");
      const zip = readZip(staged);
      expect(
        Object.fromEntries(
          Object.values(zip).map((e) => [e.name, `${e.kind}:${e.data}`]),
        ),
      ).toEqual({
        "config.json": 'file:{"v":1}',
        "index.js": "file:app",
        "lib/util.js": "file:util",
        "lib-link": "symlink:lib",
        "shared/index.js": "file:shared v1",
        "shared/lib/deep.js": "file:deep",
        "util-link.js": "symlink:lib/util.js",
      });
    });

    test("ALWAYS: the archive has no symlink entries", () => {
      const { app } = monorepo();
      const { staged } = synthAsset({
        path: app,
        type: AssetType.ARCHIVE,
        assetHashType: AssetHashType.OUTPUT,
        bundler: new DereferenceBundler({ follow: SymlinkFollow.ALWAYS }),
      });
      const zip = readZip(staged);
      expect(Object.values(zip).every((e) => e.kind === "file")).toBe(true);
      expect(zip["lib-link/util.js"].data).toBe("util");
      expect(zip["util-link.js"].data).toBe("util");
      expect(zip["shared/lib/deep.js"].data).toBe("deep");
    });

    test("preserves the executable bit of dereferenced files", () => {
      const { base, app } = monorepo();
      writeTree(base, { "tools/run.sh": "#!/bin/sh\n" });
      fs.chmodSync(path.join(base, "tools/run.sh"), 0o755);
      fs.symlinkSync("../tools/run.sh", path.join(app, "run.sh"));
      const out = bundleDirect(app);
      expect(fs.statSync(path.join(out, "run.sh")).mode & 0o777).toBe(0o755);
    });
  });

  test("a file source is copied through as a file result", () => {
    const base = tmpDir();
    writeTree(base, { "real.txt": "hi", "link.txt": { link: "real.txt" } });
    const outputDir = tmpDir();
    const result = new DereferenceBundler().bundle({
      source: path.join(base, "link.txt"),
      outputDir,
    });
    expect(result.outputType).toBe(BundleOutputType.FILE);
    expect(result.path).toBe(path.join(outputDir, "link.txt"));
    expect(fs.lstatSync(result.path!).isFile()).toBe(true);
  });
});
