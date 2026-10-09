// Copyright (c) cdktn-io
// SPDX-License-Identifier: MPL-2.0
//
// Release helper for the packages/* workspace. Subcommands:
//
//   check     validate every package.json against the repository's naming and
//             publishing conventions (docs/adding-a-package.md), and that
//             release-please's config and manifest list exactly packages/*
//   collect   merge each package's jsii-pacmak output (packages/*/dist/<lang>)
//             into dist/<lang> and write dist/manifest.json
//   plan      ask each registry which collected artifacts are already
//             published; with --prune, delete those from dist/ (Go excepted).
//             Prints a Markdown summary and, under GitHub Actions, sets one
//             `<target>=true|false` output per target that has work to do.
//
// Every release builds and plans *all* packages: publib-golang replaces every
// module in cdktn-bundlers-go on each push (tags of unchanged versions are
// skipped), and publib-maven skips a whole bundle if any artifact in it is
// already published -- so a partial dist/ would delete Go modules, and an
// unpruned dist/java would silently publish nothing new.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const PACKAGES = path.join(ROOT, "packages");
const DIST = path.join(ROOT, "dist");
const MANIFEST = path.join(DIST, "manifest.json");
const RP_CONFIG = path.join(ROOT, "release-please-config.json");
const RP_MANIFEST = path.join(ROOT, ".release-please-manifest.json");

const REPO_URL = "https://github.com/cdktn-io/cdktn-bundlers.git";
const GO_REPO = "github.com/cdktn-io/cdktn-bundlers-go";
const TARGETS = ["js", "python", "java", "dotnet", "go"];

const pascal = (name) =>
  name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");

/** The coordinates a package in packages/<dir> must publish under. */
function expectedCoordinates(dir) {
  return {
    name: `@cdktn/bundler-${dir}`,
    python: {
      distName: `cdktn-bundler-${dir}`,
      module: `cdktn_bundler_${dir.replaceAll("-", "_")}`,
    },
    java: {
      package: `io.cdktn.bundler.${dir.replaceAll("-", "")}`,
      maven: { groupId: "io.cdktn", artifactId: `cdktn-bundler-${dir}` },
    },
    dotnet: {
      namespace: `Io.Cdktn.Bundler.${pascal(dir)}`,
      packageId: `Io.Cdktn.Bundler.${pascal(dir)}`,
    },
    go: { moduleName: GO_REPO, packageName: dir.replaceAll("-", "") },
  };
}

