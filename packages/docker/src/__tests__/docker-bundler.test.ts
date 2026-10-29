// Copyright (c) cdktn-io
// SPDX-License-Identifier: MPL-2.0

import * as child_process from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { BundleOutputType } from "cdktn";
import {
  BUNDLING_INPUT_DIR,
  BUNDLING_OUTPUT_DIR,
  BundlingFileAccess,
  DockerBundler,
} from "../docker-bundler";
import { DockerBuildSecret, DockerImage } from "../bundling";
import { bindMountSpec, dockerExec, redactArgs } from "../docker";

jest.mock("child_process");

const spawnSyncMock = child_process.spawnSync as unknown as jest.Mock;

function mockSpawn(): jest.Mock {
  spawnSyncMock.mockReset();
  spawnSyncMock.mockReturnValue({ status: 0, signal: null, stdout: "" } as any);
  return spawnSyncMock;
}

/** The docker argv of every invocation captured by the mock. */
function invocations(mock: jest.Mock): string[][] {
  return mock.mock.calls.map((call) => call[1] as string[]);
}

describe("DockerBundler bind mount", () => {
  afterEach(() => jest.restoreAllMocks());

  test("runs the image with source and output bind-mounted", () => {
    const spy = mockSpawn();
    const bundler = new DockerBundler({
      image: "alpine",
      command: ["sh", "-c", "build"],
      user: "1000:1000",
    });

    const result = bundler.bundle({ source: "/src", outputDir: "/out" });

    expect(result.outputType).toBe(BundleOutputType.DIRECTORY);
    expect(result.path).toBe("/out");
    const args = invocations(spy)[0];
    expect(args).toContain("run");
    expect(args).toContain("--rm");
    expect(args).toContain(
      `type=bind,source=${path.resolve("/src")},target=${BUNDLING_INPUT_DIR}`,
    );
    expect(args).toContain(
      `type=bind,source=${path.resolve("/out")},target=${BUNDLING_OUTPUT_DIR}`,
    );
    expect(args).toContain("alpine");
    expect(args.slice(-3)).toEqual(["sh", "-c", "build"]);
  });

  test("defaults the user to the host uid:gid", () => {
    const spy = mockSpawn();
    jest.spyOn(process, "getuid").mockReturnValue(501);
    jest.spyOn(process, "getgid").mockReturnValue(20);

    new DockerBundler({ image: "alpine", command: ["build"] }).bundle({
      source: "/src",
      outputDir: "/out",
    });

    const args = invocations(spy)[0];
    const userIdx = args.indexOf("-u");
    expect(args[userIdx + 1]).toBe("501:20");
  });

  test("passes environment, network, platform and security options", () => {
    const spy = mockSpawn();
    new DockerBundler({
      image: "node:20",
      command: ["build"],
      environment: { NODE_ENV: "production" },
      network: "host",
      platform: "linux/amd64",
      securityOpt: "no-new-privileges",
    }).bundle({ source: "/src", outputDir: "/out" });

    const args = invocations(spy)[0];
    expect(args).toContain("NODE_ENV=production");
    expect(args).toContain("--network");
    expect(args).toContain("host");
    expect(args).toContain("--platform");
    expect(args).toContain("linux/amd64");
    expect(args).toContain("--security-opt");
    expect(args).toContain("no-new-privileges");
  });

  test("throws when docker exits non-zero", () => {
    spawnSyncMock.mockReset();
    spawnSyncMock.mockReturnValue({
      status: 1,
      signal: null,
      stderr: "boom",
    } as any);

    expect(() =>
      new DockerBundler({ image: "alpine", command: ["build"] }).bundle({
        source: "/src",
        outputDir: "/out",
      }),
    ).toThrow(/exited with status 1/);
  });
});

