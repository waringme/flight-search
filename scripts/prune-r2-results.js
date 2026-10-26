import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const RUN_PREFIX = /^runs\/\d+-\d+\/$/;

export function selectRetainedFolders(objects, currentPrefix) {
  if (!RUN_PREFIX.test(currentPrefix)) {
    throw new Error("Invalid current.json prefix; refusing to delete any R2 objects.");
  }
  if (!Array.isArray(objects)) throw new Error("Invalid R2 object listing.");
  const folders = new Map();
  for (const object of objects) {
    const prefix = typeof object.Key === "string" ? object.Key.match(/^runs\/\d+-\d+\//)?.[0] : null;
    const modified = Date.parse(object.LastModified);
    if (!prefix || !Number.isFinite(modified)) {
      throw new Error("Unexpected object in runs/; refusing to delete any R2 objects.");
    }
    folders.set(prefix, Math.max(folders.get(prefix) ?? 0, modified));
  }
  if (!folders.has(currentPrefix)) {
    throw new Error("Published results folder is missing; refusing to delete any R2 objects.");
  }
  const others = [...folders.keys()].filter((prefix) => prefix !== currentPrefix)
    .sort((left, right) => folders.get(right) - folders.get(left) || right.localeCompare(left));
  return {
    keep: [currentPrefix, ...others.slice(0, 1)],
    remove: others.slice(1).reverse(),
  };
}

function runAws(args) {
  return execFileSync("aws", args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function pruneResultFolders({ env = process.env, aws = runAws, log = console.log } = {}) {
  for (const key of ["R2_ACCOUNT_ID", "R2_BUCKET", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]) {
    if (!env[key]) throw new Error(`Missing ${key}; no R2 cleanup performed.`);
  }
  if (!/^[a-f0-9]{32}$/i.test(env.R2_ACCOUNT_ID) || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(env.R2_BUCKET)) {
    throw new Error("Invalid R2 account ID or bucket name; no R2 cleanup performed.");
  }
  const endpoint = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const bucket = `s3://${env.R2_BUCKET}/`;
  const callAws = (args) => aws([...args, "--endpoint-url", endpoint]);
  const readCurrentPrefix = () => JSON.parse(callAws(["s3", "cp", `${bucket}current.json`, "-"])).prefix;
  const listObjects = () => {
    const listing = JSON.parse(callAws([
      "s3api", "list-objects-v2", "--bucket", env.R2_BUCKET, "--prefix", "runs/", "--output", "json",
    ]));
    if (!listing || typeof listing !== "object" || Array.isArray(listing)) {
      throw new Error("Invalid R2 object listing.");
    }
    return listing.Contents ?? [];
  };
  const currentPrefix = readCurrentPrefix();
  const { keep, remove } = selectRetainedFolders(listObjects(), currentPrefix);
  log(`Keeping ${keep.join(", ")}`);
  for (const prefix of remove) {
    if (readCurrentPrefix() !== currentPrefix) {
      throw new Error("current.json changed during cleanup; stopped without deleting the next folder.");
    }
    log(`Deleting old results folder ${prefix}`);
    callAws(["s3", "rm", `${bucket}${prefix}`, "--recursive", "--only-show-errors"]);
  }
  const remaining = selectRetainedFolders(listObjects(), readCurrentPrefix());
  if (remaining.remove.length > 0) throw new Error("R2 cleanup incomplete: more than two result folders remain.");
  log(`R2 cleanup complete: ${remaining.keep.length} result folder(s) remain.`);
  return remaining.keep;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    pruneResultFolders();
  } catch (error) {
    console.error("R2 cleanup failed:", error.message);
    process.exitCode = 1;
  }
}
