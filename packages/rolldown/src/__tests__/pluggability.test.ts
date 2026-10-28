// Copyright (c) cdktn-io
// SPDX-License-Identifier: MPL-2.0

import { NodejsBundlerDefaults } from "@cdktn/bundler-nodejs-spec";
import { Aspects, TerraformAsset, TerraformStack } from "cdktn";
import { Construct, IConstruct } from "constructs";
import { RolldownBundlerFactory } from "..";
import { DemoNodejsFunction } from "./demo-nodejs-function";
import {
  FakeBundlerFactory,
  cleanupTmp,
  makeProject,
  staged,
  synthApp,
  unzip,
} from "./fixtures";

jest.setTimeout(60_000);
afterEach(cleanupTmp);

const entry = "src/handler.ts";

/** Which tool built a function's staged zip. */
function builtBy(stackDir: string, fn: DemoNodejsFunction): string {
  const code = unzip(staged(stackDir, fn.asset)).get("index.js")!.toString();
  return code.match(/built-by:([\w-]+)/)?.[1] ?? "rolldown";
}

describe("choosing a bundler for an L2 NodejsFunction", () => {
  test("(a) a per-construct bundler wins over the scope default", () => {
    const projectRoot = makeProject();
    let viaDefault!: DemoNodejsFunction;
    let viaProp!: DemoNodejsFunction;
    const { stackDir } = synthApp((stack) => {
      NodejsBundlerDefaults.setDefault(stack, new FakeBundlerFactory("esbuild"));
      viaDefault = new DemoNodejsFunction(stack, "Default", { projectRoot, entry });
      viaProp = new DemoNodejsFunction(stack, "Override", {
        projectRoot,
        entry,
        bundler: new RolldownBundlerFactory({ projectRoot }),
      });
    });

    expect(viaDefault.factory.toolName).toBe("esbuild");
    expect(builtBy(stackDir, viaDefault)).toBe("esbuild");
    expect(viaProp.factory.toolName).toBe("rolldown");
    expect(builtBy(stackDir, viaProp)).toBe("rolldown");
    expect(viaProp.asset.assetHash).not.toBe(viaDefault.asset.assetHash);
  });

  test("(b) a stack-wide default applies to every function under it", () => {
    const projectRoot = makeProject();
    const fns: DemoNodejsFunction[] = [];
    const { stackDir } = synthApp((stack) => {
      NodejsBundlerDefaults.setDefault(
        stack,
        new RolldownBundlerFactory({ projectRoot }),
      );
      const nested = new Construct(stack, "Service");
      fns.push(new DemoNodejsFunction(stack, "A", { projectRoot, entry }));
      fns.push(new DemoNodejsFunction(nested, "B", { projectRoot, entry }));
    });
    for (const fn of fns) {
      expect(fn.factory.toolName).toBe("rolldown");
      expect(builtBy(stackDir, fn)).toBe("rolldown");
    }
    // Same entry and spec through the same tool: one identity.
    expect(fns[0].asset.assetHash).toBe(fns[1].asset.assetHash);
  });

  test("the nearest scope wins: App default < stack default < subtree default", () => {
    const projectRoot = makeProject();
    let inStack!: DemoNodejsFunction;
    let inSubtree!: DemoNodejsFunction;
    let inOtherStack!: DemoNodejsFunction;
    synthApp((stack) => {
      const app = stack.node.scope!;
      NodejsBundlerDefaults.setDefault(app, new FakeBundlerFactory("app-default"));
      NodejsBundlerDefaults.setDefault(stack, new FakeBundlerFactory("stack-default"));
      const subtree = new Construct(stack, "Legacy");
      NodejsBundlerDefaults.setDefault(subtree, new FakeBundlerFactory("subtree-default"));
      inStack = new DemoNodejsFunction(stack, "A", { projectRoot, entry });
      inSubtree = new DemoNodejsFunction(subtree, "B", { projectRoot, entry });
      const other = new TerraformStack(app as Construct, "other");
      inOtherStack = new DemoNodejsFunction(other, "C", { projectRoot, entry });
    });
    expect(inStack.factory.toolName).toBe("stack-default");
    expect(inSubtree.factory.toolName).toBe("subtree-default");
    expect(inOtherStack.factory.toolName).toBe("app-default");
  });

  test("without an override or a default, the L2's own default is used, else it throws", () => {
    const projectRoot = makeProject();
    synthApp((stack) => {
      const fn = new DemoNodejsFunction(
        stack,
        "L2Default",
        { projectRoot, entry },
        new FakeBundlerFactory("l2-default"),
      );
      expect(fn.factory.toolName).toBe("l2-default");
      expect(
        () => new DemoNodejsFunction(stack, "None", { projectRoot, entry }),
      ).toThrow(/No Node.js bundler for stack\/None/);
    });
  });

  test("a default set after the construct is created does not apply to it", () => {
    const projectRoot = makeProject();
    let fn!: DemoNodejsFunction;
    let hashBefore!: string;
    const { stackDir } = synthApp((stack) => {
      fn = new DemoNodejsFunction(
        stack,
        "Fn",
        { projectRoot, entry },
        new RolldownBundlerFactory({ projectRoot }),
      );
      hashBefore = fn.asset.assetHash;
      NodejsBundlerDefaults.setDefault(stack, new FakeBundlerFactory("too-late"));
    });
    expect(fn.asset.assetHash).toBe(hashBefore);
    expect(builtBy(stackDir, fn)).toBe("rolldown");
  });

  test("the L2 can reject options its chosen tool cannot honor", () => {
    const projectRoot = makeProject();
    synthApp((stack) => {
      expect(
        () =>
          new DemoNodejsFunction(stack, "Fn", {
            projectRoot,
            entry,
            bundler: new RolldownBundlerFactory({ projectRoot }),
            bundling: { loader: { ".png": "file" } },
          }),
      ).toThrow(/rolldown bundler cannot honor: loader "file"/);
    });
  });
});

