import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export const AUSTRALIA_FLIGHTS_SEARCH = Object.freeze({
  id: "australia-flights",
  name: "Australia Flights",
  outputFile: "Australia Flights.csv",
  metadataFile: "Australia Flights.meta.json",
});

export const NORTH_AMERICA_FLIGHTS_SEARCH = Object.freeze({
  id: "north-america-flights",
  name: "North America Flights",
  outputFile: "North America Flights.csv",
  metadataFile: "North America Flights.meta.json",
});

export const AER_LINGUS_REWARDS_SEARCH = Object.freeze({
  id: "aer-lingus-rewards",
  name: "Aer Lingus Rewards",
  outputFile: "Aer Lingus Rewards.csv",
  metadataFile: "Aer Lingus Rewards.meta.json",
});

const COLUMNS = [
  "SearchFeature",
  "SearchDate",
  "TravelDate",
  "SearchDirection",
  "ResultSet",
  "LoyaltyScheme",
  "AvailabilitySource",
  "OperatingCarriers",
  "Cabin",
  "SeatsAvailable",
  "PointsPerItinerary",
  "TaxesPerItinerary",
  "TaxesPerItineraryRaw",
  "TaxesCurrency",
  "ItineraryOrigin",
  "ItineraryDestination",
  "FlightLegNumber",
  "FlightNumber",
  "FlightCarrier",
  "LegOrigin",
  "LegDestination",
  "ItineraryDepartureUTC",
  "ItineraryArrivalUTC",
  "Stops",
  "AvailabilityID",
  "TripID",
];

const MONTH_NUMBERS = new Map([
  ["Jan", 1], ["Feb", 2], ["Mar", 3], ["Apr", 4], ["May", 5], ["Jun", 6],
  ["Jul", 7], ["Aug", 8], ["Sep", 9], ["Sept", 9], ["Oct", 10], ["Nov", 11], ["Dec", 12],
]);

