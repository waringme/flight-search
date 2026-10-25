import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AER_LINGUS_REWARDS_SEARCH,
  AUSTRALIA_FLIGHTS_SEARCH,
  createFlightResultsCsv,
  NORTH_AMERICA_FLIGHTS_SEARCH,
  writeFlightResultsJson,
} from "../src/flight-results-csv.js";
import { createAppServer, parseCsv } from "../src/server.js";
import {
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
} from "../src/index.js";

test("uses a twelve-month default date window", () => {
  assert.deepEqual(parseOptions([], new Date("2026-10-23T12:00:00.000Z")), {
    startDate: "2026-10-23",
    endDate: "2027-10-23",
  });
});

test("accepts explicit dates and rejects invalid or reversed dates", () => {
  assert.deepEqual(parseOptions(["--start", "2027-01-01", "--end", "2027-12-31"]), {
    startDate: "2027-01-01",
    endDate: "2027-12-31",
  });
  assert.equal(isIsoDate("2027-02-29"), false);
  assert.throws(() => parseOptions(["--start", "2027-02-30"]), /valid calendar dates/);
  assert.throws(
    () => parseOptions(["--start", "2027-12-31", "--end", "2027-01-01"]),
    /on or after/,
  );
});

test("parses the Aer Lingus-only search option", () => {
  assert.deepEqual(
    parseOptions(["--aer-lingus-only", "--start", "2027-01-01", "--end", "2027-12-31"]),
    {
      startDate: "2027-01-01",
      endDate: "2027-12-31",
      aerLingusOnly: true,
    },
  );
});

test("validates and deduplicates airport codes", () => {
  assert.deepEqual(parseAirportCodes("lhr, SYD,LHR", "AIRPORTS"), ["LHR", "SYD"]);
  assert.throws(() => parseAirportCodes("LHR,London", "AIRPORTS"), /three-letter/);
});

test("validates and deduplicates BA and QF loyalty-scheme settings", () => {
  assert.deepEqual(parseLoyaltySchemes("ba, QF, BA"), ["BA", "QF"]);
  assert.throws(() => parseLoyaltySchemes("BA, Avios"), /BA and\/or QF/);
});

test("builds Aer Lingus award searches for all four partner programs and both directions", () => {
  const searches = buildAerLingusSearchConfigs();
  assert.equal(searches.length, 12);
  assert.deepEqual(
    [...new Set(searches.map((search) => search.source))].sort(),
    ["alaska", "american", "british", "united"],
  );
  assert.deepEqual(
    [...new Set(searches.map((search) => search.direction))].sort(),
    ["Americas to Europe", "Europe to Americas", "Europe to Europe"],
  );
  const query = buildSearchUrl({
    ...searches.find((search) => search.source === "united" && search.direction === "Europe to Americas"),
    carrier: "EI",
    cabins: "premium,business",
    startDate: "2027-01-01",
    endDate: "2027-12-31",
  });
  assert.equal(query.searchParams.get("source"), "united");
  assert.equal(query.searchParams.get("carriers"), "EI");
  assert.equal(query.searchParams.get("cabins"), "premium,business");
  assert.equal(query.searchParams.get("origin_airport"), "EUR,MAN,SNN");
  assert.equal(query.searchParams.get("destination_airport"), "USA,CAD,CAR,MXC");
});

test("finds premium-economy and business Aer Lingus reward seats, not economy", () => {
  const matches = findMatches([
    { ID: "economy", YRemainingSeats: "2" },
    { ID: "business", JRemainingSeats: 1 },
    { ID: "premium", WRemainingSeats: 3 },
  ]);
  assert.deepEqual(matches.economy.map((record) => [record.ID, record.matchingCabin]), [
    ["economy", "economy"],
  ]);
  assert.equal(matches.business.length, 1);
  assert.equal(matches.voucherCandidates.length, 1);
});

