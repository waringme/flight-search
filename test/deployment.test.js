import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import handler from "../api/index.js";
import { createRequestHandler } from "../src/server.js";

const headers = "SearchDate,SearchDirection,ResultSet,LoyaltyScheme,Cabin,Notes\n";
const row = "2026-10-24,Europe to North America,BA loyalty search,BA Executive Club (Avios),Business,";

async function startServer(context, requestHandler) {
  const server = createServer(requestHandler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

function createFixture(context) {
  const projectRoot = mkdtempSync(path.join(os.tmpdir(), "flight-deployment-"));
  context.after(() => rmSync(projectRoot, { recursive: true, force: true }));
  for (const name of ["Australia Flights", "North America Flights", "Aer Lingus Rewards"]) {
    writeFileSync(path.join(projectRoot, `${name}.csv`), `${headers}${row}saved\n`);
  }
  return projectRoot;
}

test("Vercel exports a callable handler without starting the local server", async (context) => {
  assert.equal(typeof handler, "function");
  const baseUrl = await startServer(context, handler);
  for (const route of ["/", "/app.js", "/styles.css", "/api/features"]) {
    const response = await fetch(`${baseUrl}${route}`);
    assert.equal(response.status, 200, route);
    await response.arrayBuffer();
  }
  const missing = await fetch(`${baseUrl}/not-found`);
  assert.equal(missing.status, 404);
  await missing.arrayBuffer();
  const post = await fetch(baseUrl, { method: "POST" });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("allow"), "GET");
  await post.arrayBuffer();
});

test("Vercel configuration routes requests to the function and bundles saved data", () => {
  const config = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
  assert.equal(config.framework, null);
  assert.deepEqual(config.rewrites, [{ source: "/(.*)", destination: "/api/index" }]);
  assert.equal(config.functions["api/index.js"].includeFiles, "{public/**,*.csv,*.meta.json}");
  assert.equal(config.functions["api/index.js"].excludeFiles, "{history/**,test/**,.env,.env.*}");
});

test("loads committed quarterly CSVs when the combined export is missing", async (context) => {
  const projectRoot = createFixture(context);
  rmSync(path.join(projectRoot, "North America Flights.csv"));
  const quarterlyChunks = [
    { file: "North America Flights 2026-Q4.csv", rows: 1 },
    { file: "North America Flights 2027-Q1.csv", rows: 1 },
  ];
  writeFileSync(path.join(projectRoot, quarterlyChunks[0].file), `${headers}${row}"first, ""quoted"""\n`);
  writeFileSync(path.join(projectRoot, quarterlyChunks[1].file), `${headers}${row}second\n`);
  writeFileSync(path.join(projectRoot, "North America Flights.meta.json"), JSON.stringify({
    rateLimitRemaining: 738,
    quarterlyChunks,
  }));
  const baseUrl = await startServer(context, createRequestHandler({ projectRoot }));
  const features = await fetch(`${baseUrl}/api/features`);
  assert.equal(features.status, 200);
  assert.equal((await features.json()).features.length, 3);
  const response = await fetch(`${baseUrl}/api/features/north-america-flights/results`);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.searchDate, "2026-10-24");
  assert.equal(result.rateLimitRemaining, 738);
  assert.deepEqual(result.rows.map((item) => item.Notes), ['first, "quoted"', "second"]);
  assert.equal(result.feature.id, "north-america-flights");
});

test("prefers the current combined CSV over older quarterly exports", async (context) => {
  const projectRoot = createFixture(context);
  writeFileSync(path.join(projectRoot, "North America Flights.meta.json"), JSON.stringify({
    quarterlyChunks: [{ file: "missing-quarter.csv", rows: 1 }],
  }));
  const baseUrl = await startServer(context, createRequestHandler({ projectRoot }));
  const response = await fetch(`${baseUrl}/api/features/north-america-flights/results`);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).rows.map((item) => item.Notes), ["saved"]);
});

test("reports missing, malformed, or incomplete quarterly data as errors", async (context) => {
  const projectRoot = createFixture(context);
  rmSync(path.join(projectRoot, "North America Flights.csv"));
  const baseUrl = await startServer(context, createRequestHandler({ projectRoot }));
  const metadataPath = path.join(projectRoot, "North America Flights.meta.json");
  const chunkFile = "North America Flights 2026-Q4.csv";
  writeFileSync(path.join(projectRoot, chunkFile), `${headers}${row}saved\n`);
  const messages = [];
  context.mock.method(console, "error", (...args) => messages.push(args));
  for (const metadata of [
    {},
    { quarterlyChunks: [] },
    { quarterlyChunks: [{ file: "missing.csv", rows: 1 }] },
    { quarterlyChunks: [{ file: chunkFile, rows: 2 }] },
    { quarterlyChunks: [{ file: "../outside.csv", rows: 1 }] },
  ]) {
    writeFileSync(metadataPath, JSON.stringify(metadata));
    const response = await fetch(`${baseUrl}/api/features/north-america-flights/results`);
    assert.equal(response.status, 500);
    assert.match((await response.json()).error, /Could not load North America Flights/);
  }
  writeFileSync(metadataPath, "{invalid");
  const features = await fetch(`${baseUrl}/api/features`);
  assert.equal(features.status, 500);
  assert.match((await features.json()).error, /Could not load search features/);
  assert.equal(messages.length, 6);
});

test("streams large results as valid JSON without changing the response shape", async (context) => {
  const projectRoot = createFixture(context);
  const notes = "x".repeat(10000);
  writeFileSync(path.join(projectRoot, "Australia Flights.csv"),
    `${headers}${`${row}${notes}\n`.repeat(600)}`);
  const baseUrl = await startServer(context, createRequestHandler({ projectRoot }));
  const response = await fetch(`${baseUrl}/api/features/australia-flights/results`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("transfer-encoding"), "chunked");
  const text = await response.text();
  assert.ok(Buffer.byteLength(text) > 4.5 * 1024 * 1024);
  const result = JSON.parse(text);
  assert.deepEqual(Object.keys(result), ["feature", "searchDate", "rateLimitRemaining", "rows"]);
  assert.equal(result.rows.length, 600);
  assert.ok(result.rows.every((item) => item.Notes === notes));
});

test("streams an empty export as an empty rows array", async (context) => {
  const projectRoot = createFixture(context);
  writeFileSync(path.join(projectRoot, "Australia Flights.csv"), headers);
  const baseUrl = await startServer(context, createRequestHandler({ projectRoot }));
  const response = await fetch(`${baseUrl}/api/features/australia-flights/results`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    feature: { id: "australia-flights", name: "Australia Flights" },
    searchDate: "",
    rateLimitRemaining: null,
    rows: [],
  });
});
