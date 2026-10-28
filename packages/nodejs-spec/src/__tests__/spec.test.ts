// Copyright (c) cdktn-io
// SPDX-License-Identifier: MPL-2.0

import { App, BundleResult, IAssetBundler, TerraformStack } from "cdktn";
import { Construct } from "constructs";
import {
  INodejsBundlerFactory,
  NodejsBundleOutput,
  NodejsBundlerDefaults,
  NodejsOutputFormat,
} from "..";

function factory(toolName: string): INodejsBundlerFactory {
  return {
    toolName,
    unsupportedOptions: () => [],
    bundler: (): IAssetBundler => ({
      bundle: () => BundleResult.declined(),
    }),
  };
}

describe("NodejsBundlerDefaults", () => {
  test("of() returns the nearest default, walking up the tree", () => {
    const app = new App();
    const stack = new TerraformStack(app, "stack");
    const deep = new Construct(new Construct(stack, "a"), "b");
    expect(NodejsBundlerDefaults.of(deep)).toBeUndefined();

    const appDefault = factory("app");
    NodejsBundlerDefaults.setDefault(app, appDefault);
    expect(NodejsBundlerDefaults.of(deep)).toBe(appDefault);

    const stackDefault = factory("stack");
    NodejsBundlerDefaults.setDefault(stack, stackDefault);
    expect(NodejsBundlerDefaults.of(deep)).toBe(stackDefault);
    expect(NodejsBundlerDefaults.of(app)).toBe(appDefault);
  });

  test("setDefault() twice on one scope replaces the default", () => {
    const stack = new TerraformStack(new App(), "stack");
    NodejsBundlerDefaults.setDefault(stack, factory("first"));
    const second = factory("second");
    NodejsBundlerDefaults.setDefault(stack, second);
    expect(NodejsBundlerDefaults.of(stack)).toBe(second);
    expect(stack.node.children.map((c) => c.node.id)).toEqual([
      "NodejsBundlerDefault",
    ]);
  });

  test("resolve() prefers explicit, then scope default, then fallback", () => {
    const stack = new TerraformStack(new App(), "stack");
    const explicit = factory("explicit");
    const fallback = factory("fallback");
    expect(NodejsBundlerDefaults.resolve(stack, undefined, fallback)).toBe(
      fallback,
    );
    const scoped = factory("scoped");
    NodejsBundlerDefaults.setDefault(stack, scoped);
    expect(NodejsBundlerDefaults.resolve(stack, undefined, fallback)).toBe(
      scoped,
    );
    expect(NodejsBundlerDefaults.resolve(stack, explicit, fallback)).toBe(
      explicit,
    );
  });

  test("resolve() throws, naming the scope, when nothing is available", () => {
    const stack = new TerraformStack(new App(), "stack");
    expect(() =>
      NodejsBundlerDefaults.resolve(new Construct(stack, "fn")),
    ).toThrow(/No Node.js bundler for stack\/fn/);
  });

  test("an unrelated child named like the holder is ignored", () => {
    const stack = new TerraformStack(new App(), "stack");
    new Construct(stack, "NodejsBundlerDefault");
    expect(NodejsBundlerDefaults.of(stack)).toBeUndefined();
  });
});

test("NodejsBundleOutput.entryFileName follows AWS CDK's naming", () => {
  expect(NodejsBundleOutput.entryFileName()).toBe("index.js");
  expect(NodejsBundleOutput.entryFileName(NodejsOutputFormat.CJS)).toBe(
    "index.js",
  );
  expect(NodejsBundleOutput.entryFileName(NodejsOutputFormat.ESM)).toBe(
    "index.mjs",
  );
});
