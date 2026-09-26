import { describe, expect, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

type FixtureOptions = {
  database?: "absent" | "empty" | "non-empty" | "directory";
  rowTable?: string;
  projectRows?: number;
  sqliteMode?: string;
  sqliteAvailable?: boolean;
  realFts?: boolean;
  realNewlineTable?: boolean;
  realSchemaDrift?: boolean;
  realMigrationDrift?: boolean;
  realWal?: boolean;
  walWithoutShm?: boolean;
  freshWal?: boolean;
  sidecars?: "wal" | "shm" | "both";
  authorityFailure?: boolean;
  commandLock?: boolean;
  race?:
    | "database"
    | "config"
    | "import"
    | "import-path"
    | "carryctx-dir"
    | "import-inode"
    | "fetch-shm-inode"
    | "guard-wal"
    | "guard-after-validation";
  descendant?: boolean;
  noSetsid?: boolean;
  databaseSymlink?: boolean;
  sidecarSymlink?: boolean;
  orphanSidecar?: boolean;
  configSymlink?: boolean;
  carryctxSymlink?: boolean;
  projectSymlink?: boolean;
  projectParentSymlink?: boolean;
  schemaVersion?: number;
  migrationCount?: number;
  migrationMin?: number;
  migrationMax?: number;
  migrationDistinct?: number;
  migrationInvalid?: number;
  projectInvalid?: number;
  versionOutput?: string;
  versionFails?: boolean;
  versionMutatesTarget?: boolean;
  gitTimeout?: number;
  force?: boolean;
  dryRun?: boolean;
};

const script = resolve(import.meta.dir, "../scripts/workflow-import.sh");
const original = "[project]\nname = 'benign-fixture'\n";
const currentSchemaObjects = "74|6E|74|";
const authoritySchemaBase64 =
  "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";
const currentMigrations = [
  "1|0001_foundation|a99535ad2f10c5b40f2866d1486de8797137387ec34ff7517c60e291a0f2df7b",
  "2|0002_work_model|64825504899f4a8ed5c12d1c74ce5111af05e349760406fd016d2a30205f65b2",
  "3|0003_progress|7f8e37642a709cb3777e1115089093dce9ce5f338e67b002cc882a37644b20a2",
  "4|0004_worktrees_sessions|0c04b1d12d31c5d813746428e48d5c82350a8d3e49b7f197762a3c3cdf8bfbd6",
  "5|0005_checkpoints|bf6a6a6c65b6fd5f38f337e5cdbdada181010e1cc444d5c02e5d86a72e7f6d02",
  "6|0006_collaboration|9c4cc4f87092188b2f5be346f24ecec8a7de31f4889efaf6a70dca6923b077f2",
  "7|0007_context_graph|0c8c136e1939b8b2603f6618591270431fd664ebdec2a45be97f01755f7f44d2",
  "8|0008_jj_compat|a0af35f9442fc171f4bb957b4aec534ca625d4923ce27e0d60832f4c31a46d96",
  "9|0009_search|1ef479e5a7bd7530306ce36ce8cbcf4d7bdb01c2f2da4eb92aff5a925464babe",
  "10|0010_decision_rationale|0ca5559cb1302a2d9f3988c77061b60ba88dfbe6ddda35bb9df5d1c5d99e4787",
  "11|0011_backfill_session_ended_at|80fb48cefa7614bedbba3783e5ab75d9a68e5c5f178c6d6620026ed93718f5d2",
  "12|0012_agent_teams|03a2a5e979991567ea92ba906e4601f1d13004f5dde3887a47f3a8486c8bfb8b",
  "13|0013_agent_kind_constraint|270672953d22c3ec60d33c8c1dfaa157867e9c46eaa075b34f1c910f7340864f",
  "14|0014_cascade_task_refs|394edcd0184c1c96c17329f4c140b2edfd6633e09716d5dd2ad58c1a184ba796",
  "15|0015_agent_name_unique|1ab8e410be54b62c2e9afe02b0848c70143161fa4b730d6ad6a4b727b8086d3e",
  "16|0016_task_list_index|8ac609f74238325c25cc5da357e6609a792e50fbd7b1e4a4ef8fbd42c9b04342",
  "17|0017_worktree_cleanup_requests|2fe11628e1e59889a1413f77df4fc0b766cd533d071c466998b4d376ed8aa451",
  "18|0018_tombstones_snapshot_state|6eb192c81bd28ec7d5d4dee6dfb6ff1ffb992f742ef0c714fa4865b5a22c4e7e",
];
const currentMigrationSnapshot = currentMigrations
  .map((row) => {
    const [version, name, checksum] = row.split("|");
    return `${version}|${Buffer.from(name).toString("hex").toUpperCase()}|${checksum.toUpperCase()}`;
  })
  .join("\n");

const currentTables = [
  "schema_migrations",
  "projects",
  "operations",
  "events",
  "sequences",
  "agents",
  "tasks",
  "task_dependencies",
  "progress_items",
  "worktrees",
  "sessions",
  "checkpoints",
  "checkpoint_corrections",
  "scopes",
  "decisions",
  "handoffs",
  "graph_nodes",
  "graph_edges",
  "teams",
  "team_members",
  "worktree_cleanup_requests",
  "tombstones",
  "snapshot_state",
  "tasks_fts",
  "tasks_fts_config",
  "tasks_fts_content",
  "tasks_fts_data",
  "tasks_fts_docsize",
  "tasks_fts_idx",
  "checkpoints_fts",
  "checkpoints_fts_config",
  "checkpoints_fts_content",
  "checkpoints_fts_data",
  "checkpoints_fts_docsize",
  "checkpoints_fts_idx",
  "progress_items_fts",
  "progress_items_fts_config",
  "progress_items_fts_content",
  "progress_items_fts_data",
  "progress_items_fts_docsize",
  "progress_items_fts_idx",
  "decisions_fts",
  "decisions_fts_config",
  "decisions_fts_content",
  "decisions_fts_data",
  "decisions_fts_docsize",
  "decisions_fts_idx",
];

function realVersionEnvelope(dbSchema: number) {
  return JSON.stringify({
    schema_version: 1,
    command: "version",
    success: true,
    data: {
      contract_versions: {
        cli: "0.11.6",
        ctxpack_format: {
          format: "carryctx-pack-dir",
          format_version: 2,
        },
        db_schema: dbSchema,
        skill_surface: {
          min_carryctx: "0.11.6",
          skill: "use-carryctx",
          version: "1.3.0",
        },
      },
    },
    meta: {
      timestamp: "2026-09-24T09:00:00Z",
    },
  });
}

function createDisposableAuthorityFixture(root: string) {
  const python = Bun.which("python3");
  if (!python) throw new Error("Missing fixture utility: python3");
  const path = join(root, "authority.sqlite");
  const program = `
import base64
import gzip
import json
import os
import sqlite3
import sys
path = sys.argv[1]
schema = gzip.decompress(base64.b64decode(sys.argv[2])).decode()
migrations = json.loads(sys.argv[3])
if len(migrations) != 18:
    raise RuntimeError("expected 18 migration rows")
connection = sqlite3.connect(path)
connection.execute("PRAGMA journal_mode=DELETE")
connection.execute("PRAGMA user_version=18")
connection.executescript(schema)
for row in migrations:
    version, name, checksum = row.split("|")
    connection.execute(
        "INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
        (int(version), name, checksum, "2026-01-01T00:00:00Z"),
    )
connection.execute(
    "INSERT INTO projects(id, name, task_prefix, repository_root, git_common_dir, main_branch, schema_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ("fixture-project", "fixture", "FIX", "/fixture/project", "/fixture/git", "main", 4, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"),
)
object_count = connection.execute("SELECT COUNT(*) FROM sqlite_master").fetchone()[0]
fts_count = connection.execute("SELECT COUNT(*) FROM sqlite_master WHERE name LIKE '%fts%'").fetchone()[0]
if object_count != 129 or fts_count != 36:
    raise RuntimeError("expected 129 schema objects and 36 FTS-related objects")
connection.commit()
os._exit(0)
`;
  const result = Bun.spawnSync(
    [
      python,
      "-c",
      program,
      path,
      authoritySchemaBase64,
      JSON.stringify(currentMigrations),
    ],
    { timeout: 10_000 },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Cannot create disposable authority fixture: ${result.stderr.toString()}`,
    );
  }
  return path;
}

function createDisposableCurrentDatabase(
  path: string,
  authorityDatabase: string,
  options: {
    fts?: boolean;
    newline?: boolean;
    schemaDrift?: boolean;
    migrationDrift?: boolean;
    wal?: boolean;
    withoutShm?: boolean;
    freshWal?: boolean;
  },
) {
  const python = Bun.which("python3");
  if (!python) throw new Error("Missing fixture utility: python3");
  copyFileSync(authorityDatabase, path);
  for (const suffix of ["-wal", "-shm"]) {
    const source = `${authorityDatabase}${suffix}`;
    if (existsSync(source)) copyFileSync(source, `${path}${suffix}`);
  }
  const modes = [
    options.fts ? "fts" : "",
    options.newline ? "newline" : "",
    options.schemaDrift ? "schema-drift" : "",
    options.migrationDrift ? "migration-drift" : "",
    options.wal ? "wal" : "",
    options.freshWal ? "fresh-wal" : "",
  ]
    .filter(Boolean)
    .join(",");
  const program = `
import os
import sqlite3
import sys
path = sys.argv[1]
modes = set(filter(None, sys.argv[2].split(",")))
connection = sqlite3.connect(path)
if "fts" in modes:
    fts_count = connection.execute("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND (name LIKE 'tasks_fts%' OR name LIKE 'checkpoints_fts%' OR name LIKE 'progress_items_fts%' OR name LIKE 'decisions_fts%')").fetchone()[0]
    if fts_count != 24:
        raise RuntimeError("expected 24 FTS objects")
connection.execute("PRAGMA journal_mode=" + ("WAL" if "wal" in modes or "fresh-wal" in modes else "DELETE"))
if "wal" in modes:
    connection.execute("PRAGMA wal_autocheckpoint=0")
    connection.execute("UPDATE projects SET updated_at = updated_at || '-wal'")
if "fts" in modes:
    connection.execute("INSERT INTO tasks_fts(rowid, title, description) VALUES (1, 'shadow-row', 'shadow-row')")
    connection.execute("DELETE FROM tasks_fts WHERE rowid = 1")
if "newline" in modes:
    connection.execute('CREATE TABLE "bad\\nname" (value TEXT)')
    connection.execute('INSERT INTO "bad\\nname"(value) VALUES (\\'row\\')')
if "schema-drift" in modes:
    connection.execute('CREATE TABLE schema_drift (value TEXT)')
if "migration-drift" in modes:
    connection.execute("UPDATE schema_migrations SET checksum = '0' || substr(checksum, 2) WHERE version = 1")
connection.commit()
os._exit(0)
`;
  const result = Bun.spawnSync([python, "-c", program, path, modes], {
    timeout: 10_000,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `Cannot create disposable current-schema fixture: ${result.stderr.toString()}`,
    );
  }
  if (options.withoutShm) rmSync(`${path}-shm`, { force: true });
  if (options.freshWal) {
    rmSync(`${path}-wal`, { force: true });
    rmSync(`${path}-shm`, { force: true });
  }
}

function runFixture(
  stage: string,
  change: string,
  restoreFails = false,
  options: FixtureOptions = {},
) {
  const root = mkdtempSync(join(tmpdir(), "workflow-import-test-"));
  let project = join(root, "project");
  let projectTarget = project;
  if (options.projectParentSymlink) {
    const actualParent = join(root, "project-parent");
    const linkedParent = join(root, "linked-parent");
    projectTarget = join(actualParent, "project");
    mkdirSync(actualParent, { recursive: true });
    symlinkSync(actualParent, linkedParent, "dir");
    project = join(linkedParent, "project");
  } else if (options.projectSymlink) {
    projectTarget = join(root, "project-target");
    project = join(root, "project-link");
  }
  const bin = join(root, "bin");
  const temp = join(root, "temp");
  const config = join(project, ".carryctx/config.toml");
  const log = join(root, "commands.log");
  const executable = (name: string, body: string) => {
    const path = join(bin, name);
    writeFileSync(path, `#!${process.execPath}\n${body}`);
    chmodSync(path, 0o700);
  };
  const realFixture = Boolean(
    options.realFts ||
    options.realNewlineTable ||
    options.realSchemaDrift ||
    options.realMigrationDrift ||
    options.realWal ||
    options.walWithoutShm ||
    options.freshWal,
  );
  let authorityDatabase: string | undefined;
  let databaseBefore: Buffer | undefined;
  let databaseIdentityBefore: string | undefined;
  let walIdentityBefore: string | undefined;
  let shmIdentityBefore: string | undefined;
  let projectUpdatedAtBefore: string | undefined;
  let walBefore: { wal: Buffer; shm?: Buffer } | undefined;
  if (realFixture) authorityDatabase = createDisposableAuthorityFixture(root);
  try {
    mkdirSync(projectTarget, { recursive: true });
    if (options.projectSymlink) {
      symlinkSync(projectTarget, project, "dir");
    }
    if (options.carryctxSymlink) {
      const targetDir = join(root, "carryctx-target");
      mkdirSync(targetDir, { recursive: true });
      writeFileSync(join(targetDir, "config.toml"), original, { mode: 0o600 });
      symlinkSync(targetDir, join(project, ".carryctx"), "dir");
    } else {
      mkdirSync(join(projectTarget, ".carryctx"), { recursive: true });
      if (options.configSymlink) {
        const target = join(root, "config-target");
        writeFileSync(target, original, { mode: 0o600 });
        symlinkSync(target, config);
      } else {
        writeFileSync(join(projectTarget, ".carryctx/config.toml"), original, {
          mode: 0o600,
        });
      }
    }
    mkdirSync(bin);
    mkdirSync(temp);
    mkdirSync(join(project, "fake-git"), { recursive: true });
    const database = options.database ?? "absent";
    if (realFixture || database !== "absent") {
      const stateDir = join(project, "fake-git/carryctx");
      mkdirSync(stateDir, { recursive: true });
      const databasePath = join(stateDir, "state.sqlite");
      if (realFixture) {
        if (!authorityDatabase) throw new Error("Missing authority database");
        createDisposableCurrentDatabase(databasePath, authorityDatabase, {
          fts: options.realFts,
          newline: options.realNewlineTable,
          schemaDrift: options.realSchemaDrift,
          migrationDrift: options.realMigrationDrift,
          wal: options.realWal || options.walWithoutShm,
          withoutShm: options.walWithoutShm,
          freshWal: options.freshWal,
        });
        databaseBefore = readFileSync(databasePath);
        databaseIdentityBefore = `${statSync(databasePath).dev}:${statSync(databasePath).ino}`;
        if (existsSync(`${databasePath}-wal`)) {
          walIdentityBefore = `${statSync(`${databasePath}-wal`).dev}:${statSync(`${databasePath}-wal`).ino}`;
        }
        if (existsSync(`${databasePath}-shm`)) {
          shmIdentityBefore = `${statSync(`${databasePath}-shm`).dev}:${statSync(`${databasePath}-shm`).ino}`;
        }
        if (options.realWal || options.walWithoutShm) {
          walBefore = {
            wal: readFileSync(`${databasePath}-wal`),
            shm: existsSync(`${databasePath}-shm`)
              ? readFileSync(`${databasePath}-shm`)
              : undefined,
          };
        }
      } else if (database === "directory") {
        mkdirSync(databasePath, { recursive: true });
      } else if (options.databaseSymlink) {
        const target = join(root, "state-target.sqlite");
        writeFileSync(target, "fixture");
        symlinkSync(target, databasePath);
      } else {
        writeFileSync(databasePath, "fixture");
      }
      if (
        !realFixture &&
        (options.sidecars === "wal" || options.sidecars === "both")
      ) {
        writeFileSync(`${databasePath}-wal`, "sidecar");
      }
      if (
        !realFixture &&
        (options.sidecars === "shm" || options.sidecars === "both")
      ) {
        writeFileSync(`${databasePath}-shm`, "sidecar");
      }
      if (options.sidecarSymlink) {
        const target = join(root, "sidecar-target");
        writeFileSync(target, "sidecar");
        symlinkSync(target, `${databasePath}-wal`);
      }
    }
    if (options.orphanSidecar) {
      const stateDir = join(project, "fake-git/carryctx");
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, "state.sqlite-wal"), "orphan");
    }
    if (options.commandLock) {
      const lock = join(project, "fake-git/carryctx/locks/command.lock");
      mkdirSync(lock, { recursive: true });
      writeFileSync(join(lock, "meta.json"), "{}");
    }
    for (const name of [
      "bash",
      "dirname",
      "mktemp",
      "cat",
      "sed",
      "head",
      "cmp",
      "wc",
      "mkdir",
      "rm",
      "mkfifo",
      "awk",
      "stat",
      "setsid",
      "sleep",
    ]) {
      if (name === "setsid" && options.noSetsid) continue;
      const command = Bun.which(name);
      if (!command) throw new Error(`Missing fixture utility: ${name}`);
      symlinkSync(command, join(bin, name));
    }
    const realMv = Bun.which("mv");
    const python = Bun.which("python3");
    if (!realMv || !python)
      throw new Error("Missing fixture utility: mv or python3");
    executable(
      "mv",
      `import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
const args = process.argv.slice(2);
if (process.env.FIXTURE_RACE === "guard-wal") {
  const source = args.at(-2) ?? "";
  const destination = args.at(-1) ?? "";
  if (source.includes(".workflow-import-candidate.") && destination.endsWith("/state.sqlite")) {
    const guard = readdirSync(dirname(destination)).find((name) => name.startsWith(".workflow-import-original.") && !name.endsWith("-wal") && !name.endsWith("-shm"));
    if (guard) {
      const guardPath = join(dirname(destination), guard);
      const result = Bun.spawnSync([process.env.FIXTURE_PYTHON, "-c", "import os,sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('PRAGMA journal_mode=WAL'); c.execute('PRAGMA wal_autocheckpoint=0'); c.execute('BEGIN IMMEDIATE'); c.execute(\\\"UPDATE projects SET name = name || '-handoff-injected'\\\"); c.commit(); os._exit(0)", guardPath], { env: process.env });
      if (result.exitCode !== 0) process.exit(result.exitCode);
    }
  }
}
const result = Bun.spawnSync([process.env.FIXTURE_MV, ...args], { env: process.env, stdio: ["ignore", "inherit", "inherit"] });
process.exit(result.exitCode);`,
    );
    if (
      options.realFts ||
      options.realNewlineTable ||
      options.realSchemaDrift ||
      options.realMigrationDrift ||
      options.realWal ||
      options.walWithoutShm ||
      options.freshWal
    ) {
      const sqlite = Bun.which("sqlite3");
      if (!sqlite) throw new Error("Missing fixture utility: sqlite3");
      symlinkSync(sqlite, join(bin, "sqlite3"));
    } else if (options.sqliteAvailable !== false) {
      executable(
        "sqlite3",
        `import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const args = process.argv.slice(2);
const last = args.at(-1) ?? "";
const commandSql = args.filter((value, index) => args[index - 1] === "-cmd").join("\\n");
const sql = last.endsWith(".sqlite") ? commandSql : last;
const lockedPaths = [...commandSql.matchAll(/\\.once '([^']+)'/g)].map((match) => match[1]);
if (commandSql.includes("BEGIN IMMEDIATE;") && lockedPaths.length === 4) {
  const [integrity, schema, migrations, dump] = lockedPaths;
  const preImportDump = join(dirname(dump), "pre-import-raw.dump");
  if (!existsSync(preImportDump)) process.exit(1);
  writeFileSync(integrity, "ok\\n");
  writeFileSync(schema, ${JSON.stringify(currentSchemaObjects)} + "\\n");
  writeFileSync(migrations, ${JSON.stringify(currentMigrationSnapshot)} + "\\n");
  writeFileSync(dump, readFileSync(preImportDump));
  const shellLine = commandSql.split("\\n").find((line) => line.startsWith(".shell "));
  const marker = shellLine?.trim().split(/\\s+/).at(-1);
  if (!marker) process.exit(1);
  writeFileSync(marker, "ok\\n");
  process.exit(0);
}
const mode = process.env.FIXTURE_SQLITE_MODE ?? "valid";
const initialized = Boolean(process.env.FIXTURE_INIT_MARKER && existsSync(process.env.FIXTURE_INIT_MARKER));
appendFileSync(process.env.FIXTURE_LOG, "sqlite3 " + sql.replace(/\\s+/g, " ") + "\\n");
if (mode === "unreadable" || mode === "locked" || mode === "schema-command-error" || mode === "wal-invalid") process.exit(1);
if (mode === "timeout") process.exit(124);
if (mode === "hang") await new Promise((resolve) => setTimeout(resolve, 2000));
if (mode === "hang-descendant") {
   const descendant = Bun.spawn([process.execPath, "-e", "await Bun.sleep(1500); await Bun.write(process.env.FIXTURE_DESCENDANT_MARKER, 'leaked');"], { env: { ...process.env, FIXTURE_DESCENDANT_MARKER: process.env.FIXTURE_DESCENDANT_MARKER } });
   await new Promise((resolve) => setTimeout(resolve, 2000));
 }
if (sql.includes("UPDATE projects SET repository_root")) {
  process.exit(0);
}
if (sql.includes("VACUUM INTO")) {
  if (mode === "dump-error") process.exit(1);
  const match = sql.match(/\\.parameter set @out '([^']+)'/);
  if (!match) process.exit(1);
  const content = existsSync(last) ? readFileSync(last).toString("base64") : "";
  writeFileSync(match[1], content);
  process.exit(0);
}
if (sql === ".dump") {
  if (mode === "dump-error") process.exit(1);
  const database = args.at(-2) ?? "";
  const content = [database, ...["-wal", "-shm"].map((suffix) => database + suffix)]
    .filter((path) => existsSync(path))
    .map((path) => readFileSync(path).toString("base64"))
    .join(":");
  console.log("fixture-dump:" + content);
  process.exit(0);
}
if (sql.includes("hex(type)||")) {
  const database = args.at(-2) ?? "";
  const objects = mode === "schema-line-overflow" ? "A".repeat(131073) : mode === "schema-drift" && !database.includes("schema-authority") ? "74|6E|75|" : ${JSON.stringify(currentSchemaObjects)};
  console.log(objects);
  process.exit(0);
}
if (sql.includes("version||") && sql.includes("schema_migrations")) {
  const database = args.at(-2) ?? "";
  const migrations = mode === "migration-drift" && !database.includes("schema-authority") ? ${JSON.stringify(currentMigrationSnapshot)}.replace("1|", "1|00") : ${JSON.stringify(currentMigrationSnapshot)};
  console.log(migrations);
  process.exit(0);
}
if (sql.includes("PRAGMA integrity_check")) {
  console.log(mode === "corrupt" ? "corrupt" : "ok");
  process.exit(0);
}
if (sql.includes("FROM schema_migrations;")) {
  const version = Number(process.env.FIXTURE_SCHEMA_VERSION ?? "18");
  const count = Number(process.env.FIXTURE_MIGRATION_COUNT ?? version);
  const min = Number(process.env.FIXTURE_MIGRATION_MIN ?? 1);
  const max = Number(process.env.FIXTURE_MIGRATION_MAX ?? version);
  const distinct = Number(process.env.FIXTURE_MIGRATION_DISTINCT ?? version);
  const invalid = Number(process.env.FIXTURE_MIGRATION_INVALID ?? 0);
  console.log(mode === "malformed" ? "not-a-number|1|18|18|0" : [count, min, max, distinct, invalid].join("|"));
  process.exit(0);
}
if (sql.includes("pragma_foreign_key_check")) {
  console.log(mode === "foreign-key" ? "1" : "0");
  process.exit(0);
}
if (sql.includes("FROM projects;")) {
  if (mode === "project-count-error") process.exit(1);
  const count = initialized ? 1 : Number(process.env.FIXTURE_PROJECT_ROWS ?? "0");
  const invalid = Number(process.env.FIXTURE_PROJECT_INVALID ?? "0");
  console.log([count, invalid].join("|"));
  process.exit(0);
}
if (sql.includes("COUNT(DISTINCT name)")) {
  if (mode === "too-many-tables") console.log("257|257|0|0");
  else if (mode === "long-table-name") console.log("1|1|1|0");
  else if (mode === "newline-table") console.log("1|1|0|1");
  else if (mode === "duplicate-table") console.log("${currentTables.length + 1}|${currentTables.length}|0|0");
  else console.log("${currentTables.length}|${currentTables.length}|0|0");
  process.exit(0);
}
if (sql.includes("hex(name) FROM sqlite_master")) {
  if (mode === "table-list-error") process.exit(1);
  let tables = ${JSON.stringify(currentTables)}.filter((name) => {
    if (mode === "missing-projects") return name !== "projects";
    if (mode === "missing-schema-migrations") return name !== "schema_migrations";
    return true;
  });
  if (mode === "newline-table") tables = ["bad\\ntable"];
  if (mode === "duplicate-table") tables.push("projects");
  console.log(tables.map((name) => Buffer.from(name, "utf8").toString("hex").toUpperCase()).join("\\n"));
  process.exit(0);
}
if (sql.includes("SELECT COALESCE(0")) {
  if (mode === "count-error") process.exit(1);
  const rowTable = process.env.FIXTURE_ROW_TABLE ?? "";
  const count = initialized ? 1 : rowTable && ${JSON.stringify(currentTables)}.includes(rowTable) ? 1 : 0;
  console.log(String(count));
  process.exit(0);
}
const match = sql.match(/FROM "([^"]+)"/);
if (!match) process.exit(90);
const table = match[1];
if (mode === "count-error") process.exit(1);
const projectRows = Number(process.env.FIXTURE_PROJECT_ROWS ?? "0");
const rowTable = process.env.FIXTURE_ROW_TABLE ?? "";
const count = table === "projects" ? projectRows : table === rowTable ? 1 : 0;
console.log(String(count));`,
      );
    }
    const cp = Bun.which("cp");
    if (!cp) throw new Error("Missing fixture utility: cp");
    executable(
      "git",
      `import { appendFileSync, copyFileSync, existsSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.FIXTURE_LOG, "git " + args.join(" ") + "\\n");
if (args[0] === "init") {
  mkdirSync(args.at(-1), { recursive: true });
  process.exit(0);
}
if (args[2] === "rev-parse") {
  if (args.includes("--git-common-dir")) console.log(process.env.FIXTURE_COMMON);
  else if (args.includes("--short")) console.log("0123456");
  else console.log("0".repeat(40));
}
else if (args[2] === "log") console.log("CarryCtx-Export-Id: fixture");
else if (args[2] === "fetch") {
  if (process.env.FIXTURE_RACE === "database") appendFileSync(process.env.FIXTURE_DB, "race");
  if (process.env.FIXTURE_RACE === "config") {
    rmSync(process.env.FIXTURE_CONFIG, { force: true });
    symlinkSync(process.env.FIXTURE_RACE_TARGET, process.env.FIXTURE_CONFIG);
  }
  if (process.env.FIXTURE_RACE === "fetch-shm-inode" && existsSync(process.env.FIXTURE_DB + "-shm")) {
    const source = process.env.FIXTURE_DB + "-shm";
    const replacement = source + ".replacement";
    copyFileSync(source, replacement);
    renameSync(replacement, source);
  }
  process.exit(0);
}
else process.exit(90);`,
    );
    executable(
      "carryctx",
      `import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const stage = process.argv[2];
const projectIndex = process.argv.indexOf("--project");
const project = projectIndex >= 0 ? process.argv[projectIndex + 1] : "";
const staging = project.includes("/import-staging/");
const stateRoot = staging ? join(project, ".git") : process.env.FIXTURE_COMMON;
const configPath = staging ? join(project, ".carryctx/config.toml") : process.env.FIXTURE_CONFIG;
let importBackup = "";
const authority = project.includes("/schema-authority/");
const dryRun = project.includes("/dry-run/");
appendFileSync(process.env.FIXTURE_LOG, (authority ? "carryctx-authority " : dryRun ? "carryctx-dry-run " : "carryctx ") + process.argv.slice(2).join(" ") + "\\n");
if (stage === "version") {
  if (process.env.FIXTURE_VERSION_MUTATES_TARGET === "1" && (!project || project === process.env.FIXTURE_PROJECT)) {
    const state = join(process.env.FIXTURE_COMMON, "carryctx/state.sqlite");
    if (existsSync(state)) {
      appendFileSync(state, "version-mutation");
      for (const suffix of ["-wal", "-shm"]) rmSync(state + suffix, { force: true });
    }
  }
  if (process.env.FIXTURE_VERSION_FAILS === "1") process.exit(1);
  const envelope = process.env.FIXTURE_VERSION_OUTPUT ?? ${JSON.stringify(realVersionEnvelope(18))};
  console.log(envelope);
  process.exit(0);
}
if (stage === "init" && authority) {
  if (process.env.FIXTURE_AUTHORITY_FAILURE === "1") process.exit(9);
  const destination = join(project, ".git/carryctx/state.sqlite");
  mkdirSync(dirname(destination), { recursive: true });
  if (process.env.FIXTURE_AUTHORITY_DB && existsSync(process.env.FIXTURE_AUTHORITY_DB)) {
    copyFileSync(process.env.FIXTURE_AUTHORITY_DB, destination);
    for (const suffix of ["-wal", "-shm"]) {
      const source = process.env.FIXTURE_AUTHORITY_DB + suffix;
      if (existsSync(source)) copyFileSync(source, destination + suffix);
    }
  } else {
    writeFileSync(destination, "authority");
  }
  process.exit(0);
}
if (stage === "import" && dryRun) {
   console.log(JSON.stringify({ schema_version: 1, command: "import.create", success: true, data: { operation: { applied: false } } }));
   process.exit(0);
 }
if (stage === "stats" && process.env.FIXTURE_RACE === "guard-after-validation") {
  const stateDirectory = join(stateRoot, "carryctx");
  const guard = readdirSync(stateDirectory).find((name) => name.startsWith(".workflow-import-original.") && !name.endsWith("-wal") && !name.endsWith("-shm"));
  if (guard) {
    const guardPath = join(stateDirectory, guard);
    const result = Bun.spawnSync([process.env.FIXTURE_PYTHON, "-c", "import os,sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('PRAGMA journal_mode=WAL'); c.execute('PRAGMA wal_autocheckpoint=0'); c.execute('BEGIN IMMEDIATE'); c.execute(\\\"UPDATE projects SET name = name || '-held-final'\\\"); c.commit(); os._exit(0)", guardPath], { env: process.env });
    if (result.exitCode !== 0) process.exit(result.exitCode);
  }
}
 if (stage === "project" && process.argv[3] === "restore") {
  if (process.env.FIXTURE_RESTORE_FAILS === "1") process.exit(8);
  const restoreIndex = process.argv.indexOf("restore");
  const source = process.argv[restoreIndex + 1];
  const destination = join(stateRoot, "carryctx/state.sqlite");
  if (source && existsSync(source)) {
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
  }
  process.exit(0);
}
if (!["init", "import", "stats"].includes(stage)) process.exit(90);
if (stage === "init" || stage === "import") {
  const config = configPath;
  if (stage === "import") {
     const state = join(stateRoot, "carryctx/state.sqlite");
     const raceState = staging ? join(process.env.FIXTURE_COMMON, "carryctx/state.sqlite") : state;
     if (process.env.FIXTURE_RACE === "import-inode" && existsSync(raceState)) {
       const replacement = raceState + ".inode";
       copyFileSync(raceState, replacement);
       for (const suffix of ["-wal", "-shm"]) {
         if (existsSync(raceState + suffix)) copyFileSync(raceState + suffix, replacement + suffix);
       }
       renameSync(replacement, raceState);
       for (const suffix of ["-wal", "-shm"]) {
         if (existsSync(replacement + suffix)) {
           copyFileSync(replacement + suffix, raceState + suffix);
           rmSync(replacement + suffix, { force: true });
         }
       }
     }
     if (process.env.FIXTURE_RACE === "import" && existsSync(raceState)) appendFileSync(raceState, "import-race");
     importBackup = join(stateRoot, "carryctx/backups/pre_import_fixture.sqlite");
    mkdirSync(dirname(importBackup), { recursive: true });
     if (existsSync(state)) {
       copyFileSync(state, importBackup);
       for (const suffix of ["-wal", "-shm"]) {
         if (existsSync(state + suffix)) copyFileSync(state + suffix, importBackup + suffix);
       }
     } else writeFileSync(importBackup, "absent");
     if (process.env.FIXTURE_RACE === "import-path") {
       const replacement = raceState + ".replacement";
       writeFileSync(replacement, "replacement");
       rmSync(raceState, { force: true });
       symlinkSync(replacement, raceState);
     }
     if (process.env.FIXTURE_RACE === "carryctx-dir") {
       const stateDir = dirname(raceState);
       const moved = stateDir + ".moved";
       renameSync(stateDir, moved);
       mkdirSync(stateDir, { recursive: true });
       writeFileSync(raceState, "replacement");
     }
  }
  if (stage === "init" || process.env.FIXTURE_CHANGE === "overwrite") writeFileSync(config, "benign-replacement");
  if (stage === "init" && process.env.FIXTURE_INIT_MARKER) writeFileSync(process.env.FIXTURE_INIT_MARKER, "initialized");
  if (stage === "init" && process.env.FIXTURE_AUTHORITY_DB) {
    const destination = join(process.env.FIXTURE_COMMON, "carryctx/state.sqlite");
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(process.env.FIXTURE_AUTHORITY_DB, destination);
  } else if (stage === "init") {
    const destination = join(process.env.FIXTURE_COMMON, "carryctx/state.sqlite");
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, "initialized");
  }
  if (stage === "import" && process.env.FIXTURE_CHANGE === "delete") rmSync(config);
  if (stage === "import" && process.env.FIXTURE_CHANGE === "directory") rmSync(dirname(config), { recursive: true });
}
if (stage === process.env.FIXTURE_STAGE) process.exit(7);
if (stage === "import") {
  console.log(JSON.stringify({ schema_version: 1, command: "import.create", success: true, data: { preImportBackupPath: importBackup, operation: { applied: true } } }));
}`,
    );
    executable(
      "cp",
      `const args = process.argv.slice(2);
if (process.env.FIXTURE_RESTORE_FAILS === "1" && args.at(-1) === process.env.FIXTURE_CONFIG) process.exit(8);
const result = Bun.spawnSync([process.env.FIXTURE_CP, ...args]);
process.exit(result.exitCode);`,
    );
    const initMarker = join(root, "init.marker");
    const raceTarget = join(root, "race-config-target");
    const fixtureDatabase = join(project, "fake-git/carryctx/state.sqlite");
    if (options.realWal || options.walWithoutShm) {
      const beforeProject = Bun.spawnSync(
        [
          join(bin, "sqlite3"),
          "-readonly",
          "-batch",
          fixtureDatabase,
          "SELECT updated_at FROM projects;",
        ],
        { timeout: 10_000 },
      );
      if (beforeProject.exitCode !== 0) {
        throw new Error(beforeProject.stderr.toString());
      }
      projectUpdatedAtBefore = beforeProject.stdout.toString().trim();
      databaseBefore = readFileSync(fixtureDatabase);
      databaseIdentityBefore = `${statSync(fixtureDatabase).dev}:${statSync(fixtureDatabase).ino}`;
      walIdentityBefore = existsSync(`${fixtureDatabase}-wal`)
        ? `${statSync(`${fixtureDatabase}-wal`).dev}:${statSync(`${fixtureDatabase}-wal`).ino}`
        : undefined;
      shmIdentityBefore = existsSync(`${fixtureDatabase}-shm`)
        ? `${statSync(`${fixtureDatabase}-shm`).dev}:${statSync(`${fixtureDatabase}-shm`).ino}`
        : undefined;
      walBefore = {
        wal: readFileSync(`${fixtureDatabase}-wal`),
        shm: existsSync(`${fixtureDatabase}-shm`)
          ? readFileSync(`${fixtureDatabase}-shm`)
          : undefined,
      };
    }
    writeFileSync(raceTarget, original);
    const args = [join(bin, "bash"), script, "--project", project];
    if (options.force) args.push("--force");
    if (options.dryRun) args.push("--dry-run");
    const schemaVersion = options.schemaVersion ?? 18;
    const result = Bun.spawnSync(args, {
      cwd: project,
      env: {
        PATH: bin,
        HOME: root,
        TMPDIR: temp,
        FIXTURE_COMMON: join(project, "fake-git"),
        FIXTURE_PROJECT: project,
        FIXTURE_CONFIG: config,
        FIXTURE_CP: cp,
        FIXTURE_MV: realMv,
        FIXTURE_PYTHON: python,
        FIXTURE_LOG: log,
        FIXTURE_AUTHORITY_DB: authorityDatabase ?? "",
        FIXTURE_AUTHORITY_FAILURE: options.authorityFailure ? "1" : "0",
        FIXTURE_INIT_MARKER: initMarker,
        FIXTURE_RACE: options.race ?? "",
        FIXTURE_RACE_TARGET: raceTarget,
        FIXTURE_DB: join(project, "fake-git/carryctx/state.sqlite"),
        FIXTURE_DESCENDANT_MARKER: join(root, "descendant-leak.marker"),
        FIXTURE_STAGE: stage,
        FIXTURE_CHANGE: change,
        FIXTURE_RESTORE_FAILS: restoreFails ? "1" : "0",
        FIXTURE_SQLITE_MODE: options.sqliteMode ?? "valid",
        FIXTURE_SCHEMA_VERSION: String(schemaVersion),
        FIXTURE_MIGRATION_COUNT: String(
          options.migrationCount ?? schemaVersion,
        ),
        FIXTURE_MIGRATION_MIN: String(options.migrationMin ?? 1),
        FIXTURE_MIGRATION_MAX: String(options.migrationMax ?? schemaVersion),
        FIXTURE_MIGRATION_DISTINCT: String(
          options.migrationDistinct ?? schemaVersion,
        ),
        FIXTURE_MIGRATION_INVALID: String(options.migrationInvalid ?? 0),
        FIXTURE_PROJECT_ROWS: String(options.projectRows ?? 0),
        FIXTURE_PROJECT_INVALID: String(options.projectInvalid ?? 0),
        FIXTURE_ROW_TABLE: options.rowTable ?? "",
        FIXTURE_VERSION_FAILS: options.versionFails ? "1" : "0",
        FIXTURE_VERSION_MUTATES_TARGET: options.versionMutatesTarget
          ? "1"
          : "0",
        GIT_TIMEOUT: String(options.gitTimeout ?? 120),
        FIXTURE_VERSION_OUTPUT:
          options.versionOutput ?? realVersionEnvelope(schemaVersion),
      },
      timeout: 10_000,
    });
    const backups = readdirSync(temp)
      .map((entry) => join(temp, entry, "config.toml.before"))
      .filter((path) => existsSync(path));
    const currentDatabase = fixtureDatabase;
    const walSidecarsStable = walBefore
      ? existsSync(`${currentDatabase}-wal`) &&
        readFileSync(`${currentDatabase}-wal`).equals(walBefore.wal) &&
        (walBefore.shm
          ? existsSync(`${currentDatabase}-shm`) &&
            readFileSync(`${currentDatabase}-shm`).equals(walBefore.shm)
          : !existsSync(`${currentDatabase}-shm`))
      : undefined;
    let authoritySchemaObjectCount: number | undefined;
    let authorityFtsRelatedCount: number | undefined;
    if (authorityDatabase) {
      const inventory = Bun.spawnSync(
        [
          join(bin, "sqlite3"),
          "-readonly",
          "-batch",
          "-noheader",
          "-separator",
          "|",
          authorityDatabase,
          "SELECT COUNT(*), COALESCE(SUM(CASE WHEN name LIKE '%fts%' THEN 1 ELSE 0 END), 0) FROM sqlite_master;",
        ],
        { timeout: 10_000 },
      );
      if (inventory.exitCode !== 0) {
        throw new Error(inventory.stderr.toString());
      }
      const [objects, ftsRelated] = inventory.stdout
        .toString()
        .trim()
        .split("|")
        .map(Number);
      authoritySchemaObjectCount = objects;
      authorityFtsRelatedCount = ftsRelated;
    }
    const databaseStable = databaseBefore
      ? existsSync(currentDatabase) &&
        readFileSync(currentDatabase).equals(databaseBefore)
      : undefined;
    let projectUpdatedAtAfter: string | undefined;
    if (projectUpdatedAtBefore !== undefined && existsSync(currentDatabase)) {
      const afterProject = Bun.spawnSync(
        [
          join(bin, "sqlite3"),
          "-readonly",
          "-batch",
          currentDatabase,
          "SELECT updated_at FROM projects;",
        ],
        { timeout: 10_000 },
      );
      if (afterProject.exitCode !== 0) {
        throw new Error(afterProject.stderr.toString());
      }
      projectUpdatedAtAfter = afterProject.stdout.toString().trim();
    }
    const currentDatabaseIdentity = existsSync(currentDatabase)
      ? `${statSync(currentDatabase).dev}:${statSync(currentDatabase).ino}`
      : undefined;
    const currentWalIdentity = existsSync(`${currentDatabase}-wal`)
      ? `${statSync(`${currentDatabase}-wal`).dev}:${statSync(`${currentDatabase}-wal`).ino}`
      : undefined;
    const currentShmIdentity = existsSync(`${currentDatabase}-shm`)
      ? `${statSync(`${currentDatabase}-shm`).dev}:${statSync(`${currentDatabase}-shm`).ino}`
      : undefined;
    const sqliteFixture = join(bin, "sqlite3");
    const readProjectName = (path: string) => {
      if (!existsSync(path) || !existsSync(sqliteFixture)) return undefined;
      const query = Bun.spawnSync(
        [
          sqliteFixture,
          "-readonly",
          "-batch",
          path,
          "SELECT name FROM projects;",
        ],
        { timeout: 10_000 },
      );
      return query.exitCode === 0 ? query.stdout.toString().trim() : undefined;
    };
    const activeProjectName = readProjectName(currentDatabase);
    const stateDirectory = dirname(currentDatabase);
    const guardFile = existsSync(stateDirectory)
      ? readdirSync(stateDirectory).find(
          (name) =>
            name.startsWith(".workflow-import-original.") &&
            !name.endsWith("-wal") &&
            !name.endsWith("-shm"),
        )
      : undefined;
    const guardProjectName = guardFile
      ? readProjectName(join(stateDirectory, guardFile))
      : undefined;
    const fixtureResult = {
      exitCode: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
      commands: existsSync(log) ? readFileSync(log, "utf8") : "",
      config: existsSync(config) ? readFileSync(config, "utf8") : undefined,
      descendantLeak: existsSync(join(root, "descendant-leak.marker")),
      tempEntries: readdirSync(temp),
      databaseStable,
      projectStatePreserved:
        projectUpdatedAtBefore === undefined
          ? undefined
          : projectUpdatedAtAfter === projectUpdatedAtBefore,
      databaseIdentityStable:
        databaseIdentityBefore === undefined
          ? undefined
          : currentDatabaseIdentity === databaseIdentityBefore,
      walIdentityStable:
        walIdentityBefore === undefined
          ? undefined
          : currentWalIdentity === walIdentityBefore,
      shmIdentityStable:
        shmIdentityBefore === undefined
          ? undefined
          : currentShmIdentity === shmIdentityBefore,
      walSidecarsStable,
      walPendingBytes: walBefore?.wal.length,
      shmPendingBytes: walBefore?.shm?.length ?? 0,
      authoritySchemaObjectCount,
      authorityFtsRelatedCount,
      activeProjectName,
      guardProjectName,
      databaseContent:
        existsSync(currentDatabase) && statSync(currentDatabase).isFile()
          ? readFileSync(currentDatabase).toString()
          : undefined,
      backups: backups.map((path) => ({
        path,
        content: readFileSync(path, "utf8"),
      })),
    };
    return fixtureResult;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function expectNoImport(
  result: ReturnType<typeof runFixture>,
  allowFetch = false,
) {
  if (!allowFetch)
    expect(result.commands).not.toMatch(/\bgit\b[^\n]*\bfetch\b/);
  expect(result.commands).not.toMatch(/carryctx (?:init|import)\b/);
}

function expectUnknown(result: ReturnType<typeof runFixture>) {
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("unknown");
  expect(result.config).toBe(original);
  expectNoImport(result);
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

describe("workflow import local state classification with fake adapters", () => {
  test("accepts the real version envelope shape and classifies an absent database", () => {
    const result = runFixture("success", "none", false, { database: "absent" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("state=absent");
    expect(result.commands).toMatch(/carryctx init\b/);
    expect(result.commands).toMatch(/carryctx import\b/);
  });

  test("classifies a current-schema empty database and initializes before import", () => {
    const result = runFixture("success", "none", false, { database: "empty" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("state=empty");
    expect(result.commands).toMatch(/carryctx init\b/);
    expect(result.commands).toMatch(/carryctx import\b/);
  });

  test("treats a project row as non-empty even without data rows", () => {
    const result = runFixture("success", "none", false, {
      database: "non-empty",
      projectRows: 1,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("non-empty");
    expectNoImport(result);
  });

  for (const table of [
    "operations",
    "sequences",
    "worktree_cleanup_requests",
    "tombstones",
    "snapshot_state",
  ]) {
    test(`blocks rows found only in ${table}`, () => {
      const result = runFixture("success", "none", false, {
        database: "non-empty",
        rowTable: table,
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("non-empty");
      expectNoImport(result);
    });
  }

  test("blocks rows in actual disposable FTS shadow tables", () => {
    const result = runFixture("success", "none", false, { realFts: true });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("non-empty");
    expect(result.authoritySchemaObjectCount).toBe(129);
    expect(result.authorityFtsRelatedCount).toBe(36);
    expect(result.config).toBe(original);
    expectNoImport(result);
  });

  test("rejects schema drift in a real 0.11.6 database", () => {
    const result = runFixture("success", "none", false, {
      realSchemaDrift: true,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unknown");
    expectNoImport(result);
  });

  test("rejects migration drift in a real 0.11.6 database", () => {
    const result = runFixture("success", "none", false, {
      realMigrationDrift: true,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unknown");
    expectNoImport(result);
  });

  test("force-imports a real pending WAL database with valid sidecars", () => {
    const result = runFixture("success", "none", false, {
      realWal: true,
      force: true,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("state=non-empty");
    expect(result.walPendingBytes).toBeGreaterThan(0);
    expect(result.shmPendingBytes).toBeGreaterThan(0);
    expect(result.projectStatePreserved).toBe(true);
    expect(result.commands).toMatch(/carryctx import\b/);
  });

  test("force-imports a real pending WAL database without SHM", () => {
    const result = runFixture("success", "none", false, {
      walWithoutShm: true,
      force: true,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("state=non-empty");
    expect(result.walPendingBytes).toBeGreaterThan(0);
    expect(result.projectStatePreserved).toBe(true);
  });

  test("accepts fresh sidecar-free WAL mode for dry-run and force import", () => {
    const dryRun = runFixture("success", "none", false, {
      freshWal: true,
      dryRun: true,
      versionMutatesTarget: true,
    });
    expect(dryRun.exitCode).toBe(0);
    expect(dryRun.databaseStable).toBe(true);

    const force = runFixture("success", "none", false, {
      freshWal: true,
      force: true,
    });
    expect(force.exitCode).toBe(0);
    expect(force.stdout).toContain("state=non-empty");
  });

  test("blocks a real disposable table name containing a newline", () => {
    const result = runFixture("success", "none", false, {
      realNewlineTable: true,
    });
    expectUnknown(result);
  });

  test("allows --force for a valid non-empty database", () => {
    const result = runFixture("success", "none", false, {
      database: "non-empty",
      rowTable: "tombstones",
      force: true,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("--force");
    expect(result.commands).toMatch(/carryctx import\b/);
    expect(result.commands).not.toMatch(/carryctx init\b/);
  });

  test("allows a dry-run for a valid non-empty database without init", () => {
    const result = runFixture("success", "none", false, {
      database: "non-empty",
      rowTable: "tombstones",
      dryRun: true,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("dry-run PASS");
    expect(result.commands).toMatch(/carryctx-dry-run import\b/);
    expect(result.commands).not.toMatch(/carryctx init\b/);
  });

  for (const [name, options] of [
    ["WAL and SHM", { realWal: true }],
    ["WAL without SHM", { walWithoutShm: true }],
  ] as const) {
    test(`keeps real ${name} state unchanged during dry-run`, () => {
      const result = runFixture("success", "none", false, {
        ...options,
        dryRun: true,
        versionMutatesTarget: true,
      });
      expect(result.exitCode).toBe(0);
      expect(result.databaseStable).toBe(true);
      expect(result.walPendingBytes).toBeGreaterThan(0);
      expect(result.walSidecarsStable).toBe(true);
      if (name === "WAL and SHM") {
        expect(result.shmPendingBytes).toBeGreaterThan(0);
      }
      expect(result.commands).toMatch(
        /carryctx version --json --project .*version-contract/,
      );
      expect(result.commands).not.toMatch(/carryctx version --json\n/);
    });
  }

  const unknownScenarios: Array<[string, FixtureOptions]> = [
    ["unreadable", { database: "non-empty", sqliteMode: "unreadable" }],
    ["locked", { database: "non-empty", sqliteMode: "locked" }],
    ["timed out", { database: "non-empty", sqliteMode: "timeout" }],
    ["corrupt", { database: "non-empty", sqliteMode: "corrupt" }],
    [
      "newer",
      {
        database: "non-empty",
        migrationCount: 19,
        migrationMax: 19,
        migrationDistinct: 19,
      },
    ],
    [
      "partial migration history",
      {
        database: "non-empty",
        migrationCount: 17,
        migrationMax: 17,
        migrationDistinct: 17,
      },
    ],
    [
      "malformed schema output",
      { database: "non-empty", sqliteMode: "malformed" },
    ],
    [
      "migration identity drift",
      { database: "non-empty", sqliteMode: "migration-drift" },
    ],
    [
      "schema object drift",
      { database: "non-empty", sqliteMode: "schema-drift" },
    ],
    [
      "oversized schema object",
      { database: "non-empty", sqliteMode: "schema-line-overflow" },
    ],
    [
      "foreign-key violation",
      { database: "non-empty", sqliteMode: "foreign-key" },
    ],
    [
      "table inventory failure",
      { database: "non-empty", sqliteMode: "table-list-error" },
    ],
    [
      "missing project table",
      { database: "non-empty", sqliteMode: "missing-projects" },
    ],
    [
      "missing migration table",
      { database: "non-empty", sqliteMode: "missing-schema-migrations" },
    ],
    ["row count failure", { database: "non-empty", sqliteMode: "count-error" }],
    [
      "authority schema failure",
      { database: "non-empty", authorityFailure: true },
    ],
    ["malformed project row", { database: "non-empty", projectInvalid: 1 }],
    [
      "missing sqlite adapter",
      { database: "non-empty", sqliteAvailable: false },
    ],
    ["non-file database path", { database: "directory" }],
    [
      "unavailable schema contract",
      { database: "non-empty", versionFails: true },
    ],
    [
      "unavailable schema contract for absent database",
      { database: "absent", versionFails: true },
    ],
    ["orphan WAL sidecar", { database: "absent", orphanSidecar: true }],
    [
      "newline-containing table name",
      { database: "non-empty", sqliteMode: "newline-table" },
    ],
    [
      "overlong table name",
      { database: "non-empty", sqliteMode: "long-table-name" },
    ],
    [
      "too many tables",
      { database: "non-empty", sqliteMode: "too-many-tables" },
    ],
    [
      "duplicate table inventory entry",
      { database: "non-empty", sqliteMode: "duplicate-table" },
    ],
    [
      "invalid WAL sidecar",
      { database: "non-empty", sidecars: "wal", sqliteMode: "wal-invalid" },
    ],
    [
      "invalid SHM sidecar",
      { database: "non-empty", sidecars: "shm", sqliteMode: "wal-invalid" },
    ],
    [
      "invalid WAL and SHM sidecars",
      { database: "non-empty", sidecars: "both", sqliteMode: "wal-invalid" },
    ],
    ["symlinked database", { database: "non-empty", databaseSymlink: true }],
    ["symlinked WAL sidecar", { database: "non-empty", sidecarSymlink: true }],
  ];

  for (const [name, options] of unknownScenarios) {
    test(`blocks ${name} before fetch, init, or import`, () => {
      const result = runFixture("success", "none", false, options);
      if (name === "symlinked database" || name === "symlinked WAL sidecar") {
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("symlink");
        expect(result.config).toBe(original);
        expectNoImport(result);
      } else {
        expectUnknown(result);
      }
    });
  }

  test("enforces the portable command timeout", () => {
    const result = runFixture("success", "none", false, {
      database: "non-empty",
      sqliteMode: "hang",
      gitTimeout: 1,
    });
    expectUnknown(result);
  });

  test("blocks an existing CarryCtx admission lock", () => {
    const result = runFixture("success", "none", false, {
      database: "non-empty",
      rowTable: "tombstones",
      force: true,
      commandLock: true,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("already in progress");
    expectNoImport(result);
  });

  test("blocks a database mutation during fetch", () => {
    const result = runFixture("success", "none", false, {
      database: "non-empty",
      rowTable: "tombstones",
      force: true,
      race: "database",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("changed during fetch");
    expectNoImport(result, true);
  });

  test("preserves a writer that commits during import and aborts", () => {
    const result = runFixture("success", "none", false, {
      database: "non-empty",
      rowTable: "tombstones",
      force: true,
      race: "import",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("state changed while staging import");
    expect(result.commands).not.toMatch(/carryctx project restore\b/);
    expect(result.databaseContent).toBe("fixtureimport-race");
  });

  test("does not restore over a writer when recovery would fail", () => {
    const result = runFixture("success", "none", true, {
      database: "non-empty",
      rowTable: "tombstones",
      force: true,
      race: "import",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("state changed while staging import");
    expect(result.commands).not.toMatch(/carryctx project restore\b/);
  });

  test("fails closed when import replaces the database path with a symlink", () => {
    const result = runFixture("success", "none", false, {
      database: "non-empty",
      rowTable: "tombstones",
      force: true,
      race: "import-path",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "project paths changed while staging import",
    );
    expect(result.commands).not.toMatch(/carryctx project restore\b/);
  });

  test("fails closed when import replaces the CarryCtx directory", () => {
    const result = runFixture("success", "none", false, {
      database: "non-empty",
      rowTable: "tombstones",
      force: true,
      race: "carryctx-dir",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "project paths changed while staging import",
    );
    expect(result.commands).not.toMatch(/carryctx project restore\b/);
  });

  test("fails closed on a byte-identical database inode replacement at import", () => {
    const result = runFixture("success", "none", false, {
      realWal: true,
      force: true,
      race: "import-inode",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "project paths changed while staging import",
    );
    expect(result.databaseStable).toBe(true);
    expect(result.databaseIdentityStable).toBe(false);
    expect(result.commands).not.toMatch(/carryctx project restore\b/);
  });

  test("fails closed when WAL is injected into the hidden guard at handoff", () => {
    const result = runFixture("success", "none", false, {
      realWal: true,
      force: true,
      race: "guard-wal",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "post-handoff committed-state validation failed",
    );
    expect(result.activeProjectName).not.toContain("handoff-injected");
    expect(result.guardProjectName).toContain("handoff-injected");
  });

  test("fails closed when WAL is injected after the prior handoff validation", () => {
    const result = runFixture("success", "none", false, {
      realWal: true,
      force: true,
      race: "guard-after-validation",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "post-handoff committed-state validation failed",
    );
    expect(result.activeProjectName).not.toContain("held-final");
    expect(result.guardProjectName).toContain("held-final");
  });

  test("blocks an SHM inode replacement during fetch", () => {
    const result = runFixture("success", "none", false, {
      realWal: true,
      force: true,
      race: "fetch-shm-inode",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("changed during fetch");
    expect(result.shmIdentityStable).toBe(false);
    expectNoImport(result, true);
  });

  test("blocks a configuration path replacement during fetch", () => {
    const result = runFixture("success", "none", false, {
      race: "config",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("paths changed during fetch");
    expectNoImport(result, true);
  });

  test("uses job-control groups when setsid is unavailable", () => {
    const result = runFixture("success", "none", false, {
      database: "non-empty",
      rowTable: "tombstones",
      force: true,
      noSetsid: true,
    });
    expect(result.exitCode).toBe(0);
    expect(result.commands).toMatch(/carryctx import\b/);
  });

  test("terminates descendants when a probe command times out", () => {
    const result = runFixture("success", "none", false, {
      database: "non-empty",
      sqliteMode: "hang-descendant",
      gitTimeout: 1,
    });
    expectUnknown(result);
    expect(result.descendantLeak).toBe(false);
    expect(
      result.tempEntries.filter((entry) =>
        entry.startsWith("workflow-import."),
      ),
    ).toEqual([]);
  });

  test("does not allow --force to bypass unknown state", () => {
    const result = runFixture("success", "none", false, {
      database: "non-empty",
      sqliteMode: "corrupt",
      force: true,
    });
    expectUnknown(result);
  });
});

describe("workflow import path safety", () => {
  const pathScenarios: Array<[string, FixtureOptions]> = [
    ["symlinked project path", { projectSymlink: true }],
    ["symlinked project path component", { projectParentSymlink: true }],
    ["symlinked .carryctx directory", { carryctxSymlink: true }],
    ["symlinked config", { configSymlink: true }],
  ];

  for (const [name, options] of pathScenarios) {
    test(`rejects ${name} before init, restore, or import`, () => {
      const result = runFixture("success", "none", false, options);
      expect(result.exitCode).toBe(1);
      expect(result.config).toBe(original);
      expectNoImport(result);
    });
  }
});

describe("workflow import strict version envelope parsing", () => {
  const envelope = realVersionEnvelope(18);
  const malformed: Array<[string, string]> = [
    ["success false", envelope.replace('"success":true', '"success":false')],
    ["unsupported cli", envelope.replace('"cli":"0.11.6"', '"cli":"0.11.5"')],
    [
      "fractional db_schema",
      envelope.replace('"db_schema":18', '"db_schema":18.0'),
    ],
    [
      "exponent db_schema",
      envelope.replace('"db_schema":18', '"db_schema":1e2'),
    ],
    [
      "duplicate db_schema",
      envelope.replace('"db_schema":18,', '"db_schema":18,"db_schema":18,'),
    ],
    [
      "unknown envelope field",
      envelope.replace(
        '"command":"version",',
        '"command":"version","extra":true,',
      ),
    ],
    ["missing data path", envelope.replace(',"data":{', ",{")],
    ["multiple JSON lines", `${envelope}\n{}`],
    ["malformed JSON", "{"],
  ];

  for (const [name, versionOutput] of malformed) {
    test(`rejects ${name} before sqlite or import`, () => {
      const result = runFixture("success", "none", false, {
        database: "non-empty",
        versionOutput,
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("unknown");
      expect(result.commands).not.toMatch(/sqlite3 /);
      expectNoImport(result);
    });
  }
});
