import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const workflow = readFileSync(new URL("../.github/workflows/refresh-flights.yml", import.meta.url), "utf8");
const uploadScript = workflow.split("        run: |\n").at(-1)
  .split("\n      - name:")[0]
  .split("\n").map((line) => line.replace(/^          /, "")).join("\n");

test("scheduled publisher uploads a version before updating the current pointer", (context) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "flight-publish-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const result = spawnSync("bash", ["-s"], {
    encoding: "utf8",
    env: {
      ...process.env,
      RUNNER_TEMP: directory,
      R2_ACCOUNT_ID: "test-account",
      R2_BUCKET: "test-bucket",
      GITHUB_RUN_ID: "123",
      GITHUB_RUN_ATTEMPT: "2",
    },
    input: `aws() { printf '%s\\n' "$*" >> "$RUNNER_TEMP/calls"; }\n${uploadScript}`,
  });
  assert.equal(result.status, 0, result.stderr);
  const calls = readFileSync(path.join(directory, "calls"), "utf8").trim().split("\n");
  assert.equal(calls.length, 2);
  assert.match(calls[0], /s3:\/\/test-bucket\/runs\/123-2\//);
  assert.match(calls[0], /--exclude \* --include \*\.json --exclude history\/\*/);
  assert.match(calls[0], /--cache-control public, max-age=31536000, immutable/);
  assert.match(calls[1], /s3:\/\/test-bucket\/current.json/);
  assert.match(calls[1], /--cache-control no-store/);
  assert.deepEqual(JSON.parse(readFileSync(path.join(directory, "current.json"), "utf8")),
    { prefix: "runs/123-2/" });
});

test("failed dataset upload does not publish a new pointer", (context) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "flight-publish-failure-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const result = spawnSync("bash", ["-s"], {
    encoding: "utf8",
    env: {
      ...process.env,
      RUNNER_TEMP: directory,
      R2_ACCOUNT_ID: "test-account",
      R2_BUCKET: "test-bucket",
      GITHUB_RUN_ID: "123",
      GITHUB_RUN_ATTEMPT: "2",
    },
    input: `aws() { printf '%s\\n' "$*" >> "$RUNNER_TEMP/calls"; return 75; }\n${uploadScript}`,
  });
  assert.equal(result.status, 75);
  assert.equal(readFileSync(path.join(directory, "calls"), "utf8").trim().split("\n").length, 1);
  assert.equal(existsSync(path.join(directory, "current.json")), false);
});

test("automatic and manual R2 cleanup share the publisher concurrency lock", () => {
  const manual = readFileSync(new URL("../.github/workflows/prune-flight-results.yml", import.meta.url), "utf8");
  for (const config of [workflow, manual]) {
    assert.match(config, /group: refresh-flight-results/);
    assert.match(config, /cancel-in-progress: false/);
    assert.match(config, /run: node scripts\/prune-r2-results\.js/);
  }
  assert.match(manual, /workflow_dispatch:/);
  assert.ok(workflow.indexOf("- name: Keep only two result folders")
    > workflow.indexOf("- name: Upload JSON and publish completed scan"));
});
