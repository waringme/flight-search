import {
  AER_LINGUS_REWARDS_SEARCH,
  AUSTRALIA_FLIGHTS_SEARCH,
  NORTH_AMERICA_FLIGHTS_SEARCH,
  writeFlightResultsJson,
} from "./flight-results-csv.js";

const API_BASE_URL = "https://seats.aero";
const DEFAULT_ORIGINS = "LHR,LGW,EDI,MAN,BHX,GLA,BRS,NCL,ABZ";
const DEFAULT_DESTINATIONS = "SYD,MEL,BNE";
const DEFAULT_EUROPEAN_ORIGINS =
  "LHR,LGW,EDI,MAN,BHX,GLA,BRS,NCL,ABZ,CDG,AMS,FRA,MUC,ZRH,BRU,VIE,MAD,BCN,FCO,MXP,CPH,ARN,OSL,HEL,DUB,LIS,ATH,WAW,PRG";
const DEFAULT_AUSTRALIAN_AIRPORTS = "SYD,MEL,BNE";
const DEFAULT_ASIAN_AIRPORTS = "BKK,HKG,HND,KUL,PVG,SIN";
const DEFAULT_NORTH_AMERICAN_AIRPORTS =
  "JFK,LAX,YYZ,YVR";
const DEFAULT_NORTH_AMERICAN_ORIGINS = "LHR,CDG,AMS,FRA";
const DEFAULT_LOYALTY_SCHEMES = "BA,QF";
const LOYALTY_SOURCES = {
  BA: { source: "british", program: "BA Executive Club (Avios)" },
  QF: { source: "qantas", program: "Qantas Frequent Flyer (Qantas Points)" },
};
const AER_LINGUS_LOYALTY_PROGRAMS = [
  { source: "british", scheme: "BA", program: "BA Executive Club (Avios)" },
  { source: "alaska", scheme: "Alaska", program: "Alaska Airlines Mileage Plan" },
  { source: "united", scheme: "United", program: "United Airlines MileagePlus" },
  { source: "american", scheme: "American", program: "American Airlines AAdvantage" },
];