describe("DockerBundler volume copy", () => {
  afterEach(() => jest.restoreAllMocks());

  test("creates volumes, copies in and out, and cleans up", () => {
    const spy = mockSpawn();
    const bundler = new DockerBundler({
      image: "alpine",
      command: ["build"],
      bundlingFileAccess: BundlingFileAccess.VOLUME_COPY,
    });

    const result = bundler.bundle({ source: "/src", outputDir: "/out" });

    expect(result.outputType).toBe(BundleOutputType.DIRECTORY);
    expect(result.path).toBe("/out");
    const calls = invocations(spy);
    const flat = calls.map((c) => c.join(" "));
    // The helper container reuses the build image, so no second image is pulled.
    const helperRun = calls.find((c) => c.includes("--name"));
    expect(helperRun).toContain("alpine");
    expect(flat.join("\n")).not.toContain("public.ecr.aws");
    expect(flat.some((c) => c.startsWith("volume create assetInput"))).toBe(
      true,
    );
    expect(flat.some((c) => c.startsWith("volume create assetOutput"))).toBe(
      true,
    );
    expect(flat.some((c) => c.startsWith("cp /src/."))).toBe(true);
    expect(flat.some((c) => c.includes("/asset-output/. /out"))).toBe(true);
    expect(flat.some((c) => c.startsWith("volume rm assetInput"))).toBe(true);
    expect(flat.some((c) => c.startsWith("volume rm assetOutput"))).toBe(true);
  });

  test("cleans up even when the build fails", () => {
    let call = 0;
    spawnSyncMock.mockReset();
    const spy = spawnSyncMock.mockImplementation((_bin: any, args: any) => {
      call += 1;
      // Fail on the build container run (the invocation carrying the image).
      if ((args as string[]).includes("alpine") && call > 3) {
        return { status: 7, signal: null, stderr: "build failed" } as any;
      }
      return { status: 0, signal: null, stdout: "" } as any;
    });

    const bundler = new DockerBundler({
      image: "alpine",
      command: ["build"],
      bundlingFileAccess: BundlingFileAccess.VOLUME_COPY,
    });

    expect(() =>
      bundler.bundle({ source: "/src", outputDir: "/out" }),
    ).toThrow();

    const flat = invocations(spy).map((c) => c.join(" "));
    expect(flat.some((c) => c.startsWith("volume rm assetInput"))).toBe(true);
    expect(flat.some((c) => c.startsWith("volume rm assetOutput"))).toBe(true);
  });
});

describe("DockerBundler volume copy helper image", () => {
  afterEach(() => jest.restoreAllMocks());

  test("defaults the helper container to the build image", () => {
    const spy = mockSpawn();
    new DockerBundler({
      image: "node:20",
      command: ["build"],
      bundlingFileAccess: BundlingFileAccess.VOLUME_COPY,
    }).bundle({ source: "/src", outputDir: "/out" });

    const helperRun = invocations(spy).find((c) => c.includes("--name"));
    expect(helperRun).toContain("node:20");
  });

  test("uses an explicit helper image when given", () => {
    const spy = mockSpawn();
    new DockerBundler({
      image: "myregistry.example.com/build:1",
      command: ["build"],
      bundlingFileAccess: BundlingFileAccess.VOLUME_COPY,
      volumeCopyHelperImage: "myregistry.example.com/busybox:1",
    }).bundle({ source: "/src", outputDir: "/out" });

    const helperRun = invocations(spy).find((c) => c.includes("--name"));
    expect(helperRun).toContain("myregistry.example.com/busybox:1");
  });
});

describe("DockerBundler bundlerKey", () => {
  test("changes with image, command and file access", () => {
    const base = new DockerBundler({ image: "alpine", command: ["build"] });
    const otherImage = new DockerBundler({ image: "node", command: ["build"] });
    const otherCmd = new DockerBundler({ image: "alpine", command: ["make"] });
    const otherAccess = new DockerBundler({
      image: "alpine",
      command: ["build"],
      bundlingFileAccess: BundlingFileAccess.VOLUME_COPY,
    });

    expect(base.bundlerKey).not.toBe(otherImage.bundlerKey);
    expect(base.bundlerKey).not.toBe(otherCmd.bundlerKey);
    expect(base.bundlerKey).not.toBe(otherAccess.bundlerKey);
  });

  test("changes when the helper image is overridden", () => {
    const base = new DockerBundler({
      image: "alpine",
      command: ["build"],
      bundlingFileAccess: BundlingFileAccess.VOLUME_COPY,
    });
    const withHelper = new DockerBundler({
      image: "alpine",
      command: ["build"],
      bundlingFileAccess: BundlingFileAccess.VOLUME_COPY,
      volumeCopyHelperImage: "busybox",
    });

    expect(base.bundlerKey).not.toBe(withHelper.bundlerKey);
  });
});

