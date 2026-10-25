import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  AER_LINGUS_REWARDS_SEARCH,
  AUSTRALIA_FLIGHTS_SEARCH,
  NORTH_AMERICA_FLIGHTS_SEARCH,
} from "./flight-results-csv.js";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FEATURE_REGISTRY = [
  AUSTRALIA_FLIGHTS_SEARCH,
  NORTH_AMERICA_FLIGHTS_SEARCH,
  AER_LINGUS_REWARDS_SEARCH,
];
const STATIC_FILES = new Map([
  ["/", { file: "index.html", contentType: "text/html; charset=utf-8" }],
  ["/app.js", { file: "app.js", contentType: "text/javascript; charset=utf-8" }],
  ["/styles.css", { file: "styles.css", contentType: "text/css; charset=utf-8" }],
]);

export function parseCsv(text) {
  const table = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted && character === '"' && text[index + 1] === '"') {
      cell += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") {
        index += 1;
      }
      row.push(cell);
      if (row.some((value) => value.length > 0)) {
        table.push(row);
      }
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }

  if (quoted) {
    throw new Error("CSV contains an unterminated quoted field.");
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    table.push(row);
  }
  if (table.length === 0) {
    return [];
  }

  const [headers, ...records] = table;
  return records.map((values) =>
    Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])),
  );
}

function createSearchTypes(rows, feature) {
  const grouped = new Map();
  for (const row of rows) {
    const id = [row.SearchDirection, row.ResultSet, row.LoyaltyScheme].join("|");
    const type = grouped.get(id) ?? {
      id,
      direction: row.SearchDirection,
      resultSet: row.ResultSet,
      loyaltyScheme: row.LoyaltyScheme,
      count: 0,
    };
    type.count += 1;
    grouped.set(id, type);
  }

  const upgradeTypesByArea = new Map();
  for (const type of grouped.values()) {
    if (!type.resultSet.startsWith("BA upgrade-carrier search")) continue;
    const area = type.resultSet.includes("· Asia") ? "asia" : "australia";
    const existing = upgradeTypesByArea.get(area);
    if (existing) {
      existing.count += type.count;
    } else {
      upgradeTypesByArea.set(area, {
        id: `ba-upgrade-voucher-${area}`,
        direction: area === "asia" ? "Europe and Asia" : "Europe and Australia",
        resultSet: `BA upgrade-carrier search · ${area === "asia" ? "Asia" : "Australia"}`,
        loyaltyScheme: "BA Executive Club (Avios)",
        count: type.count,
        label: `BA Upgrade Voucher · ${area === "asia" ? "Asia" : "Australia"}`,
        filter: `ba-upgrade-voucher-${area}`,
      });
    }
  }
  const types = [...grouped.values()]
    .filter((type) => !type.resultSet.startsWith("BA upgrade-carrier search"))
    .map((type) => {
      const schemeLabel = type.loyaltyScheme.includes("Qantas")
        ? "Qantas Points"
        : type.loyaltyScheme.includes("BA Executive")
          ? "BA Avios"
          : type.loyaltyScheme;
      const resultSetLabel = type.resultSet === "UK BA-carrier-filtered search"
        ? "BA carrier scan"
        : type.resultSet.replace(" loyalty search", " awards");
      return {
        ...type,
        label: [type.direction, schemeLabel, resultSetLabel].filter(Boolean).join(" · "),
      };
    });
  const upgradeTypes = feature.id === AUSTRALIA_FLIGHTS_SEARCH.id
    ? [...upgradeTypesByArea.values()]
    : [];
  if (feature.id === NORTH_AMERICA_FLIGHTS_SEARCH.id) {
    for (const [scheme, loyaltyScheme, schemeLabel] of [
      ["BA", "BA Executive Club (Avios)", "BA Avios"],
      ["QF", "Qantas Frequent Flyer (Qantas Points)", "Qantas Points"],
    ]) {
      for (const direction of ["Europe to North America", "North America to Europe"]) {
        const id = [direction, `${scheme} loyalty search`, loyaltyScheme].join("|");
        if (grouped.has(id)) continue;
        types.push({
          id,
          direction,
          resultSet: `${scheme} loyalty search`,
          loyaltyScheme,
          count: 0,
          label: `${direction} · ${schemeLabel} · ${scheme} awards`,
        });
      }
    }
  }
  if (feature.id === AUSTRALIA_FLIGHTS_SEARCH.id) {
    for (const area of ["australia", "asia"]) {
      if (!upgradeTypesByArea.has(area)) {
        upgradeTypes.push({
          id: `ba-upgrade-voucher-${area}`,
          direction: area === "asia" ? "Europe and Asia" : "Europe and Australia",
          resultSet: `BA upgrade-carrier search · ${area === "asia" ? "Asia" : "Australia"}`,
          loyaltyScheme: "BA Executive Club (Avios)",
          count: 0,
          label: `BA Upgrade Voucher · ${area === "asia" ? "Asia" : "Australia"}`,
          filter: `ba-upgrade-voucher-${area}`,
        });
      }
    }
  }

  return [...types, ...upgradeTypes].sort((left, right) => left.label.localeCompare(right.label));
}