function parseOptions(args, now = new Date()) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help") {
      return { help: true };
    }
    if (argument === "--aer-lingus-only") {
      options.aerLingusOnly = true;
      continue;
    }
    if (argument !== "--start" && argument !== "--end") {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing date after ${argument}`);
    }
    options[argument.slice(2)] = value;
    index += 1;
  }

  const today = now.toISOString().slice(0, 10);
  const twelveMonthsLater = new Date(now);
  twelveMonthsLater.setUTCFullYear(twelveMonthsLater.getUTCFullYear() + 1);
  const startDate = options.start ?? today;
  const endDate = options.end ?? twelveMonthsLater.toISOString().slice(0, 10);

  if (!isIsoDate(startDate) || !isIsoDate(endDate)) {
    throw new Error("Dates must be valid calendar dates in YYYY-MM-DD format.");
  }
  if (endDate < startDate) {
    throw new Error("--end must be on or after --start.");
  }

  return {
    startDate,
    endDate,
    ...(options.aerLingusOnly ? { aerLingusOnly: true } : {}),
  };
}

function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function parseAirportCodes(value, variableName) {
  const airports = value.split(",").map((airport) => airport.trim().toUpperCase());
  if (airports.some((airport) => !/^[A-Z]{3}$/.test(airport))) {
    throw new Error(`${variableName} must be a comma-separated list of three-letter airport codes.`);
  }
  return [...new Set(airports)];
}

function parseLoyaltySchemes(value) {
  const schemes = value.split(",").map((scheme) => scheme.trim().toUpperCase());
  if (schemes.some((scheme) => !Object.hasOwn(LOYALTY_SOURCES, scheme))) {
    throw new Error("LOYALTY_SCHEMES must contain BA and/or QF.");
  }
  return [...new Set(schemes)];
}

function buildSearchUrl({
  origins,
  destinations,
  carrier,
  source,
  startDate,
  endDate,
  cabins = "first,business,premium",
}) {
  const url = new URL("/partnerapi/search", API_BASE_URL);
  url.searchParams.set("origin_airport", origins.join(","));
  url.searchParams.set("destination_airport", destinations.join(","));
  url.searchParams.set("start_date", startDate);
  url.searchParams.set("end_date", endDate);
  url.searchParams.set("cabins", cabins);
  if (carrier) {
    url.searchParams.set("carriers", carrier);
  }
  if (source) {
    url.searchParams.set("source", source);
  }
  url.searchParams.set("include_trips", "true");
  url.searchParams.set("take", "1000");
  return url;
}

function extractRows(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (payload && typeof payload === "object") {
    for (const key of ["data", "results", "availability"]) {
      if (Array.isArray(payload[key])) {
        return payload[key];
      }
    }
  }
  throw new Error("Seats.aero response did not contain an availability array.");
}

function nextPageUrl(payload) {
  if (!payload?.hasMore) {
    return null;
  }
  if (typeof payload.moreURL !== "string" || payload.moreURL.length === 0) {
    throw new Error("Seats.aero indicated more results but did not provide moreURL.");
  }
  const url = new URL(payload.moreURL, API_BASE_URL);
  if (url.origin !== API_BASE_URL || !url.pathname.startsWith("/partnerapi/")) {
    throw new Error("Seats.aero returned an unexpected pagination URL.");
  }
  return url;
}

async function fetchAvailability(url, apiKey, fetchImpl = fetch, rateLimit = null) {
  const recordsById = new Map();
  const visitedPages = new Set();
  let pageUrl = url;

  while (pageUrl) {
    if (visitedPages.has(pageUrl.href)) {
      throw new Error("Seats.aero returned a repeated pagination URL.");
    }
    visitedPages.add(pageUrl.href);

    const response = await fetchImpl(pageUrl, {
      headers: { "Partner-Authorization": apiKey },
    });
    if (!response.ok) {
      throw new Error(`Seats.aero API request failed with HTTP ${response.status}.`);
    }
    const remainingHeader = response.headers?.get("x-ratelimit-remaining") ?? null;
    const remaining = remainingHeader === null ? Number.NaN : Number(remainingHeader);
    if (rateLimit && Number.isFinite(remaining)) {
      rateLimit.remaining = rateLimit.remaining === null
        ? remaining
        : Math.min(rateLimit.remaining, remaining);
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error("Seats.aero returned invalid JSON.");
    }

    for (const record of extractRows(payload)) {
      if (!record || typeof record !== "object" || typeof record.ID !== "string") {
        throw new Error("Seats.aero returned an availability record without an ID.");
      }
      recordsById.set(record.ID, record);
    }
    pageUrl = nextPageUrl(payload);
  }

  return [...recordsById.values()];
}

function getPositiveSeatCount(value) {
  const count = typeof value === "number" ? value : Number(value);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

function findMatches(records) {
  const economy = [];
  const firstClass = [];
  const business = [];
  const voucherCandidates = [];

  for (const record of records) {
    const economySeats = getPositiveSeatCount(record.YRemainingSeats);
    const firstClassSeats = getPositiveSeatCount(record.FRemainingSeats);
    const businessSeats = getPositiveSeatCount(record.JRemainingSeats);
    const premiumSeats = getPositiveSeatCount(record.WRemainingSeats);
    if (economySeats > 0) {
      economy.push({ ...record, matchingCabin: "economy", matchingSeats: economySeats });
    }
    if (firstClassSeats > 0) {
      firstClass.push({ ...record, matchingCabin: "first", matchingSeats: firstClassSeats });
    }
    if (businessSeats > 0) {
      business.push({ ...record, matchingCabin: "business", matchingSeats: businessSeats });
    }
    if (premiumSeats > 0) {
      voucherCandidates.push({
        ...record,
        matchingCabin: "premium",
        matchingSeats: premiumSeats,
        note: "Premium-economy award seats; confirm BA operating carrier and voucher eligibility before treating as an upgrade candidate.",
      });
    }
  }

  return { economy, firstClass, business, voucherCandidates };
}

function filterCarrierOperatedRecords(records, operatingCarrier) {
  return records.flatMap((record) => {
    if (!Array.isArray(record.AvailabilityTrips)) {
      return record.Carriers === operatingCarrier ? [record] : [];
    }

    const baTrips = record.AvailabilityTrips.filter((trip) => {
      if (typeof trip.Carriers !== "string") {
        return false;
      }
      const carriers = trip.Carriers.split(/[,\s/]+/).filter(Boolean);
      return carriers.length > 0 && carriers.every((carrier) => carrier === operatingCarrier);
    });
    if (baTrips.length === 0) {
      return [];
    }

    const remainingSeatsByCabin = (cabin) =>
      Math.max(
        0,
        ...baTrips
          .filter((trip) => trip.Cabin?.toLowerCase() === cabin)
          .map((trip) => getPositiveSeatCount(trip.RemainingSeats)),
      );

    return [
      {
        ...record,
        AvailabilityTrips: baTrips,
        YRemainingSeats: remainingSeatsByCabin("economy"),
        JRemainingSeats: remainingSeatsByCabin("business"),
        WRemainingSeats: remainingSeatsByCabin("premium"),
        FRemainingSeats: remainingSeatsByCabin("first"),
      },
    ];
  });
}

function buildAerLingusSearchConfigs() {
  const regions = [
    {
      direction: "Europe to Americas",
      origins: ["EUR", "MAN", "SNN"],
      destinations: ["USA", "CAD", "CAR", "MXC"],
    },
    {
      direction: "Americas to Europe",
      origins: ["USA", "CAD", "CAR", "MXC"],
      destinations: ["EUR"],
    },
    {
      direction: "Europe to Europe",
      origins: ["EUR", "MAN", "SNN"],
      destinations: ["EUR", "MAN", "SNN"],
    },
  ];
  return AER_LINGUS_LOYALTY_PROGRAMS.flatMap((program) =>
    regions.map((region) => ({ ...program, ...region })),
  );
}

async function runAerLingusSearch({
  apiKey,
  options,
  outputDirectory = process.cwd(),
  fetchImpl = fetch,
  generatedAt = new Date(),
  rateLimit = { remaining: null },
}) {
  const aerLingusSearches = await Promise.all(
    buildAerLingusSearchConfigs().map(async ({
      source,
      scheme,
      program,
      direction,
      origins,
      destinations,
    }) => {
      const sourceUrl = buildSearchUrl({
        origins,
        destinations,
        carrier: "EI",
        source,
        cabins: "premium,business",
        ...options,
      });
      const fetchedRecords = await fetchAvailability(sourceUrl, apiKey, fetchImpl, rateLimit);
      const sourceRecords = filterCarrierOperatedRecords(fetchedRecords, "EI");
      return {
        direction,
        scheme,
        program,
        source,
        origins,
        destinations,
        records: sourceRecords.length,
        ...findMatches(sourceRecords),
      };
    }),
  );
  const searchDate = generatedAt.toISOString().slice(0, 10);
  const exportResult = writeFlightResultsJson(
    { aerLingusSearches },
    searchDate,
    AER_LINGUS_REWARDS_SEARCH,
    outputDirectory,
    generatedAt,
    { rateLimitRemaining: rateLimit.remaining },
  );
  return { aerLingusSearches, rateLimit, exportResult, searchDate };
}

function printHelp() {
  console.log("Usage: npm run search -- [--start YYYY-MM-DD] [--end YYYY-MM-DD] [--aer-lingus-only]");
  console.log("Searches today through the next 12 months by default.");
  console.log(`Searches both directions for the configured loyalty schemes and writes ${AUSTRALIA_FLIGHTS_SEARCH.outputFile}.`);
  console.log(`Use --aer-lingus-only to update only ${AER_LINGUS_REWARDS_SEARCH.outputFile}.`);
}

async function main(args = process.argv.slice(2), env = process.env) {
  const options = parseOptions(args);
  if (options.help) {
    printHelp();
    return;
  }

  const apiKey = env.SEATS_AERO_API_KEY;
  if (!apiKey) {
    throw new Error("SEATS_AERO_API_KEY is missing. Set it in .env or the environment.");
  }

  if (options.aerLingusOnly) {
    const aerLingusResult = await runAerLingusSearch({
      apiKey,
      options,
      outputDirectory: process.cwd(),
    });
    const summarizeSearch = (search) => ({
      direction: search.direction,
      program: search.program,
      availabilityRecords: search.records,
      premiumRecords: search.voucherCandidates.length,
      businessRecords: search.business.length,
    });
    console.log(JSON.stringify({
      searchFeature: AER_LINGUS_REWARDS_SEARCH.name,
      searched: { startDate: options.startDate, endDate: options.endDate },
      rateLimitRemaining: aerLingusResult.rateLimit.remaining,
      searches: aerLingusResult.aerLingusSearches.map(summarizeSearch),
      jsonExport: {
        file: AER_LINGUS_REWARDS_SEARCH.outputFile,
        historyFile: aerLingusResult.exportResult.historyPath,
        timestamp: aerLingusResult.exportResult.timestamp,
        rows: aerLingusResult.exportResult.rowCount,
        searchDate: aerLingusResult.searchDate,
        rateLimitRemaining: aerLingusResult.rateLimit.remaining,
      },
    }, null, 2));
    return;
  }

  const origins = parseAirportCodes(env.ORIGIN_AIRPORTS ?? DEFAULT_ORIGINS, "ORIGIN_AIRPORTS");
  const destinations = parseAirportCodes(
    env.DESTINATION_AIRPORTS ?? DEFAULT_DESTINATIONS,
    "DESTINATION_AIRPORTS",
  );
  const australianAirports = parseAirportCodes(
    env.AUSTRALIAN_AIRPORTS ?? DEFAULT_AUSTRALIAN_AIRPORTS,
    "AUSTRALIAN_AIRPORTS",
  );
  const asianAirports = parseAirportCodes(
    env.ASIAN_AIRPORTS ?? DEFAULT_ASIAN_AIRPORTS,
    "ASIAN_AIRPORTS",
  );
  const northAmericanAirports = parseAirportCodes(
    env.NORTH_AMERICAN_AIRPORTS ?? DEFAULT_NORTH_AMERICAN_AIRPORTS,
    "NORTH_AMERICAN_AIRPORTS",
  );
  const northAmericanOrigins = parseAirportCodes(
    env.NORTH_AMERICAN_ORIGIN_AIRPORTS ?? DEFAULT_NORTH_AMERICAN_ORIGINS,
    "NORTH_AMERICAN_ORIGIN_AIRPORTS",
  );
  const europeanOrigins = parseAirportCodes(
    env.EUROPEAN_ORIGIN_AIRPORTS ?? DEFAULT_EUROPEAN_ORIGINS,
    "EUROPEAN_ORIGIN_AIRPORTS",
  );
  const loyaltySchemes = parseLoyaltySchemes(env.LOYALTY_SCHEMES ?? DEFAULT_LOYALTY_SCHEMES);
  const carrier = env.OPERATING_CARRIER ?? "BA";
  const upgradeCarrier = env.UPGRADE_CARRIER ?? "BA";
  for (const [name, value] of [
    ["OPERATING_CARRIER", carrier],
    ["UPGRADE_CARRIER", upgradeCarrier],
  ]) {
    if (!/^[A-Z0-9]{2,3}$/i.test(value)) {
      throw new Error(`${name} must be a two- or three-character airline code.`);
    }
  }

  const url = buildSearchUrl({
    origins,
    destinations,
    carrier: carrier.toUpperCase(),
    ...options,
  });
  const rateLimit = { remaining: null };
  const records = await fetchAvailability(url, apiKey, fetch, rateLimit);
  const matches = findMatches(records);
  const europeanSearches = await Promise.all(
    loyaltySchemes.flatMap((scheme) => {
      const { source, program } = LOYALTY_SOURCES[scheme];
      return [
        {
          direction: "Europe to Australia",
          origins: europeanOrigins,
          destinations: australianAirports,
        },
        {
          direction: "Australia to Europe",
          origins: australianAirports,
          destinations: europeanOrigins,
        },
        {
          direction: "Europe to Asia",
          origins: europeanOrigins,
          destinations: asianAirports,
        },
        {
          direction: "Asia to Europe",
          origins: asianAirports,
          destinations: europeanOrigins,
        },
      ].map(async ({ direction, origins: searchOrigins, destinations: searchDestinations }) => {
        const sourceUrl = buildSearchUrl({
          origins: searchOrigins,
          destinations: searchDestinations,
          source,
          ...options,
        });
        const sourceRecords = await fetchAvailability(sourceUrl, apiKey, fetch, rateLimit);
        return {
          direction,
          scheme,
          program,
          source,
          origins: searchOrigins,
          destinations: searchDestinations,
          records: sourceRecords.length,
          ...findMatches(sourceRecords),
        };
      });
    }),
  );
  const upgradeSearches = await Promise.all(
    [
      {
        direction: "Europe to Australia",
        origins: europeanOrigins,
        destinations: australianAirports,
      },
      {
        direction: "Australia to Europe",
        origins: australianAirports,
        destinations: europeanOrigins,
      },
    ].map(async ({ direction, origins: searchOrigins, destinations: searchDestinations }) => {
      const upgradeUrl = buildSearchUrl({
        origins: searchOrigins,
        destinations: searchDestinations,
        source: "british",
        carrier: upgradeCarrier.toUpperCase(),
        ...options,
      });
      const upgradeRecords = filterCarrierOperatedRecords(
        await fetchAvailability(upgradeUrl, apiKey, fetch, rateLimit),
        upgradeCarrier.toUpperCase(),
      );
      return {
        direction,
        program: LOYALTY_SOURCES.BA.program,
        source: "british",
        operatingCarrier: upgradeCarrier.toUpperCase(),
        origins: searchOrigins,
        destinations: searchDestinations,
        records: upgradeRecords.length,
        ...findMatches(upgradeRecords),
      };
    }),
  );
  const asiaUpgradeSearches = await Promise.all(
    [
      {
        direction: "Europe to Asia",
        origins: europeanOrigins,
        destinations: asianAirports,
      },
      {
        direction: "Asia to Europe",
        origins: asianAirports,
        destinations: europeanOrigins,
      },
    ].map(async ({ direction, origins: searchOrigins, destinations: searchDestinations }) => {
      const upgradeUrl = buildSearchUrl({
        origins: searchOrigins,
        destinations: searchDestinations,
        source: "british",
        carrier: upgradeCarrier.toUpperCase(),
        ...options,
      });
      const upgradeRecords = filterCarrierOperatedRecords(
        await fetchAvailability(upgradeUrl, apiKey, fetch, rateLimit),
        upgradeCarrier.toUpperCase(),
      );
      return {
        direction,
        program: LOYALTY_SOURCES.BA.program,
        source: "british",
        operatingCarrier: upgradeCarrier.toUpperCase(),
        origins: searchOrigins,
        destinations: searchDestinations,
        records: upgradeRecords.length,
        ...findMatches(upgradeRecords),
      };
    }),
  );
  const northAmericaSearches = await Promise.all(
    loyaltySchemes.flatMap((scheme) => {
      const { source, program } = LOYALTY_SOURCES[scheme];
      return [
        {
          direction: "Europe to North America",
          origins: northAmericanOrigins,
          destinations: northAmericanAirports,
        },
        {
          direction: "North America to Europe",
          origins: northAmericanAirports,
          destinations: northAmericanOrigins,
        },
      ].map(async ({ direction, origins: searchOrigins, destinations: searchDestinations }) => {
        const sourceUrl = buildSearchUrl({
          origins: searchOrigins,
          destinations: searchDestinations,
          source,
          ...options,
        });
        const sourceRecords = await fetchAvailability(sourceUrl, apiKey, fetch, rateLimit);
        return {
          direction,
          scheme,
          program,
          source,
          origins: searchOrigins,
          destinations: searchDestinations,
          records: sourceRecords.length,
          ...findMatches(sourceRecords),
        };
      });
    }),
  );
  const aerLingusResult = await runAerLingusSearch({
    apiKey,
    options,
    rateLimit,
    generatedAt: new Date(),
  });
  const aerLingusSearches = aerLingusResult.aerLingusSearches;
  const searchResults = {
    searched: {
      origins,
      destinations,
      operatingCarrier: carrier.toUpperCase(),
      startDate: options.startDate,
      endDate: options.endDate,
      records: records.length,
    },
    ...matches,
    europeanProgramSearches: europeanSearches,
    baUpgradeSearches: upgradeSearches,
    asiaUpgradeSearches,
    northAmericaSearches,
    aerLingusSearches,
    rateLimit,
  };
  const searchDate = new Date().toISOString().slice(0, 10);
  const metadata = {
    rateLimitRemaining: rateLimit.remaining,
  };
  const exportResult = writeFlightResultsJson(
    searchResults,
    searchDate,
    AUSTRALIA_FLIGHTS_SEARCH,
    process.cwd(),
    new Date(),
    metadata,
  );
  const northAmericaExport = writeFlightResultsJson(
    searchResults,
    searchDate,
    NORTH_AMERICA_FLIGHTS_SEARCH,
    process.cwd(),
    new Date(),
    metadata,
  );
  const aerLingusExport = writeFlightResultsJson(
    searchResults,
    searchDate,
    AER_LINGUS_REWARDS_SEARCH,
    process.cwd(),
    new Date(),
    metadata,
  );
  const summarizeSearch = ({
    direction,
    program,
    scheme,
    records,
    firstClass,
    business,
    voucherCandidates,
  }) => ({
    direction,
    program: program ?? scheme,
    availabilityRecords: records,
    firstClassRecords: firstClass.length,
    businessRecords: business.length,
    premiumRecords: voucherCandidates.length,
  });
  console.log(JSON.stringify({
    searchFeature: AUSTRALIA_FLIGHTS_SEARCH.name,
    searched: searchResults.searched,
    rateLimitRemaining: rateLimit.remaining,
    loyaltySearches: europeanSearches.map(summarizeSearch),
    australiaUpgradeSearches: upgradeSearches.map(summarizeSearch),
    asiaUpgradeSearches: asiaUpgradeSearches.map(summarizeSearch),
    northAmericaSearches: northAmericaSearches.map(summarizeSearch),
    aerLingusSearches: aerLingusSearches.map((search) => ({
      ...summarizeSearch(search),
    })),
    jsonExport: {
      file: AUSTRALIA_FLIGHTS_SEARCH.outputFile,
      historyFile: exportResult.historyPath,
      timestamp: exportResult.timestamp,
      rows: exportResult.rowCount,
      searchDate,
      rateLimitRemaining: rateLimit.remaining,
    },
    northAmericaJsonExport: {
      file: NORTH_AMERICA_FLIGHTS_SEARCH.outputFile,
      historyFile: northAmericaExport.historyPath,
      timestamp: northAmericaExport.timestamp,
      rows: northAmericaExport.rowCount,
      searchDate,
      rateLimitRemaining: rateLimit.remaining,
    },
    aerLingusJsonExport: {
      file: AER_LINGUS_REWARDS_SEARCH.outputFile,
      historyFile: aerLingusExport.historyPath,
      timestamp: aerLingusExport.timestamp,
      rows: aerLingusExport.rowCount,
      searchDate,
      rateLimitRemaining: rateLimit.remaining,
    },
  }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

export {
  buildAerLingusSearchConfigs,
  buildSearchUrl,
  extractRows,
  fetchAvailability,
  filterCarrierOperatedRecords,
  findMatches,
  isIsoDate,
  nextPageUrl,
  parseAirportCodes,
  parseLoyaltySchemes,
  parseOptions,
  runAerLingusSearch,
};
