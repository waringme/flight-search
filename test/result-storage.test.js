import test from "node:test";
import assert from "node:assert/strict";
import { createResultReader } from "../src/result-storage.js";

test("R2 reads resolve one published version and encode filenames", async () => {
  const requests = [];
  const read = await createResultReader({
    resultsBaseUrl: "https://data.example.com/flights",
    fetchImpl: async (url, options) => {
      requests.push({ url: url.href, options });
      return new Response(JSON.stringify(url.pathname.endsWith("/current.json")
        ? { prefix: "runs/123-2/" }
        : [{ SearchDate: "25-Oct-2026" }]));
    },
  });
  await read("Australia Flights.json");
  await read("Australia Flights.meta.json");
  assert.deepEqual(requests.map((request) => request.url), [
    "https://data.example.com/flights/current.json",
    "https://data.example.com/flights/runs/123-2/Australia%20Flights.json",
    "https://data.example.com/flights/runs/123-2/Australia%20Flights.meta.json",
  ]);
  assert.ok(requests.every(({ options }) =>
    options.cache === "no-store" && options.signal instanceof AbortSignal));
  assert.throws(() => read("../outside.json"), /Invalid R2 results filename/);
});

test("rejects unsafe R2 URLs and version manifests", async () => {
  for (const resultsBaseUrl of [
    "http://data.example.com/",
    "https://user:password@data.example.com/",
    "https://data.example.com/?token=secret",
    "https://data.example.com/#fragment",
  ]) {
    await assert.rejects(createResultReader({ resultsBaseUrl }), /public HTTPS URL/);
  }
  for (const manifest of [null, {}, { prefix: "../" }, { prefix: "https://elsewhere.example/" }]) {
    await assert.rejects(createResultReader({
      resultsBaseUrl: "https://data.example.com/",
      fetchImpl: async () => new Response(JSON.stringify(manifest)),
    }), /Invalid R2 current.json/);
  }
});

test("reports remote HTTP, JSON, and network failures", async () => {
  for (const status of [403, 404, 500]) {
    await assert.rejects(createResultReader({
      resultsBaseUrl: "https://data.example.com/",
      fetchImpl: async () => new Response("", { status }),
    }), new RegExp(`HTTP ${status}`));
  }
  await assert.rejects(createResultReader({
    resultsBaseUrl: "https://data.example.com/",
    fetchImpl: async () => new Response("{invalid"),
  }), SyntaxError);
  await assert.rejects(createResultReader({
    resultsBaseUrl: "https://data.example.com/",
    fetchImpl: async () => { throw new Error("Network unavailable"); },
  }), /Network unavailable/);
});