function parseResultRows(content, filename) {
  const rows = JSON.parse(content);
  if (!Array.isArray(rows) || rows.some((row) =>
    !row || typeof row !== "object" || Array.isArray(row)
    || !["SearchDate", "SearchDirection", "ResultSet", "LoyaltyScheme"].every(
      (key) => typeof row[key] === "string",
    )
  )) {
    throw new Error(`Invalid flight results JSON: ${filename}. Expected an array of flight rows.`);
  }
  return rows;
}

async function readFeatureRows(feature, projectRoot) {
  try {
    const content = await readFile(path.join(projectRoot, feature.outputFile), "utf8");
    return parseResultRows(content, feature.outputFile);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const metadata = await readFeatureMetadata(feature, projectRoot);
    if (!Array.isArray(metadata.quarterlyChunks) || metadata.quarterlyChunks.length === 0) {
      throw error;
    }
    const chunks = await Promise.all(metadata.quarterlyChunks.map(async (chunk) => {
      if (typeof chunk.file !== "string" || path.basename(chunk.file) !== chunk.file
        || !chunk.file.endsWith(".json") || !Number.isInteger(chunk.rows) || chunk.rows < 0) {
        throw new Error(`Invalid quarterly JSON chunk for ${feature.name}.`);
      }
      const content = await readFile(path.join(projectRoot, chunk.file), "utf8");
      const rows = parseResultRows(content, chunk.file);
      if (rows.length !== chunk.rows) {
        throw new Error(`Quarterly JSON row count mismatch: ${chunk.file}.`);
      }
      return rows;
    }));
    return chunks.flat();
  }
}

async function readFeatureMetadata(feature, projectRoot) {
  try {
    return JSON.parse(await readFile(path.join(projectRoot, feature.metadataFile), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

function writeJsonHeaders(response, statusCode) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
}

function sendJson(response, statusCode, body) {
  writeJsonHeaders(response, statusCode);
  response.end(JSON.stringify(body));
}

async function sendResults(response, metadata, rows) {
  function* chunks() {
    yield `${JSON.stringify(metadata).slice(0, -1)},"rows":[`;
    for (let index = 0; index < rows.length; index += 100) {
      yield `${index === 0 ? "" : ","}${rows.slice(index, index + 100)
        .map((row) => JSON.stringify(row)).join(",")}`;
    }
    yield "]}";
  }

  writeJsonHeaders(response, 200);
  await pipeline(Readable.from(chunks()), response);
}

function sendError(response, statusCode, message) {
  sendJson(response, statusCode, { error: message });
}

export function createRequestHandler({ projectRoot = PROJECT_ROOT } = {}) {
  return async (request, response) => {
    if (request.method !== "GET") {
      response.setHeader("Allow", "GET");
      sendError(response, 405, "Only GET requests are supported.");
      return;
    }

    const requestUrl = new URL(request.url ?? "/", "http://localhost");
    if (requestUrl.pathname === "/api/features") {
      try {
        const features = await Promise.all(
          FEATURE_REGISTRY.map(async (feature) => {
            const rows = await readFeatureRows(feature, projectRoot);
            return {
              id: feature.id,
              name: feature.name,
              searchTypes: createSearchTypes(rows, feature),
            };
          }),
        );
        sendJson(response, 200, { features });
      } catch (error) {
        console.error("Unable to load search feature list:", error);
        sendError(response, 500, "Could not load search features. Check that their JSON files are valid and exist.");
      }
      return;
    }

    const featureMatch = requestUrl.pathname.match(/^\/api\/features\/([a-z0-9-]+)\/results$/);
    if (featureMatch) {
      const feature = FEATURE_REGISTRY.find((item) => item.id === featureMatch[1]);
      if (!feature) {
        sendError(response, 404, "Search feature not found.");
        return;
      }

      try {
        const [rows, metadata] = await Promise.all([
          readFeatureRows(feature, projectRoot),
          readFeatureMetadata(feature, projectRoot),
        ]);
        await sendResults(response, {
          feature: { id: feature.id, name: feature.name },
          searchDate: rows[0]?.SearchDate ?? "",
          rateLimitRemaining: metadata.rateLimitRemaining ?? null,
        }, rows);
      } catch (error) {
        console.error(`Unable to load results for ${feature.name}:`, error);
        if (response.headersSent || response.destroyed) {
          response.destroy(error);
        } else {
          sendError(response, 500, `Could not load ${feature.name} results. Check that its JSON files are valid and exist.`);
        }
      }
      return;
    }

    const staticFile = STATIC_FILES.get(requestUrl.pathname);
    if (!staticFile) {
      sendError(response, 404, "Page not found.");
      return;
    }

    try {
      const content = await readFile(path.join(projectRoot, "public", staticFile.file));
      response.writeHead(200, {
        "Content-Type": staticFile.contentType,
        "Cache-Control": "no-cache",
        "Content-Security-Policy": "default-src 'self'; connect-src 'self'; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(content);
    } catch (error) {
      console.error(`Unable to serve ${staticFile.file}:`, error);
      sendError(response, 500, "Could not load the web application.");
    }
  };
}

export function createAppServer(options) {
  return createServer(createRequestHandler(options));
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error("PORT must be a valid TCP port.");
    process.exitCode = 1;
  } else {
    const server = createAppServer();
    server.listen(port, "127.0.0.1", () => {
      console.log(`Flight search UI listening on http://127.0.0.1:${port}`);
    });
    server.on("error", (error) => {
      console.error("Unable to start flight search UI:", error.message);
      process.exitCode = 1;
    });
  }
}