function packageDirs() {
  if (!fs.existsSync(PACKAGES)) return [];
  return fs
    .readdirSync(PACKAGES, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

function readPackage(dir) {
  return JSON.parse(
    fs.readFileSync(path.join(PACKAGES, dir, "package.json"), "utf8"),
  );
}

function check() {
  const errors = [];
  const dirs = packageDirs();
  const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
  const rpPackages = Object.keys(readJson(RP_CONFIG).packages).sort();
  const rpVersions = readJson(RP_MANIFEST);
  const wantPaths = dirs.map((dir) => `packages/${dir}`);
  for (const [file, paths] of [
    ["release-please-config.json packages", rpPackages],
    [".release-please-manifest.json", Object.keys(rpVersions).sort()],
  ]) {
    if (JSON.stringify(paths) !== JSON.stringify(wantPaths)) {
      errors.push(
        `${file} lists ${JSON.stringify(paths)}, expected ${JSON.stringify(wantPaths)}`,
      );
    }
  }
  for (const dir of dirs) {
    const where = `packages/${dir}/package.json`;
    if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(dir)) {
      errors.push(`packages/${dir}: directory name must be lower-kebab-case`);
      continue;
    }
    if (!fs.existsSync(path.join(PACKAGES, dir, "package.json"))) {
      errors.push(`${where}: missing`);
      continue;
    }
    const pkg = readPackage(dir);
    const want = expectedCoordinates(dir);
    const targets = pkg.jsii?.targets ?? {};
    const expect = (label, actual, expected) => {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        errors.push(
          `${where}: ${label} is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
        );
      }
    };
    expect("name", pkg.name, want.name);
    // release-please owns versions; a hand edit would desync the manifest.
    expect("version", pkg.version, rpVersions[`packages/${dir}`]);
    expect("private", pkg.private ?? false, false);
    expect("license", pkg.license, "MPL-2.0");
    // npm provenance is rejected unless repository.url matches the repository
    // the publishing workflow runs in.
    expect("repository", pkg.repository, {
      type: "git",
      url: REPO_URL,
      directory: `packages/${dir}`,
    });
    expect("jsii.outdir", pkg.jsii?.outdir, "dist");
    expect("jsii.targets.python", targets.python, want.python);
    expect("jsii.targets.java", targets.java, want.java);
    expect("jsii.targets.dotnet", targets.dotnet, want.dotnet);
    expect("jsii.targets.go", targets.go, want.go);
  }
  if (errors.length > 0) {
    for (const e of errors) console.error(`::error::${e}`);
    process.exit(1);
  }
  console.log(`${dirs.length} package(s) follow the conventions`);
}

/** Paths under `root`, relative to it, of the entries directly inside `sub`. */
function entries(root, sub) {
  const dir = path.join(root, sub);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).map((f) => path.posix.join(sub, f));
}

function collect() {
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });
  const manifest = [];
  for (const dir of packageDirs()) {
    const pkg = readPackage(dir);
    const { python, java, dotnet, go } = pkg.jsii.targets;
    const pkgDist = path.join(PACKAGES, dir, "dist");
    // The whole artifact directory: pacmak writes maven-metadata.xml beside
    // the version directory, and a pruned artifact must not leave it behind.
    const javaArtifactDir = path.posix.join(
      "java",
      ...java.maven.groupId.split("."),
      java.maven.artifactId,
    );
    const artifacts = {
      js: entries(pkgDist, "js"),
      python: entries(pkgDist, "python"),
      java: fs.existsSync(path.join(pkgDist, javaArtifactDir, pkg.version))
        ? [javaArtifactDir]
        : [],
      dotnet: entries(pkgDist, "dotnet"),
      go: fs.existsSync(path.join(pkgDist, "go", go.packageName))
        ? [path.posix.join("go", go.packageName)]
        : [],
    };
    for (const target of TARGETS) {
      if (artifacts[target].length === 0) {
        throw new Error(`packages/${dir}: jsii-pacmak produced no ${target} output`);
      }
    }
    for (const target of TARGETS) {
      if (fs.existsSync(path.join(pkgDist, target))) {
        fs.cpSync(path.join(pkgDist, target), path.join(DIST, target), {
          recursive: true,
          errorOnExist: true,
          force: false,
        });
      }
    }
    manifest.push({
      dir,
      name: pkg.name,
      version: pkg.version,
      python: python.distName,
      maven: java.maven,
      nuget: dotnet.packageId,
      go: go.packageName,
      artifacts,
    });
  }
  fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`collected ${manifest.length} package(s) into dist/`);
}

/** true if `url` answers 200, false on 404; anything else is an error. */
async function exists(url, method = "GET") {
  const res = await fetch(url, { method, redirect: "follow" });
  if (res.status === 200) return true;
  if (res.status === 404) return false;
  throw new Error(`${method} ${url}: unexpected HTTP ${res.status}`);
}

function goTags() {
  const out = execFileSync("git", ["ls-remote", "--tags", `https://${GO_REPO}.git`], {
    encoding: "utf8",
  });
  return new Set(
    out
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("\t")[1].replace(/^refs\/tags\//, "").replace(/\^\{\}$/, "")),
  );
}

// publib-golang's tag for a module (no /vN major suffix in the directory part).
const goTag = (pkg) => `${pkg.go}/v${pkg.version}`;

async function plan({ prune }) {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  const tags = manifest.length > 0 ? goTags() : new Set();
  const rows = [];
  const pending = Object.fromEntries(TARGETS.map((t) => [t, false]));

  for (const pkg of manifest) {
    const { groupId, artifactId } = pkg.maven;
    const nugetId = pkg.nuget.toLowerCase();
    const published = {
      js: await exists(
        `https://registry.npmjs.org/${pkg.name.replace("/", "%2f")}/${pkg.version}`,
      ),
      python: await exists(`https://pypi.org/pypi/${pkg.python}/${pkg.version}/json`),
      // Maven Central can take ~30 min to show a fresh release here; a plan in
      // that window re-stages it, and publib-maven then skips the bundle.
      java: await exists(
        `https://repo1.maven.org/maven2/${groupId.replaceAll(".", "/")}/${artifactId}/${pkg.version}/${artifactId}-${pkg.version}.pom`,
        "HEAD",
      ),
      dotnet: await exists(
        `https://api.nuget.org/v3-flatcontainer/${nugetId}/${pkg.version.toLowerCase()}/${nugetId}.${pkg.version.toLowerCase()}.nupkg`,
        "HEAD",
      ),
      go: tags.has(goTag(pkg)),
    };
    for (const target of TARGETS) {
      if (!published[target]) {
        pending[target] = true;
      } else if (prune && target !== "go") {
        for (const artifact of pkg.artifacts[target]) {
          fs.rmSync(path.join(DIST, artifact), { recursive: true, force: true });
        }
      }
    }
    rows.push(
      `| \`${pkg.name}\` | ${pkg.version} | ${TARGETS.map((t) => (published[t] ? "published" : "**publish**")).join(" | ")} |`,
    );
  }

  const summary =
    manifest.length === 0
      ? "No packages under `packages/` -- nothing to release.\n"
      : [
          "| package | version | npm | PyPI | Maven | NuGet | Go |",
          "| --- | --- | --- | --- | --- | --- | --- |",
          ...rows,
          "",
        ].join("\n");
  process.stdout.write(summary);

  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      TARGETS.map((t) => `${t}=${pending[t]}\n`).join(""),
    );
  }
}

const [command, ...args] = process.argv.slice(2);
switch (command) {
  case "check":
    check();
    break;
  case "collect":
    collect();
    break;
  case "plan":
    await plan({ prune: args.includes("--prune") });
    break;
  default:
    console.error("usage: release.mjs check | collect | plan [--prune]");
    process.exit(2);
}
