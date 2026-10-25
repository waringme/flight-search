import { readFile } from "node:fs/promises";
import path from "node:path";

export async function createResultReader({ projectRoot, resultsBaseUrl, fetchImpl = fetch }) {
  if (!resultsBaseUrl) {
    return (filename) => readFile(path.join(projectRoot, filename), "utf8");
  }

  const baseUrl = new URL(resultsBaseUrl);
  if (baseUrl.protocol !== "https:" || baseUrl.username || baseUrl.password
    || baseUrl.search || baseUrl.hash) {
    throw new Error("FLIGHT_RESULTS_BASE_URL must be a public HTTPS URL without credentials, query, or fragment.");
  }
  if (!baseUrl.pathname.endsWith("/")) baseUrl.pathname += "/";

  async function readRemote(url) {
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(30_000),
      cache: "no-store",
    });
    if (!response.ok) {
      const error = new Error(`Unable to load R2 results: ${url.pathname} (HTTP ${response.status}).`);
      if (response.status === 404) error.code = "ENOENT";
      throw error;
    }
    return response.text();
  }

  const manifest = JSON.parse(await readRemote(new URL("current.json", baseUrl)));
  if (!manifest || typeof manifest.prefix !== "string"
    || !/^runs\/\d+-\d+\/$/.test(manifest.prefix)) {
    throw new Error("Invalid R2 current.json: expected a versioned runs/<run-id>-<attempt>/ prefix.");
  }
  const publishedUrl = new URL(manifest.prefix, baseUrl);
  return (filename) => {
    if (path.basename(filename) !== filename || !filename.endsWith(".json")) {
      throw new Error("Invalid R2 results filename.");
    }
    return readRemote(new URL(encodeURIComponent(filename), publishedUrl));
  };
}