test("runs and exports only Aer Lingus partner searches", async (context) => {
  const outputDirectory = mkdtempSync(path.join(os.tmpdir(), "aer-lingus-search-"));
  context.after(() => rmSync(outputDirectory, { recursive: true, force: true }));
  let requestCount = 0;
  const result = await runAerLingusSearch({
    apiKey: "test-key",
    options: { startDate: "2027-01-01", endDate: "2027-12-31" },
    outputDirectory,
    generatedAt: new Date("2026-10-24T10:03:00.000Z"),
    fetchImpl: async (url, requestOptions) => {
      requestCount += 1;
      assert.equal(requestOptions.headers["Partner-Authorization"], "test-key");
      assert.equal(url.searchParams.get("carriers"), "EI");
      assert.equal(url.searchParams.get("cabins"), "premium,business");
      return new Response(JSON.stringify({
        data: [{
          ID: `record-${url.searchParams.get("source")}`,
          Date: "2027-06-01",
          AvailabilityTrips: [{
            ID: `trip-${url.searchParams.get("source")}`,
            Source: url.searchParams.get("source"),
            OriginAirport: "DUB",
            DestinationAirport: "JFK",
            FlightNumbers: "EI105",
            Carriers: "EI",
            Cabin: "business",
            RemainingSeats: 2,
            MileageCost: 45000,
          }],
        }],
      }), { headers: { "X-RateLimit-Remaining": "990" } });
    },
  });

  assert.equal(requestCount, 12);
  assert.equal(result.aerLingusSearches.length, 12);
  assert.equal(result.rateLimit.remaining, 990);
  assert.equal(result.exportResult.rowCount, 12);
  assert.ok(readdirSync(outputDirectory).includes("Aer Lingus Rewards.json"));
  assert.ok(readdirSync(outputDirectory).includes("Aer Lingus Rewards 2027-Q2.json"));
  assert.ok(readdirSync(outputDirectory).includes("Aer Lingus Rewards.meta.json"));
  assert.ok(readdirSync(outputDirectory).includes("history"));
});

test("builds a BA first-class, business, and premium-economy search with trip details", () => {
  const url = buildSearchUrl({
    origins: ["LHR", "MAN"],
    destinations: ["SYD", "MEL"],
    carrier: "BA",
    startDate: "2027-01-01",
    endDate: "2027-12-31",
  });

  assert.equal(url.pathname, "/partnerapi/search");
  assert.equal(url.searchParams.get("origin_airport"), "LHR,MAN");
  assert.equal(url.searchParams.get("destination_airport"), "SYD,MEL");
  assert.equal(url.searchParams.get("cabins"), "first,business,premium");
  assert.equal(url.searchParams.get("carriers"), "BA");
  assert.equal(url.searchParams.get("include_trips"), "true");
});

test("builds a source-specific search without restricting partner operating airlines", () => {
  const url = buildSearchUrl({
    origins: ["CDG", "AMS"],
    destinations: ["SYD", "MEL", "BNE"],
    source: "qantas",
    startDate: "2027-01-01",
    endDate: "2027-12-31",
  });

  assert.equal(url.searchParams.get("origin_airport"), "CDG,AMS");
  assert.equal(url.searchParams.get("destination_airport"), "SYD,MEL,BNE");
  assert.equal(url.searchParams.get("source"), "qantas");
  assert.equal(url.searchParams.has("carriers"), false);
});

test("can restrict a loyalty-program search to BA-operated voucher candidates", () => {
  const url = buildSearchUrl({
    origins: ["SYD", "MEL"],
    destinations: ["LHR", "CDG"],
    source: "british",
    carrier: "BA",
    startDate: "2027-01-01",
    endDate: "2027-12-31",
  });

  assert.equal(url.searchParams.get("source"), "british");
  assert.equal(url.searchParams.get("carriers"), "BA");
  assert.equal(url.searchParams.get("origin_airport"), "SYD,MEL");
  assert.equal(url.searchParams.get("destination_airport"), "LHR,CDG");
});