describe("DockerImage", () => {
  afterEach(() => jest.restoreAllMocks());

  test("fromRegistry keeps the reference", () => {
    expect(DockerImage.fromRegistry("node:20").image).toBe("node:20");
  });

  test("run builds the expected argv order", () => {
    const spy = mockSpawn();
    DockerImage.fromRegistry("alpine").run({
      command: ["echo", "hi"],
      user: "1:1",
      workingDirectory: "/work",
      volumes: [{ hostPath: "/h", containerPath: "/c" }],
    });

    const args = invocations(spy)[0];
    expect(args.slice(0, 2)).toEqual(["run", "--rm"]);
    expect(args).toContain(`type=bind,source=${path.resolve("/h")},target=/c`);
    expect(args[args.indexOf("-w") + 1]).toBe("/work");
    expect(args.slice(-3)).toEqual(["alpine", "echo", "hi"]);
  });

  test("fromBuild runs docker build and tags the result", () => {
    const spy = mockSpawn();

    const image = DockerImage.fromBuild("/project", {
      buildArgs: { FOO: "bar" },
      file: "Dockerfile.build",
      platform: "linux/amd64",
      cacheFrom: [{ type: "registry", params: { ref: "cache:latest" } }],
      cacheTo: { type: "inline" },
    });

    const args = invocations(spy)[0];
    expect(args[0]).toBe("build");
    expect(args).toContain("--build-arg");
    expect(args).toContain("FOO=bar");
    expect(args).toContain("-f");
    expect(args).toContain(path.join("/project", "Dockerfile.build"));
    expect(args).toContain("--platform");
    expect(args).toContain("linux/amd64");
    expect(args).toContain("--cache-from");
    expect(args).toContain("type=registry,ref=cache:latest");
    expect(args).toContain("--cache-to");
    expect(args).toContain("type=inline");
    expect(args[args.length - 1]).toBe("/project");
    expect(image.image).toMatch(/^cdktn-/);
  });

  test("cp creates, copies from and removes a helper container", () => {
    const spy = mockSpawn();

    const destination = DockerImage.fromRegistry("alpine").cp(
      "/asset-output",
      "/dest",
    );

    expect(destination).toBe("/dest");
    const calls = invocations(spy);
    expect(calls[0]).toEqual(
      expect.arrayContaining(["create", "--name", "alpine"]),
    );
    expect(calls[1][0]).toBe("cp");
    expect(calls[1][2]).toBe("/dest");
    expect(calls[2][0]).toBe("rm");
  });
});

afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.CDK_DOCKER;
});

