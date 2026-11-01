# @cdktn/bundler-docker

Container-based asset bundler for [CDK Terrain](https://github.com/open-constructs/cdk-terrain).

`DockerBundler` runs a build inside a docker image and stages its output as a
`TerraformAsset`. Because the build runs in an image the caller pins, the
artifact is reproducible across machines that share the same image, without
requiring the toolchain on the host. For a build that runs directly on the host
use `@cdktn/bundler-local` instead.

## Usage

```ts
import { TerraformAsset, AssetType } from "cdktn";
import { DockerBundler, BundlingFileAccess } from "@cdktn/bundler-docker";

new TerraformAsset(this, "asset", {
  path: "./src",
  type: AssetType.DIRECTORY,
  bundler: new DockerBundler({
    image: "node:20",
    command: [
      "sh",
      "-c",
      "cd /asset-input && npm ci && npm run build -- --out /asset-output",
    ],
    bundlingFileAccess: BundlingFileAccess.BIND_MOUNT,
  }),
});
```

The container mounts the source directory read-only at `/asset-input` under
`BIND_MOUNT`. The build writes its output to `/asset-output`. A build step that
writes to `/asset-input` fails under `BIND_MOUNT`. Copy the source to a
writable path inside the container first.

`DockerBundler` accepts only directory sources. A file source throws before the
container starts.

### Output type

`outputType` sets how the bundler reads `/asset-output`. The default,
`BundlingOutput.AUTO_DISCOVER`, stages a lone output file as `AssetType.FILE`
and any other output as a directory. Set `outputFileName` to name a
single-file artifact.

### Entrypoint

The `entrypoint` option sets `--entrypoint` to the first array element. The
remaining elements go before `command` in the container arguments.

### Bundler key

The bundler key covers the image, command, file access mode, environment,
entrypoint, working directory, platform, network, security option, user, output
type, and helper image.

### Host paths

Bind mounts use `--mount type=bind`. Host paths that contain `:` (for example
`C:\work`) or `,` work. The bundler resolves relative host paths to absolute
paths.

### Images

`DockerBundler` accepts only a registry reference in `image`. Build and push a
custom image before you use it.

### File access modes

- `BIND_MOUNT` (default) — bind-mounts the host source and output directories
  into the container. Fastest, but requires the host paths to be shareable with
  the docker daemon.
- `VOLUME_COPY` — copies the source into a named volume, runs the build, and
  copies the output back out. Works with a remote docker daemon where bind
  mounts are unavailable. Helper containers and volumes are cleaned up even when
  the build fails.

`VOLUME_COPY` uses a short-lived helper container to seed the input volume and
fix volume ownership. The bundler sets the ownership of the input tree after
it copies the source in. The helper runs as root (`-u 0`) with `--entrypoint sh`. It uses the same
`platform`, `network`, and `securityOpt` as the build container. It reuses the build image for this by default, so the
bundler never pulls an image the caller did not specify. If the build image has
no POSIX shell or `chown` (e.g. a `scratch`- or distroless-based image), set
`volumeCopyHelperImage` to any small image that does.

`VOLUME_COPY` accepts only `user` values that match `/^[\w.:-]+$/`.

The docker binary can be overridden with the `CDK_DOCKER` environment variable.

## License

Mozilla Public License 2.0