test("upgrade candidates exclude mixed-carrier trips and count seats from chosen-carrier trips", () => {
  const records = filterCarrierOperatedRecords([
    {
      ID: "qf-only",
      JRemainingSeats: 5,
      FRemainingSeats: 4,
      AvailabilityTrips: [
        { Carriers: "QF", Cabin: "first", RemainingSeats: 1 },
        { Carriers: "QF", Cabin: "business", RemainingSeats: 2 },
        { Carriers: "QF, BA", Cabin: "business", RemainingSeats: 3 },
      ],
    },
    {
      ID: "mixed-only",
      JRemainingSeats: 4,
      AvailabilityTrips: [{ Carriers: "BA, QF", Cabin: "first", RemainingSeats: 4 }],
    },
  ], "QF");

  assert.deepEqual(records.map((record) => [record.ID, record.JRemainingSeats]), [
    ["qf-only", 2],
  ]);
  assert.equal(records[0].FRemainingSeats, 1);
  assert.deepEqual(
    findMatches(records).business.map((record) => [record.ID, record.matchingSeats]),
    [["qf-only", 2]],
  );
});

test("exports each itinerary flight segment under a named search feature", () => {
  const result = createFlightResultsCsv({
    europeanProgramSearches: [
      {
        scheme: "QF",
        direction: "Europe to Australia",
        program: "Qantas Frequent Flyer (Qantas Points)",
        firstClass: [
          {
            ID: "first-availability",
            Date: "2027-08-29",
            matchingCabin: "first",
            FTotalTaxes: 9300,
            AvailabilityTrips: [{
              ID: "first-trip",
              AvailabilityID: "first-availability",
              Source: "qantas",
              OriginAirport: "SYD",
              DestinationAirport: "LHR",
              FlightNumbers: "QF1",
              Carriers: "QF",
              Cabin: "first",
              RemainingSeats: 2,
              MileageCost: 210000,
              TaxesCurrency: "AUD",
            }],
          },
        ],
        business: [
          {
            ID: "availability-1",
            Date: "2027-08-30",
            matchingCabin: "business",
            AvailabilityTrips: [
              {
                ID: "trip-1",
                AvailabilityID: "availability-1",
                Source: "qantas",
                OriginAirport: "CDG",
                DestinationAirport: "MEL",
                Connections: ["DXB"],
                FlightNumbers: "EK74, EK408",
                Carriers: "EK",
                Cabin: "business",
                RemainingSeats: 3,
                MileageCost: 182900,
                TotalTaxes: 107854,
                TaxesCurrency: "EUR",
              },
            ],
          },
        ],
      },
      {
        scheme: "BA",
        direction: "Europe to Asia",
        program: "BA Executive Club (Avios)",
        firstClass: [],
        business: [
          {
            ID: "asia-award",
            Date: "2027-07-12",
            matchingCabin: "business",
            AvailabilityTrips: [{
              ID: "asia-award-trip",
              AvailabilityID: "asia-award",
              Source: "british",
              OriginAirport: "LHR",
              DestinationAirport: "SIN",
              FlightNumbers: "BA11",
              Carriers: "BA",
              Cabin: "business",
              RemainingSeats: 2,
            }],
          },
        ],
        voucherCandidates: [],
      },
    ],
  }, "2026-10-24");

  const lines = result.csv.trimEnd().split("\r\n");
  assert.equal(result.rowCount, 4);
  assert.equal(lines.length, 5);
  assert.match(lines[1], /^Australia Flights,24-Oct-2026,29-Aug-2027/);
  assert.match(lines[1], /,first,2,210000,93\.00,9300,AUD,/);
  assert.match(lines[2], /^Australia Flights,24-Oct-2026,30-Aug-2027/);
  assert.match(lines[2], /,1,EK74,EK,CDG,DXB,/);
  assert.match(lines[3], /,2,EK408,EK,DXB,MEL,/);
  assert.match(lines[2], /,182900,1078\.54,107854,EUR,/);
  assert.match(lines[4], /,Europe to Asia,BA loyalty search,BA Executive Club \(Avios\),british,BA,business,2,/);
  assert.equal(AUSTRALIA_FLIGHTS_SEARCH.outputFile, "Australia Flights.json");
});

