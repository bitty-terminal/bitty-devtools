import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve(import.meta.dir, "../scripts/workflow-import.sh");
const original = "[project]\nname = 'benign-fixture'\n";

function runFixture(stage: string, change: string, restoreFails = false) {
  const root = mkdtempSync(join(tmpdir(), "workflow-import-test-"));
  const project = join(root, "project");
  const bin = join(root, "bin");
  const temp = join(root, "temp");
  const config = join(project, ".carryctx/config.toml");
  const executable = (name: string, body: string) => {
    const path = join(bin, name);
    writeFileSync(path, `#!${process.execPath}\n${body}`);
    chmodSync(path, 0o700);
  };
  try {
    mkdirSync(join(project, ".carryctx"), { recursive: true });
    mkdirSync(bin);
    mkdirSync(temp);
    writeFileSync(config, original, { mode: 0o600 });
    for (const name of [
      "bash",
      "dirname",
      "mktemp",
      "timeout",
      "cat",
      "sed",
      "head",
      "cmp",
      "mkdir",
      "rm",
    ]) {
      const command = Bun.which(name);
      if (!command) throw new Error(`Missing fixture utility: ${name}`);
      symlinkSync(command, join(bin, name));
    }
    const cp = Bun.which("cp");
    if (!cp) throw new Error("Missing fixture utility: cp");
    executable(
      "git",
      `const args = process.argv.slice(2);
if (args[2] === "rev-parse") console.log(args.includes("--git-common-dir") ? process.env.FIXTURE_COMMON : "fixture-revision");
else if (args[2] === "log") console.log("CarryCtx-Export-Id: fixture");
else if (args[2] !== "fetch") process.exit(90);`,
    );
    executable(
      "carryctx",
      `import { writeFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
const stage = process.argv[2];
if (!["init", "import", "stats"].includes(stage)) process.exit(90);
if (stage === "init" || stage === "import") {
  const config = process.env.FIXTURE_CONFIG;
  if (stage === "init" || process.env.FIXTURE_CHANGE === "overwrite") writeFileSync(config, "benign-replacement");
  if (stage === "import" && process.env.FIXTURE_CHANGE === "delete") rmSync(config);
  if (stage === "import" && process.env.FIXTURE_CHANGE === "directory") rmSync(dirname(config), { recursive: true });
}
if (stage === process.env.FIXTURE_STAGE) process.exit(7);`,
    );
    executable(
      "cp",
      `const args = process.argv.slice(2);
if (process.env.FIXTURE_RESTORE_FAILS === "1" && args.at(-1) === process.env.FIXTURE_CONFIG) process.exit(8);
const result = Bun.spawnSync([process.env.FIXTURE_CP, ...args]);
process.exit(result.exitCode);`,
    );
    const result = Bun.spawnSync(
      [join(bin, "bash"), script, "--project", project],
      {
        cwd: project,
        env: {
          PATH: bin,
          HOME: root,
          TMPDIR: temp,
          FIXTURE_COMMON: join(project, "fake-git"),
          FIXTURE_CONFIG: config,
          FIXTURE_CP: cp,
          FIXTURE_STAGE: stage,
          FIXTURE_CHANGE: change,
          FIXTURE_RESTORE_FAILS: restoreFails ? "1" : "0",
        },
        timeout: 10_000,
      },
    );
    const backups = readdirSync(temp).map((entry) =>
      join(temp, entry, "config.toml.before"),
    );
    return {
      exitCode: result.exitCode,
      stderr: result.stderr.toString(),
      config: existsSync(config) ? readFileSync(config, "utf8") : undefined,
      backups: backups.map((path) => ({
        path,
        content: readFileSync(path, "utf8"),
      })),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("workflow import config preservation with fake commands", () => {
  for (const stage of ["init", "import", "stats", "success"]) {
    test(`restores configuration after ${stage}`, () => {
      const result = runFixture(stage, "overwrite");
      expect(result.exitCode).toBe(stage === "success" ? 0 : 1);
      expect(result.config).toBe(original);
      expect(result.backups).toEqual([]);
    });
  }

  for (const change of ["delete", "directory"]) {
    for (const stage of ["import", "success"]) {
      test(`restores missing config after ${change} and ${stage}`, () => {
        const result = runFixture(stage, change);
        expect(result.exitCode).toBe(stage === "success" ? 0 : 1);
        expect(result.config).toBe(original);
        expect(result.backups).toEqual([]);
      });
    }
  }

  for (const stage of ["import", "success"]) {
    test(`retains recovery backup when restoration fails after ${stage}`, () => {
      const result = runFixture(stage, "overwrite", true);
      expect(result.exitCode).toBe(1);
      expect(result.backups).toHaveLength(1);
      expect(result.backups[0]?.content).toBe(original);
      expect(result.stderr).toContain(result.backups[0]!.path);
    });
  }
});
