// Copyright (c) cdktn-io
// SPDX-License-Identifier: MPL-2.0

import { Construct, IConstruct } from "constructs";
import { INodejsBundlerFactory } from "./spec";

/**
 * Id of the holder child a default is stored under. Fixed, so a scope holds
 * at most one default and `tryFindChild` finds it without a tree walk.
 */
const HOLDER_ID = "NodejsBundlerDefault";

/**
 * Marks a holder across duplicate copies of this package in `node_modules`,
 * where `instanceof` would fail. `Symbol.for` is process-global.
 */
const HOLDER_SYMBOL = Symbol.for("@cdktn/bundler-nodejs-spec.NodejsBundlerDefault");

/**
 * The construct a scope-wide default is stored on: an empty child of the
 * scope, so the default lives in the construct tree itself (visible in
 * `node.children`, scoped exactly like the tree, and gone with the App).
 */
class DefaultHolder extends Construct {
  public static find(scope: IConstruct): DefaultHolder | undefined {
    const child = scope.node.tryFindChild(HOLDER_ID) as any;
    return child && child[HOLDER_SYMBOL] === true ? child : undefined;
  }

  public factory: INodejsBundlerFactory;

  constructor(scope: IConstruct, factory: INodejsBundlerFactory) {
    super(scope as Construct, HOLDER_ID);
    Object.defineProperty(this, HOLDER_SYMBOL, { value: true });
    this.factory = factory;
  }
}

/**
 * Scope-wide default {@link INodejsBundlerFactory}, resolved at construction
 * time by walking up the construct tree.
 *
 * An asset's hash is computed in its constructor — and with
 * `AssetHashType.OUTPUT` the bundle is even built there — so the bundler has
 * to be known when the L2 construct is created. An `Aspect` runs at synth,
 * after that, and cannot swap it. This class gives L2 libraries the
 * construction-time equivalent instead:
 *
 * ```ts
 * NodejsBundlerDefaults.setDefault(stack, new RolldownBundlerFactory());
 * new MyNodejsFunction(stack, "fn", { entry: "src/handler.ts" }); // uses Rolldown
 * ```
 *
 * The nearest scope wins, so an App-wide default can be overridden per stack
 * or per construct subtree. Set defaults before creating the constructs they
 * should apply to.
 */
export class NodejsBundlerDefaults {
  /**
   * Set the default factory for every Node.js bundle created under `scope`
   * from now on. Replaces a default previously set on the same scope.
   */
  public static setDefault(
    scope: IConstruct,
    factory: INodejsBundlerFactory,
  ): void {
    const existing = DefaultHolder.find(scope);
    if (existing) {
      existing.factory = factory;
    } else {
      new DefaultHolder(scope, factory);
    }
  }

  /**
   * The default factory nearest to `scope` (the scope itself first, then its
   * ancestors), or undefined when none is set.
   */
  public static of(scope: IConstruct): INodejsBundlerFactory | undefined {
    const scopes = scope.node.scopes;
    for (let i = scopes.length - 1; i >= 0; i--) {
      const holder = DefaultHolder.find(scopes[i]);
      if (holder) {
        return holder.factory;
      }
    }
    return undefined;
  }

  /**
   * The factory an L2 should use: an explicit per-construct factory, else
   * the nearest scope default, else `fallback`.
   *
   * Throws when none of the three is available, naming the scope, since an L2
   * that ships no default bundler of its own cannot build anything.
   */
  public static resolve(
    scope: IConstruct,
    bundler?: INodejsBundlerFactory,
    fallback?: INodejsBundlerFactory,
  ): INodejsBundlerFactory {
    const factory = bundler ?? NodejsBundlerDefaults.of(scope) ?? fallback;
    if (!factory) {
      throw new Error(
        `No Node.js bundler for ${scope.node.path}: pass one on the construct, ` +
          `or call NodejsBundlerDefaults.setDefault() on an enclosing scope ` +
          `before creating it.`,
      );
    }
    return factory;
  }

  private constructor() {}
}