test("exports Aer Lingus-operated awards by partner program", () => {
  const result = createFlightResultsCsv({
    aerLingusSearches: [{
      scheme: "United",
      direction: "Europe to Americas",
      program: "United Airlines MileagePlus",
      economy: [{
        ID: "ei-economy",
        Date: "2027-06-01",
        matchingCabin: "economy",
        AvailabilityTrips: [{
          ID: "ei-trip",
          AvailabilityID: "ei-economy",
          Source: "united",
          OriginAirport: "DUB",
          DestinationAirport: "JFK",
          FlightNumbers: "EI105",
          Carriers: "EI",
          Cabin: "economy",
          RemainingSeats: 2,
          MileageCost: 30000,
        }],
      }],
      business: [],
      voucherCandidates: [],
    }],
  }, "2026-10-24", AER_LINGUS_REWARDS_SEARCH);
  assert.equal(result.rowCount, 0);
  assert.equal(AER_LINGUS_REWARDS_SEARCH.outputFile, "Aer Lingus Rewards.json");
});

test("writes Aer Lingus results in separate calendar-quarter JSON files", (context) => {
  const outputDirectory = mkdtempSync(path.join(os.tmpdir(), "aer-lingus-quarterly-"));
  context.after(() => rmSync(outputDirectory, { recursive: true, force: true }));
  const records = ["2026-10-24", "2026-12-31", "2027-01-01"].map((date, index) => ({
    ID: `quarter-${index}`,
    Date: date,
    matchingCabin: "business",
    AvailabilityTrips: [{
      ID: `quarter-trip-${index}`,
      Source: "united",
      OriginAirport: "DUB",
      DestinationAirport: "JFK",
      Carriers: "EI",
      Cabin: "business",
      RemainingSeats: 1,
    }],
  }));
  const result = writeFlightResultsJson({
    aerLingusSearches: [{
      scheme: "United",
      direction: "Europe to Americas",
      program: "United Airlines MileagePlus",
      economy: [],
      business: records,
    }],
  }, "2026-10-24", AER_LINGUS_REWARDS_SEARCH, outputDirectory, new Date("2026-10-24T10:00:00.000Z"));

  assert.deepEqual(result.chunkFiles.map(({ file, rows }) => [path.basename(file), rows]), [
    ["Aer Lingus Rewards 2026-Q4.json", 2],
    ["Aer Lingus Rewards 2027-Q1.json", 1],
  ]);
  const q4 = JSON.parse(readFileSync(path.join(outputDirectory, "Aer Lingus Rewards 2026-Q4.json"), "utf8"));
  const q1 = JSON.parse(readFileSync(path.join(outputDirectory, "Aer Lingus Rewards 2027-Q1.json"), "utf8"));
  assert.deepEqual(q4.map((row) => row.TravelDate), ["24-Oct-2026", "31-Dec-2026"]);
  assert.deepEqual(q1.map((row) => row.TravelDate), ["01-Jan-2027"]);
  const metadata = JSON.parse(readFileSync(path.join(outputDirectory, "Aer Lingus Rewards.meta.json"), "utf8"));
  assert.equal(metadata.quarterlyChunks.length, 2);
});

test("writes North America results in separate calendar-quarter JSON files", (context) => {
  const outputDirectory = mkdtempSync(path.join(os.tmpdir(), "north-america-quarterly-"));
  context.after(() => rmSync(outputDirectory, { recursive: true, force: true }));
  const records = ["2026-10-24", "2027-01-01"].map((date, index) => ({
    ID: `na-quarter-${index}`,
    Date: date,
    matchingCabin: "business",
    AvailabilityTrips: [{
      ID: `na-quarter-trip-${index}`,
      Source: "british",
      OriginAirport: "LHR",
      DestinationAirport: "JFK",
      Carriers: "BA",
      Cabin: "business",
      RemainingSeats: 1,
    }],
  }));
  const result = writeFlightResultsJson({
    northAmericaSearches: [{
      scheme: "BA",
      direction: "Europe to North America",
      program: "BA Executive Club (Avios)",
      business: records,
    }],
  }, "2026-10-24", NORTH_AMERICA_FLIGHTS_SEARCH, outputDirectory, new Date("2026-10-24T10:00:00.000Z"));

  assert.deepEqual(result.chunkFiles.map(({ file, rows }) => [path.basename(file), rows]), [
    ["North America Flights 2026-Q4.json", 1],
    ["North America Flights 2027-Q1.json", 1],
  ]);
  const quarter = JSON.parse(readFileSync(path.join(outputDirectory, "North America Flights 2027-Q1.json"), "utf8"));
  assert.deepEqual(quarter.map((row) => row.TravelDate), ["01-Jan-2027"]);
  const metadata = JSON.parse(readFileSync(path.join(outputDirectory, "North America Flights.meta.json"), "utf8"));
  assert.equal(metadata.quarterlyChunks.length, 2);
});

