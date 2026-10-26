import test from "node:test";
import assert from "node:assert/strict";
import { pruneResultFolders, selectRetainedFolders } from "../scripts/prune-r2-results.js";

const env = {
  R2_ACCOUNT_ID: "a".repeat(32),
  R2_BUCKET: "flight-results",
  AWS_ACCESS_KEY_ID: "test-key",
  AWS_SECRET_ACCESS_KEY: "test-secret",
};

function object(run, date) {
  return { Key: `runs/${run}/Australia Flights.json`, LastModified: date };
}

const objects = [
  object("100-1", "2026-10-23T10:00:00Z"),
  object("200-1", "2026-10-24T10:00:00Z"),
  object("300-1", "2026-10-25T10:00:00Z"),
  object("400-1", "2026-10-26T10:00:00Z"),
];

test("retains the current folder and newest other folder, removing oldest first", () => {
  const plan = selectRetainedFolders(objects, "runs/400-1/");
  assert.deepEqual(plan.keep, ["runs/400-1/", "runs/300-1/"]);
  assert.deepEqual(plan.remove, ["runs/100-1/", "runs/200-1/"]);
});

test("protects the current folder even when it is the oldest", () => {
  const plan = selectRetainedFolders(objects, "runs/100-1/");
  assert.deepEqual(plan.keep, ["runs/100-1/", "runs/400-1/"]);
  assert.deepEqual(new Set(plan.remove), new Set(["runs/200-1/", "runs/300-1/"]));
});

test("uses the latest object timestamp per folder and keeps run attempts distinct", () => {
  const plan = selectRetainedFolders([
    ...objects,
    { Key: "runs/200-1/North America Flights.json", LastModified: "2026-10-27T10:00:00Z" },
    object("400-2", "2026-10-26T11:00:00Z"),
  ], "runs/400-1/");
  assert.deepEqual(plan.keep, ["runs/400-1/", "runs/200-1/"]);
  assert.ok(plan.remove.includes("runs/400-2/"));
});

test("one or two existing folders need no deletions", () => {
  assert.deepEqual(selectRetainedFolders(objects.slice(0, 1), "runs/100-1/").remove, []);
  assert.deepEqual(selectRetainedFolders(objects.slice(0, 2), "runs/100-1/").remove, []);
});

test("rejects invalid pointers, missing published folders, and unexpected object paths", () => {
  for (const prefix of ["", "../", "runs/", "runs/100-1/../", "runs/missing/"]) {
    assert.throws(() => selectRetainedFolders(objects, prefix), /refusing to delete/);
  }
  assert.throws(() => selectRetainedFolders(objects, "runs/999-1/"), /Published results folder is missing/);
  for (const extra of [
    { Key: "current.json", LastModified: "2026-10-26T10:00:00Z" },
    { Key: "runs/private/file.json", LastModified: "2026-10-26T10:00:00Z" },
    { Key: "runs/100-1/file.json", LastModified: "invalid" },
  ]) {
    assert.throws(() => selectRetainedFolders([...objects, extra], "runs/400-1/"), /Unexpected object/);
  }
});

function createStorage(currentPrefix = "runs/400-1/") {
  let storedObjects = [...objects];
  const calls = [];
  return {
    calls,
    aws(args) {
      calls.push(args);
      if (args[0] === "s3api") {
        assert.equal(args[args.indexOf("--prefix") + 1], "runs/");
        assert.ok(!args.includes("--no-paginate"));
        return JSON.stringify({ Contents: storedObjects });
      }
      if (args[1] === "cp") {
        assert.equal(args[2], "s3://flight-results/current.json");
        return JSON.stringify({ prefix: currentPrefix });
      }
      assert.equal(args[1], "rm");
      assert.match(args[2], /^s3:\/\/flight-results\/runs\/\d+-\d+\/$/);
      const prefix = args[2].replace("s3://flight-results/", "");
      storedObjects = storedObjects.filter(({ Key }) => !Key.startsWith(prefix));
      return "";
    },
  };
}

test("deletes only exact obsolete run prefixes and verifies two folders remain", () => {
  const storage = createStorage();
  const keep = pruneResultFolders({ env, aws: storage.aws, log: () => {} });
  assert.deepEqual(keep, ["runs/400-1/", "runs/300-1/"]);
  const deletes = storage.calls.filter((args) => args[1] === "rm");
  assert.equal(deletes.length, 2);
  assert.ok(deletes.every((args) => args.includes("--recursive")));
});

test("aborts before deleting if current.json changes during cleanup", () => {
  const storage = createStorage();
  let reads = 0;
  assert.throws(() => pruneResultFolders({
    env,
    log: () => {},
    aws(args) {
      if (args[1] === "cp" && ++reads > 1) return JSON.stringify({ prefix: "runs/200-1/" });
      return storage.aws(args);
    },
  }), /current.json changed/);
  assert.ok(!storage.calls.some((args) => args[1] === "rm"));
});

test("missing configuration and listing failures cannot trigger deletions", () => {
  assert.throws(() => pruneResultFolders({ env: {}, aws: () => assert.fail("AWS must not be called") }), /Missing/);
  const storage = createStorage();
  assert.throws(() => pruneResultFolders({
    env, log: () => {},
    aws(args) {
      if (args[0] === "s3api") throw new Error("Access denied");
      return storage.aws(args);
    },
  }), /Access denied/);
  assert.ok(!storage.calls.some((args) => args[1] === "rm"));
});

test("reports failed and incomplete deletions rather than claiming success", () => {
  for (const fails of [true, false]) {
    const storage = createStorage();
    assert.throws(() => pruneResultFolders({
      env, log: () => {},
      aws(args) {
        if (args[1] === "rm") {
          if (fails) throw new Error("Deletion failed");
          return "";
        }
        return storage.aws(args);
      },
    }), fails ? /Deletion failed/ : /cleanup incomplete/);
  }
});