function formatUkDate(value) {
  if (!value) return "";
  const date = new Date(`${String(value).slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(date.valueOf())) return String(value);
  const day = String(date.getUTCDate()).padStart(2, "0");
  const month = date.toLocaleString("en-GB", { month: "short", timeZone: "UTC" });
  return `${day}-${month}-${date.getUTCFullYear()}`;
}

function escapeCsvCell(value) {
  const text = value == null ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function loyaltyProgram(source, fallback = "") {
  if (source === "british") return "BA Executive Club (Avios)";
  if (source === "qantas") return "Qantas Frequent Flyer (Qantas Points)";
  if (source === "qatar") return "Qatar Privilege Club (Avios)";
  if (source === "alaska") return "Alaska Airlines Mileage Plan";
  if (source === "united") return "United Airlines MileagePlus";
  if (source === "american") return "American Airlines AAdvantage";
  return fallback;
}

function flightCarrier(flightNumber) {
  return flightNumber.match(/^([A-Z0-9]{2})\d/i)?.[1] ?? "";
}

function formatTaxAmount(value) {
  if (value === null || value === undefined || value === "") return "";
  const amount = Number(value);
  if (!Number.isFinite(amount)) return String(value);
  const majorUnits = Number.isInteger(amount) ? amount / 100 : amount;
  return majorUnits.toFixed(2);
}

function summaryTaxAmount(record, cabin) {
  const cabinPrefix = {
    economy: "Y",
    first: "F",
    business: "J",
    premium: "W",
  }[cabin?.toLowerCase()] ?? "W";
  return record[`${cabinPrefix}TotalTaxes`];
}

function collectRows(searchResults, { feature, searchDate }) {
  const rows = [];
  const seen = new Set();
  const featureName = feature.name;

  function addRecords(resultSet, direction, scheme, records, cabinFilter) {
    for (const record of records ?? []) {
      const trips = Array.isArray(record.AvailabilityTrips) ? record.AvailabilityTrips : [];
      for (const trip of trips) {
        const cabin = trip.Cabin ?? record.matchingCabin ?? "";
        if (cabinFilter && cabin && cabin.toLowerCase() !== cabinFilter) continue;
        const source = trip.Source ?? record.Source ?? "";
        const key = [resultSet, direction, scheme, source, trip.ID ?? record.ID, cabin].join("|");
        if (seen.has(key)) continue;
        seen.add(key);

        const rawTaxes = trip.TotalTaxes ?? summaryTaxAmount(record, cabin) ?? "";
        const flightNumbers = String(trip.FlightNumbers ?? "").split(/[,;\s]+/).filter(Boolean);
        const connections = Array.isArray(trip.Connections) ? trip.Connections.map(String) : [];
        const airports = [trip.OriginAirport, ...connections, trip.DestinationAirport];
        const canMapSegments = flightNumbers.length > 0 && airports.length === flightNumbers.length + 1;
        const segments = flightNumbers.length > 0 ? flightNumbers : [""];

        segments.forEach((flightNumber, index) => {
          rows.push({
            SearchFeature: featureName,
            SearchDate: formatUkDate(searchDate),
            TravelDate: formatUkDate(record.Date),
            SearchDirection: direction,
            ResultSet: resultSet,
            LoyaltyScheme: loyaltyProgram(source, scheme),
            AvailabilitySource: source,
            OperatingCarriers: trip.Carriers ?? record.Carriers ?? "",
            Cabin: cabin,
            SeatsAvailable: trip.RemainingSeats ?? record.matchingSeats ?? "",
            PointsPerItinerary: trip.MileageCost ?? "",
            TaxesPerItinerary: formatTaxAmount(rawTaxes),
            TaxesPerItineraryRaw: rawTaxes,
            TaxesCurrency: trip.TaxesCurrency ?? record.TaxesCurrency ?? "",
            ItineraryOrigin: trip.OriginAirport ?? record.OriginAirport ?? "",
            ItineraryDestination: trip.DestinationAirport ?? record.DestinationAirport ?? "",
            FlightLegNumber: flightNumber ? index + 1 : "",
            FlightNumber: flightNumber,
            FlightCarrier: flightCarrier(flightNumber),
            LegOrigin: canMapSegments ? airports[index] : "",
            LegDestination: canMapSegments ? airports[index + 1] : "",
            ItineraryDepartureUTC: trip.DepartsAt ?? "",
            ItineraryArrivalUTC: trip.ArrivesAt ?? "",
            Stops: trip.Stops ?? "",
            AvailabilityID: trip.AvailabilityID ?? record.ID ?? "",
            TripID: trip.ID ?? "",
          });
        });
      }
    }
  }

  if (feature.id === AER_LINGUS_REWARDS_SEARCH.id) {
    for (const search of searchResults.aerLingusSearches ?? []) {
      const resultSet = `${search.scheme} loyalty search`;
      addRecords(resultSet, search.direction, search.program, search.business, "business");
      addRecords(resultSet, search.direction, search.program, search.voucherCandidates, "premium");
    }
    return rows;
  }

  if (feature.id === NORTH_AMERICA_FLIGHTS_SEARCH.id) {
    for (const search of searchResults.northAmericaSearches ?? []) {
      const resultSet = `${search.scheme} loyalty search`;
      addRecords(resultSet, search.direction, search.program, search.firstClass, "first");
      addRecords(resultSet, search.direction, search.program, search.business, "business");
      addRecords(resultSet, search.direction, search.program, search.voucherCandidates, "premium");
    }
    return rows;
  }

  addRecords(
    "UK BA-carrier-filtered search",
    "UK to Australia",
    "",
    searchResults.firstClass,
    "first",
  );
  addRecords(
    "UK BA-carrier-filtered search",
    "UK to Australia",
    "",
    searchResults.business,
    "business",
  );
  addRecords(
    "UK BA-carrier-filtered search",
    "UK to Australia",
    "",
    searchResults.voucherCandidates,
    "premium",
  );

  for (const search of searchResults.europeanProgramSearches ?? []) {
    addRecords(`${search.scheme} loyalty search`, search.direction, search.program, search.firstClass, "first");
    addRecords(`${search.scheme} loyalty search`, search.direction, search.program, search.business, "business");
    addRecords(
      `${search.scheme} loyalty search`,
      search.direction,
      search.program,
      search.voucherCandidates,
      "premium",
    );
  }

  for (const search of searchResults.baUpgradeSearches ?? []) {
    const resultSet = `BA upgrade-carrier search (${search.operatingCarrier}) · Australia`;
    addRecords(resultSet, search.direction, search.program, search.business, "business");
    addRecords(resultSet, search.direction, search.program, search.voucherCandidates, "premium");
  }

  for (const search of searchResults.asiaUpgradeSearches ?? []) {
    const resultSet = `BA upgrade-carrier search (${search.operatingCarrier}) · Asia`;
    addRecords(resultSet, search.direction, search.program, search.business, "business");
    addRecords(resultSet, search.direction, search.program, search.voucherCandidates, "premium");
  }

  return rows;
}

function getQuarterKey(travelDate) {
  const match = /^(\d{2})-([A-Z][a-z]{2,3})-(\d{4})$/.exec(travelDate ?? "");
  if (!match || !MONTH_NUMBERS.has(match[2])) return null;
  return `${match[3]}-Q${Math.ceil(MONTH_NUMBERS.get(match[2]) / 3)}`;
}

function serializeCsv(rows) {
  const lines = [
    COLUMNS.join(","),
    ...rows.map((row) => COLUMNS.map((column) => escapeCsvCell(row[column])).join(",")),
  ];
  return `${lines.join("\r\n")}\r\n`;
}

export function createFlightResultsCsv(searchResults, searchDate, feature = AUSTRALIA_FLIGHTS_SEARCH) {
  const rows = collectRows(searchResults, { feature, searchDate });
  return { csv: serializeCsv(rows), rowCount: rows.length };
}

export function writeFlightResultsCsv(
  searchResults,
  searchDate,
  feature = AUSTRALIA_FLIGHTS_SEARCH,
  outputDirectory = process.cwd(),
  generatedAt = new Date(),
  metadata = {},
) {
  const rows = collectRows(searchResults, { feature, searchDate });
  const csv = serializeCsv(rows);
  const rowCount = rows.length;
  const outputPath = path.resolve(outputDirectory, feature.outputFile);
  const timestamp = generatedAt.toISOString()
    .replaceAll(":", "-")
    .replace(/\.(\d{3})Z$/, "-$1Z");
  const historyDirectory = path.resolve(outputDirectory, "history");
  const historyPath = path.join(
    historyDirectory,
    `${path.basename(feature.outputFile, path.extname(feature.outputFile))} ${timestamp}.csv`,
  );
  const quarterlyRows = new Map();
  if (feature.id === AER_LINGUS_REWARDS_SEARCH.id) {
    for (const row of rows) {
      const quarter = getQuarterKey(row.TravelDate);
      if (!quarter) continue;
      const chunkRows = quarterlyRows.get(quarter) ?? [];
      chunkRows.push(row);
      quarterlyRows.set(quarter, chunkRows);
    }
  }
  const chunkFiles = [...quarterlyRows].map(([quarter, chunkRows]) => ({
    file: `${path.basename(feature.outputFile, path.extname(feature.outputFile))} ${quarter}.csv`,
    rows: chunkRows.length,
    csv: serializeCsv(chunkRows),
  }));
  const chunkMetadata = chunkFiles.length
    ? {
      quarterlyChunks: chunkFiles.map(({ file, rows: count }) => ({ file, rows: count })),
    }
    : {};
  const metadataContent = `${JSON.stringify({
    generatedAt: generatedAt.toISOString(),
    searchDate,
    ...metadata,
    ...chunkMetadata,
  }, null, 2)}\n`;
  const currentMetadataPath = path.resolve(outputDirectory, feature.metadataFile);
  const historyMetadataPath = path.join(
    historyDirectory,
    `${path.basename(feature.outputFile, path.extname(feature.outputFile))} ${timestamp}.meta.json`,
  );

  mkdirSync(historyDirectory, { recursive: true });
  writeFileSync(historyPath, csv, { encoding: "utf8", flag: "wx" });
  writeFileSync(historyMetadataPath, metadataContent, { encoding: "utf8", flag: "wx" });
  writeFileSync(outputPath, csv, "utf8");
  writeFileSync(currentMetadataPath, metadataContent, "utf8");
  for (const chunk of chunkFiles) {
    writeFileSync(path.resolve(outputDirectory, chunk.file), chunk.csv, "utf8");
  }
  return {
    outputPath,
    historyPath,
    metadataPath: currentMetadataPath,
    historyMetadataPath,
    timestamp,
    rowCount,
    chunkFiles: chunkFiles.map(({ file, rows: count }) => ({
      file: path.resolve(outputDirectory, file),
      rows: count,
    })),
  };
}