test("writes timestamped history JSON and refreshes the latest JSON", (context) => {
  const outputDirectory = mkdtempSync(path.join(os.tmpdir(), "flight-search-csv-"));
  context.after(() => rmSync(outputDirectory, { recursive: true, force: true }));

  const generatedAt = new Date("2026-10-24T10:02:16.448Z");
  const result = writeFlightResultsJson(
    {},
    "2026-10-24",
    AUSTRALIA_FLIGHTS_SEARCH,
    outputDirectory,
    generatedAt,
    { rateLimitRemaining: 899 },
  );

  assert.equal(result.timestamp, "2026-10-24T10-02-16-448Z");
  assert.equal(path.basename(result.historyPath), "Australia Flights 2026-10-24T10-02-16-448Z.json");
  assert.equal(path.basename(result.outputPath), "Australia Flights.json");
  assert.deepEqual(JSON.parse(readFileSync(result.outputPath, "utf8")), []);
  assert.equal(readFileSync(result.historyPath, "utf8"), readFileSync(result.outputPath, "utf8"));
  assert.equal(path.basename(result.metadataPath), "Australia Flights.meta.json");
  assert.deepEqual(JSON.parse(readFileSync(result.metadataPath, "utf8")), {
    generatedAt: generatedAt.toISOString(),
    searchDate: "2026-10-24",
    rateLimitRemaining: 899,
  });
  assert.deepEqual(readdirSync(path.join(outputDirectory, "history")), [
    "Australia Flights 2026-10-24T10-02-16-448Z.json",
    "Australia Flights 2026-10-24T10-02-16-448Z.meta.json",
  ]);
  assert.throws(
    () => writeFlightResultsJson({}, "2026-10-24", AUSTRALIA_FLIGHTS_SEARCH, outputDirectory, generatedAt),
    { code: "EEXIST" },
  );
});

test("exports North America reward searches to their own feature CSV", () => {
  const search = {
    scheme: "BA",
    direction: "Europe to North America",
    program: "BA Executive Club (Avios)",
    firstClass: [],
    business: [{
      ID: "north-america-record",
      Date: "2027-05-15",
      matchingCabin: "business",
      AvailabilityTrips: [{
        ID: "north-america-trip",
        AvailabilityID: "north-america-record",
        Source: "british",
        OriginAirport: "LHR",
        DestinationAirport: "JFK",
        FlightNumbers: "BA117",
        Carriers: "BA",
        Cabin: "business",
        RemainingSeats: 2,
      }],
    }],
    voucherCandidates: [],
  };
  const result = createFlightResultsCsv({ northAmericaSearches: [search] }, "2026-10-24", NORTH_AMERICA_FLIGHTS_SEARCH);
  const rows = parseCsv(result.csv);

  assert.equal(result.rowCount, 1);
  assert.equal(rows[0].SearchFeature, "North America Flights");
  assert.equal(rows[0].SearchDirection, "Europe to North America");
  assert.equal(rows[0].LegDestination, "JFK");
  assert.equal(NORTH_AMERICA_FLIGHTS_SEARCH.outputFile, "North America Flights.json");
});

