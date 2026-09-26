import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "..");
const fixtureSuitePath = "tests/workflow-import.test.ts";
const fixtureSuite = readFileSync(
  resolve(repositoryRoot, fixtureSuitePath),
  "utf8",
);

// Bun's built-in per-test deadline. Fixtures in this repository drive real
// child processes, so a test allowed less than the budget it drives reports a
// timeout instead of a result.
const BUN_DEFAULT_TEST_TIMEOUT_MS = 5_000;

const declaredNumber = (name: string): number => {
  const match = fixtureSuite.match(
    new RegExp(`^const ${name} = ([0-9_]+);$`, "mu"),
  );
  if (!match?.[1]) throw new Error(`Missing declaration: ${name}`);
  return Number(match[1].replaceAll("_", ""));
};

describe("workflow import test budget", () => {
  test("declares the budgets the fixture suite derives from", () => {
    expect(declaredNumber("FIXTURE_SPAWN_TIMEOUT_MS")).toBe(10_000);
    expect(
      declaredNumber("MAX_SEQUENTIAL_FIXTURE_RUNS"),
    ).toBeGreaterThanOrEqual(2);
    expect(declaredNumber("FIXTURE_TEST_HEADROOM_MS")).toBeGreaterThan(0);
  });

  test("keeps the outer per-test budget above the inner spawn budget", () => {
    const inner = declaredNumber("FIXTURE_SPAWN_TIMEOUT_MS");
    const runs = declaredNumber("MAX_SEQUENTIAL_FIXTURE_RUNS");
    const headroom = declaredNumber("FIXTURE_TEST_HEADROOM_MS");
    const outer = runs * inner + headroom;
    // The regression this guards: the outer deadline must never be reachable
    // before the inner budget a single fixture run may consume, and must cover
    // every sequential run one test is allowed to drive.
    expect(outer).toBeGreaterThan(inner);
    expect(outer).toBeGreaterThanOrEqual(runs * inner);
    // Bun's default is shorter than a single inner budget, which is why the
    // suite carries an explicit derived deadline instead of the default.
    expect(BUN_DEFAULT_TEST_TIMEOUT_MS).toBeLessThan(inner);
    // The wrapper must apply the derived budget, not a second literal.
    expect(fixtureSuite).toContain(
      "test(name, body, FIXTURE_TEST_TIMEOUT_MS);",
    );
    expect(fixtureSuite).toMatch(
      /^const FIXTURE_TEST_TIMEOUT_MS =\n {2}MAX_SEQUENTIAL_FIXTURE_RUNS \* FIXTURE_SPAWN_TIMEOUT_MS \+\n {2}FIXTURE_TEST_HEADROOM_MS;$/mu,
    );
  });

  test("no fixture spawn carries a budget literal", () => {
    const spawnBudgets = [
      ...fixtureSuite.matchAll(/timeout: (\w+)(?![\w])/gu),
    ].map((match) => match[1]);
    expect(spawnBudgets.length).toBe(7);
    for (const name of spawnBudgets) {
      expect(name).toBe("FIXTURE_SPAWN_TIMEOUT_MS");
    }
    // A reintroduced literal would silently decouple a spawn deadline from the
    // derived outer budget.
    expect(fixtureSuite).not.toMatch(/timeout: [0-9][0-9_]*[,}]/u);
  });

  test("every test definition in the fixture suite carries the outer budget", () => {
    const wrapped = [...fixtureSuite.matchAll(/^\s*fixtureTest\(/gmu)].length;
    expect(wrapped).toBeGreaterThan(0);
    // The only bare test( definition permitted is the wrapper's own
    // delegation; any other would inherit Bun's shorter default deadline.
    const bare = [...fixtureSuite.matchAll(/(?<![\w.])test\([^\n]*/gu)].map(
      (match) => match[0].trim(),
    );
    expect(bare).toEqual(["test(name, body, FIXTURE_TEST_TIMEOUT_MS);"]);
  });
});