/**
 * Why the default is a construction-time scope walk and not an Aspect: the
 * asset hash is computed in TerraformAsset's constructor (and with OUTPUT
 * hashing, the bundle is built there too). Aspects run during app.synth(),
 * after that. These tests document the failure modes of trying anyway.
 */
describe("an Aspect cannot swap the bundler", () => {
  /** Tries every lever an Aspect has, including private fields. */
  class SwapBundlerAspect {
    public visited = 0;
    constructor(private readonly factory: FakeBundlerFactory) {}
    public visit(node: IConstruct): void {
      if (node instanceof DemoNodejsFunction) {
        this.visited++;
        // There is no public setter; reach into the internals to try.
        const replacement = this.factory.bundler({ entry });
        const asset = node.asset as any;
        asset.bundler = replacement;
        asset.staging.bundler = replacement;
      }
    }
  }

  function synthWithAspect(hashType: "OUTPUT" | "SOURCE") {
    const projectRoot = makeProject();
    const aspect = new SwapBundlerAspect(new FakeBundlerFactory("aspect"));
    let fn!: DemoNodejsFunction;
    let hashAtConstruction!: string;
    const { stackDir } = synthApp((stack) => {
      Aspects.of(stack).add(aspect);
      fn = new DemoNodejsFunction(
        stack,
        "Fn",
        { projectRoot, entry },
        new RolldownBundlerFactory({ projectRoot }),
      );
      if (hashType === "SOURCE") {
        // Same function, but with a SOURCE-hashed asset (build deferred).
        (fn as any).asset = new TerraformAsset(fn, "SourceHashed", {
          path: projectRoot,
          type: (fn.asset as any).type,
          bundler: new RolldownBundlerFactory({ projectRoot }).bundler({ entry }),
        });
      }
      hashAtConstruction = fn.asset.assetHash;
    });
    return { aspect, fn, stackDir, hashAtConstruction };
  }

  test("OUTPUT hashing: the Aspect runs, but hash and artifact were fixed at construction", () => {
    const { aspect, fn, stackDir, hashAtConstruction } = synthWithAspect("OUTPUT");
    expect(aspect.visited).toBe(1);
    expect(fn.asset.assetHash).toBe(hashAtConstruction);
    // The eager build from the constructor is what gets staged.
    expect(builtBy(stackDir, fn)).toBe("rolldown");
  });

  test("SOURCE hashing: hacking private fields changes the bytes but not the hash (stale identity)", () => {
    const { aspect, fn, stackDir, hashAtConstruction } = synthWithAspect("SOURCE");
    expect(aspect.visited).toBe(1);
    expect(fn.asset.assetHash).toBe(hashAtConstruction);
    // The deferred build now runs the swapped bundler, so the staged artifact
    // no longer matches the identity it is published under. This is why the
    // swap must not be attempted after construction at all.
    expect(builtBy(stackDir, fn)).toBe("aspect");
  });
});