test("exports separate Asia upgrade search results for the voucher search type", () => {
  const result = createFlightResultsCsv({
    asiaUpgradeSearches: [
      {
        direction: "Europe to Asia",
        operatingCarrier: "BA",
        program: "BA Executive Club (Avios)",
        business: [],
        voucherCandidates: [
          {
            ID: "asia-availability",
            Date: "2027-06-01",
            matchingCabin: "premium",
            matchingSeats: 2,
            AvailabilityTrips: [{
              ID: "asia-trip",
              AvailabilityID: "asia-availability",
              Source: "british",
              OriginAirport: "LHR",
              DestinationAirport: "HKG",
              FlightNumbers: "BA31",
              Carriers: "BA",
              Cabin: "premium",
              RemainingSeats: 2,
            }],
          },
        ],
      },
    ],
  }, "2026-10-24");

  assert.match(result.csv, /BA upgrade-carrier search \(BA\) · Asia/);
  assert.match(result.csv, /Europe to Asia/);
  assert.match(result.csv, /BA Executive Club \(Avios\)/);
});

test("parses quoted CSV cells, escaped quotes, and embedded commas", () => {
  assert.deepEqual(parseCsv('Name,Route\r\n"Qantas ""Classic""","SYD, MEL"\r\n'), [
    { Name: 'Qantas "Classic"', Route: "SYD, MEL" },
  ]);
});

