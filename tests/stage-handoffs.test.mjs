import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

test("serial authorized stages preserve red baseline, same-file changes and squash", async t => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-stage-git-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const git = (...args) => {
    const r = spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  const childEnv = { ...process.env }; delete childEnv.NODE_TEST_CONTEXT;
  const run = () => spawnSync(process.execPath, ["--test", "stage.test.mjs"], { cwd, encoding: "utf8", env: childEnv });
  git("init", "-b", "main");
  git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  await writeFile(path.join(cwd, "stage.test.mjs"), 'import assert from "node:assert/strict"; import test from "node:test"; const implemented = false; test("stage behavior", () => assert.equal(implemented, false));\n');
  git("add", "stage.test.mjs"); git("commit", "-m", "Original baseline");
  const baseline = git("rev-parse", "HEAD");
  const original = await readFile(path.join(cwd, "stage.test.mjs"), "utf8");
  assert.equal(run().status, 0);
  const redSource = original.replace("assert.equal(implemented, false)", "assert.equal(implemented, true)");
  await writeFile(path.join(cwd, "stage.test.mjs"), redSource);
  assert.equal(run().status, 1, "expected red is authorized test-stage output");
  git("add", "stage.test.mjs"); git("commit", "-m", "Authorized red test stage");
  const red = git("rev-parse", "HEAD");
  await writeFile(path.join(cwd, "stage.test.mjs"), redSource.replace("const implemented = false", "const implemented = true"));
  assert.equal(run().status, 0);
  git("add", "stage.test.mjs"); git("commit", "-m", "Implementation stage edits same file");
  const green = git("rev-parse", "HEAD");
  assert.notEqual(red, green);
  assert.match(git("diff", red, green, "--", "stage.test.mjs"), /implemented = true/);
  assert.match(git("diff", baseline, red, "--", "stage.test.mjs"), /assert.equal\(implemented, true\)/);
  git("checkout", baseline, "--", "stage.test.mjs"); assert.equal(run().status, 0);
  git("checkout", green, "--", "stage.test.mjs"); assert.equal(run().status, 0);
  git("reset", "--soft", baseline); git("commit", "-m", "Final squash");
  assert.equal(git("rev-list", "--count", `${baseline}..HEAD`), "1");
  assert.equal(git("show", `${red}:stage.test.mjs`), redSource.trim());
  assert.equal(git("status", "--porcelain"), "");
  assert.match(git("diff", baseline, "HEAD"), /implemented = true/);
});

test("1.0 documents breaking removal and caller-managed stage migration", async () => {
  const docs = await readFile(path.join(root, "README.md"), "utf8");
  const requirements = [
    [/1\.0/, "chosen version"], [/breaking/i, "breaking release"],
    [/serial/i, "serial writers"], [/isolated.*worktree|worktree.*isolat/is, "isolated worktrees"],
    [/branch/i, "branch inspection"], [/HEAD/, "HEAD inspection"], [/dirty|uncommitted/i, "dirty inspection"],
    [/inherited|partial/i, "inherited work authorization"], [/explicit.*stag|stag.*explicit/is, "explicit task staging"],
    [/SHA/, "stage SHA"], [/red.*success|success.*red/is, "red test handoff"],
    [/read.only.*(?:not|never|no).*commit/is, "reviewers do not commit"], [/repair/i, "repair commits"],
    [/incomplete.*checkpoint|checkpoint.*incomplete/is, "partial checkpoints are not success"],
    [/baseline/i, "original test baseline"], [/rebas/i, "rebase verification"], [/squash/i, "final squash"],
    [/ignored/i, "ignored files not protected"], [/external|shared/i, "external files not protected"],
    [/parallel.*unsafe|unsafe.*parallel/is, "parallel same-worktree mutation unsafe"],
    [/no.*sandbox|not.*sandbox/is, "no sandbox promise"],
  ];
  for (const [pattern, reason] of requirements) assert.match(docs, pattern, reason);
  assert.doesNotMatch(docs, /file mutations are guarded|cross-process locks|one bash call per|owned files|lock count/i);
});
