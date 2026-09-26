import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  attestLiveSocketEndpoint,
  connectLiveSocket,
  isLiveSocketSupported,
  liveSocketPlatform,
} from "../src/ipc-socket.js";

const repositoryRoot = resolve(import.meta.dir, "..");
const repositoryFile = (path: string): string =>
  readFileSync(resolve(repositoryRoot, path), "utf8");

// Job names are the status contexts a workflow reports. In this repository's
// workflows a job key sits at two-space indentation and its keys, including
// name, at four, so a four-space name is a job name and never a step name.
const workflowJobNames = (): string[] => {
  const directory = resolve(repositoryRoot, ".github/workflows");
  return readdirSync(directory)
    .filter((entry) => entry.endsWith(".yml") || entry.endsWith(".yaml"))
    .sort()
    .flatMap((entry) => {
      const names: string[] = [];
      let inJobs = false;
      for (const line of repositoryFile(`.github/workflows/${entry}`).split(
        "\n",
      )) {
        if (/^jobs:\s*$/u.test(line)) {
          inJobs = true;
          continue;
        }
        if (inJobs && /^\S/u.test(line)) inJobs = false;
        const match = inJobs ? line.match(/^ {4}name: (.+)$/u) : null;
        if (match?.[1])
          names.push(match[1].trim().replace(/^["']|["']$/gu, ""));
      }
      return names;
    });
};

describe("offline platform contract", () => {
  test("advertises only the implemented live adapter", () => {
    const platform = process.platform;
    expect(liveSocketPlatform()).toBe(
      platform === "linux" ? "linux" : "unsupported",
    );
    expect(isLiveSocketSupported()).toBe(platform === "linux");
  });

  test("non-Linux entry points fail before endpoint access", async () => {
    if (process.platform === "linux") return;
    await expect(
      attestLiveSocketEndpoint({
        socketPath: "/synthetic.sock",
        runtimeUid: 1000,
      }),
    ).rejects.toThrow("unsupported");
    await expect(
      connectLiveSocket({ socketPath: "/synthetic.sock", runtimeUid: 1000 }),
    ).rejects.toThrow("unsupported");
  });

  test("CodeQL activates the checked-in configuration for every language", () => {
    const workflow = repositoryFile(".github/workflows/codeql.yml");
    const config = repositoryFile(".github/codeql/codeql-config.yml");
    expect(workflow).toContain("config-file: .github/codeql/codeql-config.yml");
    expect(workflow).toContain(
      'category: "/language:javascript-typescript,actions"',
    );
    expect(workflow).toContain('category: "/language:rust"');
    expect(workflow).toContain("languages: javascript-typescript, actions");
    expect(workflow).toContain("languages: rust");
    expect(workflow.match(/build-mode: none/gu)).toHaveLength(1);
    expect(workflow.match(/build-mode: autobuild/gu)).toHaveLength(1);
    expect(config).toContain("uses: security-and-quality");
    expect(config).toContain("paths-ignore:");
  });

  test("every required status context is emitted by a workflow job name", () => {
    const required = repositoryFile(".github/required-status-checks.txt")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
    expect(required.length).toBeGreaterThan(0);
    const emitted = workflowJobNames();
    for (const context of required) {
      expect(emitted).toContain(context);
    }
  });

  test("the required combined CodeQL context keeps its exact job name", () => {
    // Branch protection on main requires this context character for character;
    // a per-language matrix would rename it and block every pull request.
    const workflow = repositoryFile(".github/workflows/codeql.yml");
    expect(workflow).toContain(
      "name: Analyze (javascript-typescript, actions)",
    );
    expect(workflow).not.toContain("matrix.language");
    expect(workflowJobNames()).toContain(
      "Analyze (javascript-typescript, actions)",
    );
  });

  test("toolchain, lockfile, CI, and changelog metadata agree", () => {
    const packageMetadata = repositoryFile("package.json");
    const lockfile = repositoryFile("bun.lock");
    const changelog = repositoryFile("CHANGELOG.md");
    const workflow = repositoryFile(".github/workflows/ci.yml");
    const hooks = repositoryFile("lefthook.yml");
    const justfile = repositoryFile("justfile");
    const typeConfig = repositoryFile("tsconfig.check.json");
    const declaredCarryctx = (
      JSON.parse(packageMetadata) as {
        devDependencies: { carryctx: string };
      }
    ).devDependencies.carryctx;
    expect(packageMetadata).toContain('"packageManager": "bun@1.4.2"');
    expect(lockfile).toContain('"@types/bun": "1.4.2"');
    expect(lockfile).toContain('"bun-types": "1.4.2"');
    expect(lockfile).toContain(`"carryctx": "${declaredCarryctx}"`);
    expect(workflow.match(/bun-version: 1\.4\.2/gu)).toHaveLength(3);
    expect(workflow.match(/bun install --frozen-lockfile/gu)).toHaveLength(2);
    expect(hooks).toContain("run: just check");
    expect(hooks).toContain("same full quality gate as CI");
    expect(justfile).toContain("bun test --max-concurrency=1");
    expect(changelog).toContain("`bun.lock` is synchronized");
    expect(changelog).not.toContain("`bun.lock` is unchanged");
    expect(changelog).not.toContain("CI still installs Bun `1.4.0`");
    expect(typeConfig).toContain('"exclude": ["tests/campaign.test.ts"]');
  });

  test("protocol ownership is split at the CTX-0080 boundary", () => {
    const boundary = repositoryFile("src/protocol-boundary.ts");
    expect(boundary).toContain("CTX-0079 owns src/protocol.ts");
    expect(boundary).toContain("CTX-0080");
    expect(boundary).toContain("validateLiveRequest");
  });

  test("platform metadata does not claim connected peer authentication", () => {
    const files = [
      "README.md",
      "CHANGELOG.md",
      "crates/devtools-client/Cargo.toml",
      "src/auth.ts",
      "src/cli.ts",
      "src/client.ts",
      "src/ipc-socket.ts",
      "src/transport.ts",
      "crates/devtools-client/src/auth.rs",
      "crates/devtools-client/src/ipc_socket.rs",
    ].map(repositoryFile);
    const text = files.join("\n");
    expect(text).not.toContain("live IPC with peer-creds");
    expect(text).not.toContain("real IPC socket/pipe peer-creds");
    expect(text).not.toContain("verified Linux OS socket");
    expect(text).not.toContain(
      "--socket <path>     Explicit Bitty IPC socket path (advisory)",
    );
    expect(text).not.toContain("BITTY_RUNTIME_UID");
    expect(text).toContain("endpoint-attested");
    expect(text).toContain("authenticated: false");
  });
});