test("serves the frontend and exposes feature data through a local API", async (context) => {
  const server = createAppServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));

  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const page = await fetch(baseUrl);
  const source = await fetch(`${baseUrl}/app.js`);
  const appSource = await source.text();
  const featureResponse = await fetch(`${baseUrl}/api/features`);
  const featureData = await featureResponse.json();

  assert.equal(page.status, 200);
  const pageHtml = await page.text();
  assert.match(pageHtml, /Search feature/);
  assert.match(pageHtml, /id="reset-sort"/);
  assert.match(pageHtml, /tie-breakers/);
  assert.match(pageHtml, /<option value="first">First class<\/option>/);
  assert.match(pageHtml, /id="outbound-date-from" type="date"/);
  assert.match(pageHtml, /id="outbound-date-to" type="date"/);
  assert.match(pageHtml, /id="inbound-date-from" type="date"/);
  assert.match(pageHtml, /id="inbound-date-to" type="date"/);
  assert.match(pageHtml, /id="sync-inbound-date" type="checkbox" checked/);
  assert.match(pageHtml, /id="inbound-selection-note"/);
  assert.match(pageHtml, /id="clear-outbound-selection"/);
  assert.match(pageHtml, /id="clear-inbound-selection"/);
  assert.match(pageHtml, /id="continue-flight-selection"[^>]*disabled/);
  assert.match(pageHtml, /id="flight-summary"[^>]*hidden/);
  assert.match(pageHtml, /id="flight-summary-heading" tabindex="-1"/);
  assert.match(pageHtml, /id="edit-flight-selection"/);
  assert.doesNotMatch(pageHtml, /Select<\/th>/);
  assert.match(pageHtml, /id="outbound-results-body"/);
  assert.match(pageHtml, /id="inbound-results-body"/);
  assert.match(pageHtml, /<tbody id="outbound-results-body"><\/tbody>/);
  assert.match(pageHtml, /<tbody id="inbound-results-body"><\/tbody>/);
  assert.match(pageHtml, /id="outbound-tab"[^>]*role="tab"/);
  assert.match(pageHtml, /id="inbound-panel"[^>]*role="tabpanel"[^>]*hidden/);
  assert.equal((pageHtml.match(/<table class="flight-table">/g) ?? []).length, 2);
  assert.match(pageHtml, /aria-label="Sort flight results"/);
  for (const sortKey of [
    "TravelDate",
    "ItineraryOrigin",
    "Cabin",
    "SeatsAvailable",
    "LoyaltyScheme",
    "PointsPerItinerary",
    "TaxesPerItinerary",
  ]) {
    assert.match(pageHtml, new RegExp(`data-sort="${sortKey}"`));
  }
  assert.equal(source.status, 200);
  assert.match(appSource, /Intl\.NumberFormat/);
  assert.match(appSource, /loadFeature/);
  assert.match(appSource, /getItineraryDetails/);
  assert.match(appSource, /row\.title = details/);
  assert.match(appSource, /row\.className = "flight-row"/);
  assert.match(appSource, /function showDirection\(panelName\)/);
  assert.match(appSource, /event\.key === "ArrowRight"/);
  assert.match(appSource, /createFlightDetail\("departure-time"/);
  assert.match(appSource, /createFlightDetail\("arrival-time"/);
  assert.match(appSource, /button\.setAttribute\("aria-pressed", String\(isActive\)\)/);
  assert.match(appSource, /\["Points", itinerary\.PointsPerItinerary \?/);
  assert.match(appSource, /\["Taxes", formatTaxes\(itinerary\)\]/);
  assert.match(appSource, /\["Departs", formatUtcDateTime/);
  assert.match(appSource, /sortCriteria\.push/);
  assert.match(appSource, /priority \$\{sortIndex \+ 1\}/);
  assert.match(appSource, /inboundMinimum/);
  assert.match(appSource, /travelDate >= dateFrom/);
  assert.match(appSource, /travelDate <= dateTo/);
  assert.match(appSource, /input\.addEventListener\("input", synchronizeDateRanges\)/);
  assert.match(appSource, /dateInputs\.inboundFrom\.min = inboundMinimum/);
  assert.match(appSource, /function getInboundMinimumDate\(\)/);
  assert.match(appSource, /selectedOutbound\?\.TravelDate/);
  assert.match(appSource, /dateInputs\.inboundFrom\.value = new Date\(getInboundMinimumDate\(\)\)/);
  assert.match(appSource, /syncInboundDateCheckbox\.checked/);
  assert.match(appSource, /Inbound dates are independent of the selected outbound flight/);
  assert.match(appSource, /\["Sept", 8\]/);
  assert.match(appSource, /checkbox\.type = "checkbox"/);
  assert.match(appSource, /checkbox\.className = "select-flight"/);
  assert.match(appSource, /className = "button-secondary choose-flight"/);
  assert.match(appSource, /selectedInbound = checked \? itinerary : null/);
  assert.match(appSource, /continueSelection\.disabled = !selectedOutbound/);
  assert.match(appSource, /createSummaryCard\(selectedInbound, "inbound"\)/);
  assert.match(appSource, /summaryHeading\.focus/);
  assert.match(appSource, /It may depart from a different city/);
  assert.match(appSource, /reverseDirections/);
  assert.match(appSource, /API remaining:/);
  assert.equal(featureData.features[0].id, "australia-flights");
  assert.equal(featureData.features[1].id, "north-america-flights");
  assert.equal(featureData.features[2].id, "aer-lingus-rewards");
  assert.ok(featureData.features[0].searchTypes.length > 0);
  assert.deepEqual(
    featureData.features[1].searchTypes.map((type) => type.label),
    [
      "Europe to North America · Qantas Points · QF awards",
      "Europe to North America · BA Avios · BA awards",
      "North America to Europe · Qantas Points · QF awards",
      "North America to Europe · BA Avios · BA awards",
    ].sort((left, right) => left.localeCompare(right)),
  );
  const aerLingusResponse = await fetch(`${baseUrl}/api/features/aer-lingus-rewards/results`);
  const aerLingusData = await aerLingusResponse.json();
  assert.equal(aerLingusResponse.status, 200);
  assert.equal(aerLingusData.feature.name, "Aer Lingus Rewards");
  assert.ok(aerLingusData.rows.length > 0);
  assert.ok(aerLingusData.rows.every((row) => row.Cabin.toLowerCase() !== "economy"));
  assert.equal(featureData.features[0].searchTypes.filter((type) =>
    type.id === "ba-upgrade-voucher-australia"
    && type.label === "BA Upgrade Voucher · Australia",
  ).length, 1);
  assert.equal(featureData.features[0].searchTypes.filter((type) =>
    type.id === "ba-upgrade-voucher-asia"
    && type.label === "BA Upgrade Voucher · Asia",
  ).length, 1);

  const resultsResponse = await fetch(`${baseUrl}/api/features/australia-flights/results`);
  const resultsData = await resultsResponse.json();
  assert.equal(resultsResponse.status, 200);
  assert.equal(resultsData.feature.name, "Australia Flights");
  assert.ok(resultsData.rows.length > 0);
  assert.ok(resultsData.rateLimitRemaining === null || Number.isInteger(resultsData.rateLimitRemaining));

  const missingFeature = await fetch(`${baseUrl}/api/features/not-registered/results`);
  assert.equal(missingFeature.status, 404);
});

test("reads documented response array formats and rejects unknown payload shapes", () => {
  const row = { ID: "one" };
  assert.deepEqual(extractRows({ data: [row] }), [row]);
  assert.deepEqual(extractRows({ results: [row] }), [row]);
  assert.deepEqual(extractRows([row]), [row]);
  assert.throws(() => extractRows({ hasMore: false }), /availability array/);
});

test("follows safe pagination URLs and rejects unexpected hosts", () => {
  assert.equal(
    nextPageUrl({ hasMore: true, moreURL: "/partnerapi/search?skip=1000" }).href,
    "https://seats.aero/partnerapi/search?skip=1000",
  );
  assert.throws(
    () => nextPageUrl({ hasMore: true, moreURL: "https://example.com/steal" }),
    /unexpected pagination URL/,
  );
});

test("fails rather than requesting a repeated pagination page indefinitely", async () => {
  await assert.rejects(
    fetchAvailability(
      new URL("https://seats.aero/partnerapi/search"),
      "test-key",
      async () => ({
        ok: true,
        json: async () => ({
          data: [{ ID: "one" }],
          hasMore: true,
          moreURL: "/partnerapi/search",
        }),
      }),
    ),
    /repeated pagination URL/,
  );
});

test("fetches all pages, deduplicates IDs, and sends the API key in the auth header", async () => {
  const seenHeaders = [];
  const rateLimit = { remaining: null };
  const first = {
    data: [{ ID: "duplicate", JRemainingSeats: 1 }],
    hasMore: true,
    moreURL: "/partnerapi/search?skip=1",
  };
  const second = {
    data: [{ ID: "duplicate", JRemainingSeats: 2 }, { ID: "new" }],
    hasMore: false,
  };
  const records = await fetchAvailability(
    new URL("https://seats.aero/partnerapi/search"),
    "test-key",
    async (_url, options) => {
      seenHeaders.push(options.headers);
      const payload = seenHeaders.length === 1 ? first : second;
      return {
        ok: true,
        headers: new Headers({
          "X-RateLimit-Remaining": seenHeaders.length === 1 ? "950" : "899",
        }),
        json: async () => payload,
      };
    },
    rateLimit,
  );

  assert.deepEqual(records, [{ ID: "duplicate", JRemainingSeats: 2 }, { ID: "new" }]);
  assert.deepEqual(seenHeaders, [
    { "Partner-Authorization": "test-key" },
    { "Partner-Authorization": "test-key" },
  ]);
  assert.equal(rateLimit.remaining, 899);
});

test("reports business availability and premium-economy voucher candidates separately", () => {
  const matches = findMatches([
    { ID: "first", FRemainingSeats: 2 },
    { ID: "business", JRemainingSeats: 2, WRemainingSeats: 0 },
    { ID: "premium", JRemainingSeats: 0, WRemainingSeats: "1" },
    { ID: "none", JRemainingSeats: 0, WRemainingSeats: null },
  ]);

  assert.deepEqual(matches.firstClass.map((record) => [record.ID, record.matchingSeats]), [
    ["first", 2],
  ]);
  assert.deepEqual(matches.business.map((record) => [record.ID, record.matchingSeats]), [
    ["business", 2],
  ]);
  assert.deepEqual(
    matches.voucherCandidates.map((record) => [record.ID, record.matchingSeats]),
    [["premium", 1]],
  );
});