describe("dockerExec", () => {
  test("forwards stdout to stderr by default", () => {
    mockSpawn();
    dockerExec(["info"]);
    expect(spawnSyncMock.mock.calls[0][2].stdio).toEqual([
      "ignore",
      2,
      "inherit",
    ]);
  });

  test("captures stdout on request", () => {
    spawnSyncMock.mockReset();
    spawnSyncMock.mockReturnValue({ status: 0, signal: null, stdout: "out" });
    const result = dockerExec(["info"], { captureStdout: true });
    expect(result).toEqual({ status: 0, stdout: "out" });
    expect(spawnSyncMock.mock.calls[0][2].stdio[1]).toBe("pipe");
  });

  test("honours CDK_DOCKER", () => {
    mockSpawn();
    process.env.CDK_DOCKER = "podman";
    dockerExec(["info"]);
    expect(spawnSyncMock.mock.calls[0][0]).toBe("podman");
  });

  test("rethrows spawn errors", () => {
    spawnSyncMock.mockReset();
    spawnSyncMock.mockReturnValue({ error: new Error("ENOENT") });
    expect(() => dockerExec(["info"])).toThrow("ENOENT");
  });

  test("reports the signal when the process is killed", () => {
    spawnSyncMock.mockReset();
    spawnSyncMock.mockReturnValue({ status: null, signal: "SIGKILL" });
    expect(() => dockerExec(["info"])).toThrow(/signal SIGKILL/);
  });

  test("handles a missing stdout and status", () => {
    spawnSyncMock.mockReset();
    spawnSyncMock.mockReturnValue({ status: 0 });
    expect(dockerExec(["info"]).stdout).toBe("");
  });

  test("redacts environment and build-arg values in errors", () => {
    spawnSyncMock.mockReset();
    spawnSyncMock.mockReturnValue({ status: 2, signal: null });
    let message = "";
    try {
      dockerExec([
        "run",
        "-e",
        "TOKEN=s3cret",
        "--build-arg",
        "PW=hunter2",
        "img",
      ]);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("TOKEN=***");
    expect(message).toContain("PW=***");
    expect(message).not.toContain("s3cret");
    expect(message).not.toContain("hunter2");
  });

  test("redactArgs keeps flag values without an equals sign", () => {
    expect(redactArgs(["-e", "NOVALUE", "x=y"])).toEqual([
      "-e",
      "NOVALUE",
      "x=y",
    ]);
  });
});

describe("entrypoint handling", () => {
  test("bind mount sends only the first element to --entrypoint", () => {
    mockSpawn();
    new DockerBundler({
      image: "img",
      command: ["build"],
      entrypoint: ["sh", "-c"],
    }).bundle({ source: "/s", outputDir: "/o" });
    const args = invocations(spawnSyncMock)[0];
    expect(args[args.indexOf("--entrypoint") + 1]).toBe("sh");
    expect(args.slice(-3)).toEqual(["img", "-c", "build"]);
  });

  test("volume copy sends only the first element to --entrypoint", () => {
    mockSpawn();
    new DockerBundler({
      image: "img",
      command: ["build"],
      entrypoint: ["sh", "-c"],
      bundlingFileAccess: BundlingFileAccess.VOLUME_COPY,
    }).bundle({ source: "/s", outputDir: "/o" });
    const build = invocations(spawnSyncMock).find((a) =>
      a.includes("--volumes-from"),
    )!;
    expect(build[build.indexOf("--entrypoint") + 1]).toBe("sh");
    expect(build.slice(-3)).toEqual(["img", "-c", "build"]);
  });

  test("an empty entrypoint adds no flag", () => {
    mockSpawn();
    DockerImage.fromRegistry("img").run({ entrypoint: [], command: ["x"] });
    expect(invocations(spawnSyncMock)[0]).not.toContain("--entrypoint");
  });
});

describe("run flags", () => {
  test("applies volumesFrom and the default working directory", () => {
    mockSpawn();
    new DockerBundler({
      image: "img",
      command: ["build"],
      bundlingFileAccess: BundlingFileAccess.VOLUME_COPY,
    }).bundle({ source: "/s", outputDir: "/o" });
    const build = invocations(spawnSyncMock).find((a) =>
      a.includes("--volumes-from"),
    )!;
    expect(build[build.indexOf("--volumes-from") + 1]).toMatch(
      /^copyContainer/,
    );
    expect(build[build.indexOf("-w") + 1]).toBe("/asset-input");
  });

  test("uses an explicit working directory", () => {
    mockSpawn();
    new DockerBundler({
      image: "img",
      command: ["build"],
      workingDirectory: "/work",
    }).bundle({ source: "/s", outputDir: "/o" });
    const args = invocations(spawnSyncMock)[0];
    expect(args[args.indexOf("-w") + 1]).toBe("/work");
  });

  test("falls back to 1000:1000 without getuid", () => {
    mockSpawn();
    const original = { uid: process.getuid, gid: process.getgid };
    (process as any).getuid = undefined;
    (process as any).getgid = undefined;
    try {
      new DockerBundler({ image: "img", command: ["b"] }).bundle({
        source: "/s",
        outputDir: "/o",
      });
    } finally {
      process.getuid = original.uid;
      process.getgid = original.gid;
    }
    const args = invocations(spawnSyncMock)[0];
    expect(args[args.indexOf("-u") + 1]).toBe("1000:1000");
  });
});

describe("DockerImage.fromBuild", () => {
  test("renders secrets, ssh, network, target, outputs and build args", () => {
    mockSpawn();
    DockerImage.fromBuild("/p", {
      buildArgs: { A: "1" },
      buildSecrets: { tok: DockerBuildSecret.fromSrc("/tmp/tok") },
      buildSsh: "default",
      networkMode: "host",
      targetStage: "prod",
      outputs: ["type=local,dest=/out"],
      cacheFrom: [{ type: "local" }],
      cacheDisabled: true,
    });
    const args = invocations(spawnSyncMock)[0];
    expect(args[args.indexOf("--secret") + 1]).toBe("id=tok,src=/tmp/tok");
    expect(args[args.indexOf("--ssh") + 1]).toBe("default");
    expect(args[args.indexOf("--network") + 1]).toBe("host");
    expect(args[args.indexOf("--target") + 1]).toBe("prod");
    expect(args[args.indexOf("--output") + 1]).toBe("type=local,dest=/out");
    expect(args[args.indexOf("--cache-from") + 1]).toBe("type=local");
    expect(args).toContain("--no-cache");
  });

  test("omits --no-cache by default", () => {
    mockSpawn();
    DockerImage.fromBuild("/p");
    expect(invocations(spawnSyncMock)[0]).not.toContain("--no-cache");
  });

  test("DockerBuildSecret.fromSrc renders src=", () => {
    expect(DockerBuildSecret.fromSrc("/a")).toBe("src=/a");
  });

  test("tags deterministically from path and options", () => {
    mockSpawn();
    const a = DockerImage.fromBuild("/p", { buildArgs: { A: "1" } });
    const b = DockerImage.fromBuild("/p", { buildArgs: { A: "1" } });
    const c = DockerImage.fromBuild("/p", { buildArgs: { A: "2" } });
    const d = DockerImage.fromBuild("/q", { buildArgs: { A: "1" } });
    expect(a.image).toBe(b.image);
    expect(a.image).not.toBe(c.image);
    expect(a.image).not.toBe(d.image);
    expect(a.toJSON()).toBe(a.image);
  });
});

describe("DockerImage.cp", () => {
  test("does not mask the original error when cleanup fails", () => {
    spawnSyncMock.mockReset();
    spawnSyncMock.mockImplementation((_b: string, args: string[]) => {
      if (args[0] === "cp") return { status: 3, signal: null };
      if (args[0] === "rm") return { status: 4, signal: null };
      return { status: 0, signal: null };
    });
    expect(() => DockerImage.fromRegistry("img").cp("/x", "/d")).toThrow(
      /status 3/,
    );
  });

  test("uses a temp directory when no output path is given", () => {
    mockSpawn();
    const dest = DockerImage.fromRegistry("img").cp("/x");
    expect(dest).toContain("cdktn-docker-cp-");
  });
});

describe("volume copy robustness", () => {
  const props = {
    image: "img",
    command: ["b"],
    bundlingFileAccess: BundlingFileAccess.VOLUME_COPY,
  };

  test("removes the first volume when the second creation fails", () => {
    spawnSyncMock.mockReset();
    spawnSyncMock.mockImplementation((_b: string, args: string[]) => {
      if (
        args[0] === "volume" &&
        args[1] === "create" &&
        args[2].startsWith("assetOutput")
      ) {
        return { status: 1, signal: null };
      }
      return { status: 0, signal: null };
    });
    expect(() =>
      new DockerBundler(props).bundle({ source: "/s", outputDir: "/o" }),
    ).toThrow(/status 1/);
    const flat = invocations(spawnSyncMock).map((a) => a.join(" "));
    expect(flat.some((c) => c.startsWith("volume rm assetInput"))).toBe(true);
  });

  test("runs the helper with --entrypoint sh and -c", () => {
    mockSpawn();
    new DockerBundler(props).bundle({ source: "/s", outputDir: "/o" });
    const helper = invocations(spawnSyncMock).find((a) =>
      a.includes("--name"),
    )!;
    const idx = helper.indexOf("img");
    expect(helper[helper.indexOf("--entrypoint") + 1]).toBe("sh");
    expect(helper[idx + 1]).toBe("-c");
  });

  test("rejects unsafe user values", () => {
    mockSpawn();
    expect(() =>
      new DockerBundler({ ...props, user: "root; rm -rf /" }).bundle({
        source: "/s",
        outputDir: "/o",
      }),
    ).toThrow(/Invalid user/);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  test("accepts uid:gid and names", () => {
    mockSpawn();
    new DockerBundler({ ...props, user: "app.user:grp-1" }).bundle({
      source: "/s",
      outputDir: "/o",
    });
    expect(spawnSyncMock).toHaveBeenCalled();
  });
});

describe("bundlerKey", () => {
  const base = { image: "img", command: ["b"] };

  test("is stable for identical props", () => {
    const props = {
      ...base,
      entrypoint: ["sh"],
      workingDirectory: "/w",
      platform: "linux/arm64",
      user: "1:1",
    };
    expect(new DockerBundler(props).bundlerKey).toBe(
      new DockerBundler({ ...props }).bundlerKey,
    );
  });

  test.each([
    ["entrypoint", { entrypoint: ["sh"] }],
    ["workingDirectory", { workingDirectory: "/w" }],
    ["platform", { platform: "linux/arm64" }],
    ["user", { user: "1:1" }],
    ["environment", { environment: { A: "1" } }],
    ["network", { network: "host" }],
    ["securityOpt", { securityOpt: "no-new-privileges" }],
  ])("differs when %s differs", (_name, extra) => {
    expect(new DockerBundler({ ...base, ...extra }).bundlerKey).not.toBe(
      new DockerBundler(base).bundlerKey,
    );
  });

  test("differs between entrypoint values", () => {
    expect(
      new DockerBundler({ ...base, entrypoint: ["a"] }).bundlerKey,
    ).not.toBe(new DockerBundler({ ...base, entrypoint: ["b"] }).bundlerKey);
  });
});

describe("volume copy helper container", () => {
  afterEach(() => jest.restoreAllMocks());
  const props = {
    image: "img",
    command: ["b"],
    user: "1000:1000",
    bundlingFileAccess: BundlingFileAccess.VOLUME_COPY,
  };
  const helperOf = () =>
    invocations(spawnSyncMock).find((a) => a.includes("--name"))!;

  test("runs as root so chown works on non-root images", () => {
    mockSpawn();
    new DockerBundler(props).bundle({ source: "/s", outputDir: "/o" });
    const helper = helperOf();
    expect(helper[helper.indexOf("-u") + 1]).toBe("0");
    expect(helper.indexOf("-u")).toBeLessThan(helper.indexOf("img"));
  });

  test("applies platform, network and securityOpt", () => {
    mockSpawn();
    new DockerBundler({
      ...props,
      platform: "linux/arm64",
      network: "host",
      securityOpt: "no-new-privileges",
    }).bundle({ source: "/s", outputDir: "/o" });
    const helper = helperOf();
    expect(helper[helper.indexOf("--platform") + 1]).toBe("linux/arm64");
    expect(helper[helper.indexOf("--network") + 1]).toBe("host");
    expect(helper[helper.indexOf("--security-opt") + 1]).toBe(
      "no-new-privileges",
    );
  });

  test("omits optional flags when unset", () => {
    mockSpawn();
    new DockerBundler(props).bundle({ source: "/s", outputDir: "/o" });
    const helper = helperOf();
    expect(helper).not.toContain("--platform");
    expect(helper).not.toContain("--network");
    expect(helper).not.toContain("--security-opt");
  });

  test("copies from an absolute source path", () => {
    mockSpawn();
    new DockerBundler(props).bundle({
      source: "rel/src",
      outputDir: "rel/out",
    });
    const copies = invocations(spawnSyncMock).filter((a) => a[0] === "cp");
    expect(copies[0][1]).toBe(`${path.resolve("rel/src")}/.`);
    expect(copies[1][2]).toBe(path.resolve("rel/out"));
  });

  test("cleans up after the build container fails", () => {
    spawnSyncMock.mockReset();
    let runs = 0;
    spawnSyncMock.mockImplementation((_b: string, args: string[]) => {
      if (args[0] === "run" && ++runs === 2) {
        return { status: 1, signal: null };
      }
      return { status: 0, signal: null };
    });
    expect(() =>
      new DockerBundler(props).bundle({ source: "/s", outputDir: "/o" }),
    ).toThrow(/status 1/);
    const flat = invocations(spawnSyncMock).map((a) => a.join(" "));
    expect(flat.some((c) => c.startsWith("rm -f copyContainer"))).toBe(true);
    expect(flat.some((c) => c.startsWith("volume rm assetInput"))).toBe(true);
    expect(flat.some((c) => c.startsWith("volume rm assetOutput"))).toBe(true);
  });
});

describe("bindMountSpec", () => {
  test("keeps ':' in Windows-style paths in one field", () => {
    const spec = bindMountSpec({
      hostPath: "C:\\work\\src",
      containerPath: "/c",
    });
    expect(spec).toBe(
      `type=bind,source=${path.resolve("C:\\work\\src")},target=/c`,
    );
  });

  test("quotes fields that contain ',' or '\"'", () => {
    const spec = bindMountSpec({ hostPath: '/a,b/"c"', containerPath: "/c" });
    expect(spec).toBe('type=bind,"source=/a,b/""c""",target=/c');
  });

  test("resolves relative host paths to absolute", () => {
    expect(bindMountSpec({ hostPath: "rel", containerPath: "/c" })).toBe(
      `type=bind,source=${path.resolve("rel")},target=/c`,
    );
  });
});

describe("DockerBundlerProps.image", () => {
  test("is run as a registry reference", () => {
    const spy = mockSpawn();
    new DockerBundler({ image: "node:20", command: ["b"], user: "1:1" }).bundle(
      {
        source: "/s",
        outputDir: "/o",
      },
    );
    expect(invocations(spy)[0]).toContain("node:20");
    expect(invocations(spy).some((a) => a[0] === "build")).toBe(false);
  });
});

describe("low-severity hardening", () => {
  test("helper image does not change the key under BIND_MOUNT", () => {
    const base = new DockerBundler({ image: "alpine", command: ["b"] });
    const withHelper = new DockerBundler({
      image: "alpine",
      command: ["b"],
      volumeCopyHelperImage: "busybox",
    });
    expect(base.bundlerKey).toBe(withHelper.bundlerKey);
  });

  test("rejects a user that starts with a dash", () => {
    mockSpawn();
    expect(() =>
      new DockerBundler({
        image: "img",
        command: ["b"],
        user: "--dereference",
        bundlingFileAccess: BundlingFileAccess.VOLUME_COPY,
      }).bundle({ source: "/s", outputDir: "/o" }),
    ).toThrow(/Invalid user/);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  test("rejects image references that start with a dash", () => {
    expect(() => new DockerBundler({ image: "-v", command: ["b"] })).toThrow(
      /Invalid image/,
    );
    expect(
      () =>
        new DockerBundler({
          image: "img",
          command: ["b"],
          volumeCopyHelperImage: "--privileged",
        }),
    ).toThrow(/Invalid image/);
    expect(() => DockerImage.fromRegistry("-x").run()).toThrow(/Invalid image/);
  });

  test("redactArgs covers --env, combined forms, --secret, --ssh and --cache-to", () => {
    expect(
      redactArgs([
        "--env",
        "A=1",
        "-e=B=2",
        "--env=C=3",
        "--build-arg=D=4",
        "--secret",
        "id=t,src=/p",
        "--ssh",
        "default=/k",
        "--cache-to",
        "type=registry,token=x",
        "--secret=id=u",
        "img",
      ]),
    ).toEqual([
      "--env",
      "A=***",
      "-e=B=***",
      "--env=C=***",
      "--build-arg=D=***",
      "--secret",
      "***",
      "--ssh",
      "***",
      "--cache-to",
      "***",
      "--secret=***",
      "img",
    ]);
  });

  test("dockerExec raises the stdout buffer limit", () => {
    mockSpawn();
    dockerExec(["info"], { captureStdout: true });
    expect(spawnSyncMock.mock.calls[0][2].maxBuffer).toBeGreaterThan(
      1024 * 1024,
    );
  });

  test("bundle throws, and does not decline, when docker is missing", () => {
    spawnSyncMock.mockReset();
    spawnSyncMock.mockReturnValue({ error: new Error("spawn docker ENOENT") });
    expect(() =>
      new DockerBundler({ image: "img", command: ["b"] }).bundle({
        source: "/s",
        outputDir: "/o",
      }),
    ).toThrow(/ENOENT/);
  });

  test("cp removes its temp directory when the copy fails", () => {
    const leftovers = () =>
      fs
        .readdirSync(os.tmpdir())
        .filter((n) => n.startsWith("cdktn-docker-cp-"));
    const before = leftovers();
    spawnSyncMock.mockReset();
    spawnSyncMock.mockImplementation((_b: string, args: string[]) => ({
      status: args[0] === "cp" ? 3 : 0,
      signal: null,
    }));
    expect(() => DockerImage.fromRegistry("img").cp("/x")).toThrow(/status 3/);
    expect(leftovers()).toEqual(before);
  });
});
