// Copyright (c) cdktn-io
// SPDX-License-Identifier: MPL-2.0

// A minimal, cloud-agnostic stand-in for an L2 `NodejsFunction` (TerraConstructs,
// a GCP or Azure library). It shows how an L2 consumes the shared
// `@cdktn/bundler-nodejs-spec` contract so its users can pick esbuild, Rolldown
// or anything else, per construct or for a whole scope. The cloud-specific
// half (Lambda runtime -> target, `@aws-sdk/*` externals, an S3 upload) is
// reduced to a `runtimeTarget` prop, a default externals list and a
// TerraformOutput.

import {
  INodejsBundlerFactory,
  NodejsBundleOutput,
  NodejsBundleSpec,
  NodejsBundlerDefaults,
} from "@cdktn/bundler-nodejs-spec";
import {
  AssetHashType,
  AssetType,
  TerraformAsset,
  TerraformOutput,
} from "cdktn";
import { Construct } from "constructs";

/** The bundling options an L2 exposes: the shared spec minus `entry`. */
export type DemoBundlingOptions = Omit<NodejsBundleSpec, "entry">;

export interface DemoNodejsFunctionProps {
  /** Project root: the asset source, holding package.json and node_modules. */
  readonly projectRoot: string;
  /** Entry file relative to `projectRoot`. */
  readonly entry: string;
  /** Stands in for an L2's `runtime`, which it would map to a target. */
  readonly runtimeTarget?: string;
  readonly bundling?: DemoBundlingOptions;
  /**
   * (a) Per-construct override. Wins over any scope default.
   * @default - NodejsBundlerDefaults.of(this), else the L2's own default
   */
  readonly bundler?: INodejsBundlerFactory;
}

/** What a real L2 would add for its platform, e.g. `@aws-sdk/*` for Lambda. */
const PLATFORM_DEFAULT_EXTERNALS = ["platform-sdk/*"];

export class DemoNodejsFunction extends Construct {
  public readonly asset: TerraformAsset;
  public readonly factory: INodejsBundlerFactory;
  public readonly handler: string;

  constructor(
    scope: Construct,
    id: string,
    props: DemoNodejsFunctionProps,
    l2DefaultFactory?: INodejsBundlerFactory,
  ) {
    super(scope, id);

    // Resolution happens HERE, in the constructor: TerraformAsset computes its
    // hash (and, under OUTPUT, builds) in its own constructor below, so
    // nothing that runs later (an Aspect, a late setDefault) can change it.
    this.factory = NodejsBundlerDefaults.resolve(
      this,
      props.bundler,
      l2DefaultFactory,
    );

    const spec: NodejsBundleSpec = {
      target: props.runtimeTarget ?? "node22",
      externalModules: PLATFORM_DEFAULT_EXTERNALS,
      ...props.bundling,
      entry: props.entry,
    };
    const unsupported = this.factory.unsupportedOptions(spec);
    if (unsupported.length > 0) {
      throw new Error(
        `${this.node.path}: the ${this.factory.toolName} bundler cannot honor: ${unsupported.join("; ")}`,
      );
    }

    this.asset = new TerraformAsset(this, "Code", {
      path: props.projectRoot,
      type: AssetType.ARCHIVE,
      assetHashType: AssetHashType.OUTPUT,
      bundler: this.factory.bundler(spec),
    });
    this.handler = NodejsBundleOutput.entryFileName(spec.format).replace(
      /\.m?js$/,
      ".handler",
    );

    // Stands in for e.g. aws_lambda_function.filename / source_code_hash.
    new TerraformOutput(this, "CodePath", { value: this.asset.path });
    new TerraformOutput(this, "CodeHash", { value: this.asset.assetHash });
  }
}
