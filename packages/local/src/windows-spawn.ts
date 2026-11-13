// Copyright (c) cdktn-io
// SPDX-License-Identifier: MPL-2.0
//
// The Windows command resolution and cmd.exe escaping below is adapted from
// cross-spawn (https://github.com/moxystudio/node-cross-spawn), vendored
// here instead of taken as an npm dependency: packing it through
// jsii-pacmak's `npm pack` step pulls in a dependency resolved via pnpm's
// symlinked store, which reliably triggers an npm packing bug ("Exit
// handler never called!") in this project's CI. A plain source file has no
// node_modules involved in packing.
//
// cross-spawn is MIT licensed:
//
//   The MIT License (MIT)
//
//   Copyright (c) 2018 Made With MOXY Lda <hello@moxy.studio>
//
//   Permission is hereby granted, free of charge, to any person obtaining a
//   copy of this software and associated documentation files (the
//   "Software"), to deal in the Software without restriction, including
//   without limitation the rights to use, copy, modify, merge, publish,
//   distribute, sublicense, and/or sell copies of the Software, and to
//   permit persons to whom the Software is furnished to do so, subject to
//   the following conditions:
//
//   The above copyright notice and this permission notice shall be included
//   in all copies or substantial portions of the Software.
//
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
//   OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
//   MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
//   IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
//   CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
//   TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
//   SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

import { spawnSync, SpawnSyncOptions, SpawnSyncReturns } from "child_process";
import { statSync } from "fs";
import * as path from "path";

const isWin = process.platform === "win32";
const isNativeExecutableRegExp = /\.(?:com|exe)$/i;
const isCmdShimRegExp = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i;
const metaCharsRegExp = /([()\][%!^"`<>&|;, *?])/g;

/**
 * Looks up an environment variable case-insensitively, as Windows itself
 * does, and as the env passed to the spawned process (not this process's
 * own `process.env`) should be read.
 */
function envValue(
  env: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const key = Object.keys(env)
    .reverse()
    .find((k) => k.toUpperCase() === name.toUpperCase());
  return key ? env[key] : undefined;
}

function windowsPathExtCandidates(
  command: string,
  env: NodeJS.ProcessEnv,
): string[] {
  const pathExtExe = envValue(env, "PATHEXT") || ".EXE;.CMD;.BAT;.COM";
  const exts = pathExtExe.split(";");
  return command.includes(".") && exts[0] !== "" ? ["", ...exts] : exts;
}

function fileExists(file: string): boolean {
  try {
    const stat = statSync(file);
    return stat.isFile() || stat.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Resolves a command to a file on disk the way Windows itself resolves it:
 * a command containing a path separator is resolved against `cwd` (the
 * spawned process's working directory, not this process's); a bare command
 * name is resolved against `cwd` first, then each `PATH` entry; each is
 * tried with every `PATHEXT` extension in turn.
 */
function resolveOnWindows(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const hasSlash = /[\\/]/.test(command);
  const dirs = hasSlash
    ? [cwd]
    : [cwd, ...(envValue(env, "PATH") ?? "").split(path.delimiter)];

  for (const dir of dirs) {
    const candidate = path.resolve(cwd, dir, command);
    for (const ext of windowsPathExtCandidates(command, env)) {
      const full = candidate + ext;
      if (fileExists(full)) {
        return full;
      }
    }
  }
  return undefined;
}

function escapeCommand(arg: string): string {
  return arg.replace(metaCharsRegExp, "^$1");
}

/**
 * Escapes a single command-line argument for cmd.exe. Ported verbatim from
 * cross-spawn (see https://qntm.org/cmd for the algorithm this implements)
 * since getting Windows command-line escaping wrong is a real security
 * issue (e.g. CVE-2024-27980), not just a correctness one.
 */
function escapeArgument(arg: string, doubleEscapeMetaChars: boolean): string {
  let escaped = `${arg}`;
  escaped = escaped.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  escaped = escaped.replace(/(?=(\\+?)?)\1$/, "$1$1");
  escaped = `"${escaped}"`;
  escaped = escaped.replace(metaCharsRegExp, "^$1");
  if (doubleEscapeMetaChars) {
    escaped = escaped.replace(metaCharsRegExp, "^$1");
  }
  return escaped;
}

/**
 * `spawnSync` that resolves Windows `.cmd`/`.bat` shims (as created for
 * `npm`, `npx`, `pnpm`, and everything under `node_modules/.bin`) through
 * `cmd.exe` the way a shell would, so they run without the caller having to
 * invoke a shell itself. A thin pass-through to `child_process.spawnSync`
 * on every other platform.
 */
export function spawnSyncCrossPlatform(
  command: string,
  args: string[],
  options: SpawnSyncOptions,
): SpawnSyncReturns<string | Buffer> {
  if (!isWin) {
    return spawnSync(command, args, options);
  }

  const cwd = typeof options.cwd === "string" ? options.cwd : process.cwd();
  const env = options.env ?? process.env;
  const file = resolveOnWindows(command, cwd, env);
  const needsShell = !file || !isNativeExecutableRegExp.test(file);

  let resolvedCommand = command;
  let resolvedArgs = args;
  let windowsVerbatimArguments: boolean | undefined;

  if (needsShell) {
    // A cmd-shim under node_modules/.bin proxies to a Node script, which
    // re-interprets the already-escaped meta chars, so it needs them
    // escaped twice.
    const needsDoubleEscape = !!file && isCmdShimRegExp.test(file);
    const escapedCommand = escapeCommand(path.normalize(command));
    const escapedArgs = args.map((arg) =>
      escapeArgument(arg, needsDoubleEscape),
    );
    const shellCommand = [escapedCommand, ...escapedArgs].join(" ");

    resolvedCommand = process.env.ComSpec || "cmd.exe";
    resolvedArgs = ["/d", "/s", "/c", `"${shellCommand}"`];
    windowsVerbatimArguments = true;
  }

  const result = spawnSync(resolvedCommand, resolvedArgs, {
    ...options,
    windowsVerbatimArguments,
  });

  // cmd.exe reports "command not recognized" as a plain exit code 1, which
  // would otherwise be mistaken for the command having run and failed.
  if (!result.error && result.status === 1 && !file) {
    result.error = Object.assign(new Error(`spawnSync ${command} ENOENT`), {
      code: "ENOENT",
    });
  }

  return result;
}
