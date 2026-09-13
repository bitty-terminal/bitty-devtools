#!/usr/bin/env bun
/**
 * Executable entry for the bitty-devtools CLI (CTX-0025).
 *
 * All process-environment access lives here so `src/cli.ts` stays a pure,
 * type-checked module; the runner receives an explicit runtime.
 */

import { runCli } from "../src/cli.js";

const uid = typeof process.getuid === "function" ? process.getuid() : 0;
const gid = typeof process.getgid === "function" ? process.getgid() : 0;

const code = runCli(process.argv.slice(2), {
  runtime: {
    env: process.env,
    uid,
    gid,
    pid: process.pid,
    now: () => Date.now(),
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
  },
});

process.exit(code);
