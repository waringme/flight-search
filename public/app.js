const featureSelect = document.querySelector("#feature-select");
const typeSelect = document.querySelector("#type-select");
const cabinSelect = document.querySelector("#cabin-select");
const syncInboundDateCheckbox = document.querySelector("#sync-inbound-date");
const dateInputs = {
  outboundFrom: document.querySelector("#outbound-date-from"),
  outboundTo: document.querySelector("#outbound-date-to"),
  inboundFrom: document.querySelector("#inbound-date-from"),
  inboundTo: document.querySelector("#inbound-date-to"),
};
const searchInput = document.querySelector("#search-input");
const resultPanels = {
  outbound: {
    direction: "outbound",
    body: document.querySelector("#outbound-results-body"),
    count: document.querySelector("#outbound-count"),
    summary: document.querySelector("#outbound-page-summary"),
    previous: document.querySelector("#outbound-previous-page"),
    next: document.querySelector("#outbound-next-page"),
    empty: document.querySelector("#outbound-empty-state"),
  },
  inbound: {
    direction: "inbound",
    body: document.querySelector("#inbound-results-body"),
    count: document.querySelector("#inbound-count"),
    summary: document.querySelector("#inbound-page-summary"),
    previous: document.querySelector("#inbound-previous-page"),
    next: document.querySelector("#inbound-next-page"),
    empty: document.querySelector("#inbound-empty-state"),
  },
};
const searchDate = document.querySelector("#search-date");
const notice = document.querySelector("#notice");
const inboundSelectionMessage = document.querySelector("#inbound-selection-message");
const clearOutboundSelection = document.querySelector("#clear-outbound-selection");
const sortButtons = [...document.querySelectorAll("[data-sort]")];
const resetSortButton = document.querySelector("#reset-sort");
const selectionBar = document.querySelector("#flight-selection-bar");
const selectionPreviews = {
  outbound: document.querySelector("#outbound-selection-preview"),
  inbound: document.querySelector("#inbound-selection-preview"),
};
const selectionStatus = document.querySelector("#flight-selection-status");
const clearInboundSelection = document.querySelector("#clear-inbound-selection");
const continueSelection = document.querySelector("#continue-flight-selection");
const flightSummary = document.querySelector("#flight-summary");
const summaryHeading = document.querySelector("#flight-summary-heading");
const summaryDescription = document.querySelector("#flight-summary-description");
const summaryCards = document.querySelector("#flight-summary-cards");
const editSelection = document.querySelector("#edit-flight-selection");
const directionTabs = [...document.querySelectorAll("[data-panel]")];

const PAGE_SIZE = 50;
const MONTHS = new Map([
  ["Jan", 0], ["Feb", 1], ["Mar", 2], ["Apr", 3], ["May", 4], ["Jun", 5],
  ["Jul", 6], ["Aug", 7], ["Sep", 8], ["Sept", 8], ["Oct", 9], ["Nov", 10], ["Dec", 11],
]);

let featureRegistry = [];
let rawRows = [];
let itineraries = [];
let selectedOutbound = null;
let selectedInbound = null;
let featureLoadId = 0;
const pages = { outbound: 0, inbound: 0 };
const defaultSort = { key: "TravelDate", direction: "ascending" };
let sortCriteria = [{ ...defaultSort }];
let hasCustomSort = false;

function setNotice(message, isError = false) {
  notice.textContent = message;
  notice.classList.toggle("error", isError);
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed (${response.status}).`);
  }
  return response.json();
}

function createOption(value, label) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  return option;
}

function populateFeatureSelect(features) {
  featureSelect.replaceChildren();
  for (const feature of features) {
    featureSelect.append(createOption(feature.id, feature.name));
  }
  featureSelect.disabled = features.length === 0;
}

function populateTypeSelect(feature) {
  typeSelect.replaceChildren();
  typeSelect.append(createOption("all", "All search types"));
  for (const type of feature?.searchTypes ?? []) {
    typeSelect.append(createOption(type.id, type.label));
  }
  typeSelect.disabled = !feature;
}

function parseUkDate(value) {
  const match = /^(\d{2})-([A-Z][a-z]{2,3})-(\d{4})$/.exec(value ?? "");
  if (!match || !MONTHS.has(match[2])) return 0;
  return Date.UTC(Number(match[3]), MONTHS.get(match[2]), Number(match[1]));
}

function parseIsoDate(value) {
  return value ? Date.parse(`${value}T00:00:00Z`) : null;
}

function getPanelDirection(panel) {
  const selectedType = typeSelect.value;
  if (selectedType === "all") {
    if (featureSelect.value === "aer-lingus-rewards") {
      return panel === "outbound"
        ? ["Europe to Americas", "Europe to Europe"]
        : ["Americas to Europe", "Europe to Europe"];
    }
    return panel === "outbound"
      ? ["UK to Australia", "Europe to Australia", "Europe to Asia", "Europe to North America"]
      : ["Australia to Europe", "Asia to Europe", "North America to Europe"];
  }
  if (selectedType.startsWith("ba-upgrade-voucher-")) {
    const area = selectedType.endsWith("-asia") ? "Asia" : "Australia";
    return panel === "outbound" ? `Europe to ${area}` : `${area} to Europe`;
  }
  const [selectedDirection] = selectedType.split("|");
  if (panel === "outbound") return selectedDirection;
  const reverseDirections = {
    "Europe to Australia": "Australia to Europe",
    "Australia to Europe": "Europe to Australia",
    "Europe to Asia": "Asia to Europe",
    "Asia to Europe": "Europe to Asia",
    "Europe to North America": "North America to Europe",
    "North America to Europe": "Europe to North America",
    "UK to Australia": "Australia to Europe",
    "Europe to Americas": "Americas to Europe",
    "Americas to Europe": "Europe to Americas",
    "Europe to Europe": "Europe to Europe",
  };
  return reverseDirections[selectedDirection] ?? "";
}

function getInboundMinimumDate() {
  if (!syncInboundDateCheckbox.checked) return null;
  const outboundDate = selectedOutbound?.TravelDate
    ? parseUkDate(selectedOutbound.TravelDate)
    : parseIsoDate(dateInputs.outboundTo.value || dateInputs.outboundFrom.value);
  return outboundDate ? outboundDate + 86400000 : null;
}

function itineraryKey(row) {
  const identity = row.TripID || row.AvailabilityID || row.FlightNumber;
  return [
    row.SearchDirection,
    row.ResultSet,
    row.LoyaltyScheme,
    row.Cabin,
    row.AvailabilityID,
    identity,
  ].join("|");
}

function buildItineraries(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const key = itineraryKey(row);
    const itinerary = grouped.get(key) ?? { ...row, segments: [] };
    if (row.FlightNumber) {
      itinerary.segments.push({
        number: row.FlightNumber,
        origin: row.LegOrigin,
        destination: row.LegDestination,
        order: Number(row.FlightLegNumber) || itinerary.segments.length + 1,
      });
    }
    grouped.set(key, itinerary);
  }

  return [...grouped.values()]
    .map((itinerary) => ({
      ...itinerary,
      segments: itinerary.segments.sort((left, right) => left.order - right.order),
    }))
    .sort((left, right) =>
      parseUkDate(left.TravelDate) - parseUkDate(right.TravelDate)
      || left.ItineraryDepartureUTC.localeCompare(right.ItineraryDepartureUTC)
      || left.ItineraryOrigin.localeCompare(right.ItineraryOrigin),
    );
}

function getFilteredItineraries(panel) {
  const selectedType = typeSelect.value;
  const cabin = cabinSelect.value;
  const selectedDateFrom = parseIsoDate(panel === "outbound" ? dateInputs.outboundFrom.value : dateInputs.inboundFrom.value);
  const dateTo = parseIsoDate(panel === "outbound" ? dateInputs.outboundTo.value : dateInputs.inboundTo.value);
  const inboundMinimum = panel === "inbound" ? getInboundMinimumDate() : null;
  const dateFrom = selectedDateFrom === null
    ? inboundMinimum
    : inboundMinimum === null
      ? selectedDateFrom
      : Math.max(selectedDateFrom, inboundMinimum);
  const expectedDirection = getPanelDirection(panel);
  const query = searchInput.value.trim().toLowerCase();

  const filtered = itineraries.filter((itinerary) => {
    const matchesUpgradeType = selectedType.startsWith("ba-upgrade-voucher-");
    const upgradeArea = selectedType.endsWith("-asia") ? "Asia" : "Australia";
    const [selectedDirection, selectedResultSet, selectedScheme] = selectedType.split("|");
    const matchesDirection = Array.isArray(expectedDirection)
      ? expectedDirection.includes(itinerary.SearchDirection)
      : itinerary.SearchDirection === expectedDirection;
    const matchesType = selectedType === "all"
      || (matchesUpgradeType
        ? itinerary.ResultSet.startsWith("BA upgrade-carrier search")
          && itinerary.ResultSet.endsWith(`· ${upgradeArea}`)
        : itinerary.ResultSet === selectedResultSet
          && itinerary.LoyaltyScheme === selectedScheme
          && (panel === "inbound" || itinerary.SearchDirection === selectedDirection));
    const matchesCabin = cabin === "all" || itinerary.Cabin.toLowerCase() === cabin;
    const travelDate = parseUkDate(itinerary.TravelDate);
    const matchesDate = (dateFrom === null || travelDate >= dateFrom)
      && (dateTo === null || travelDate <= dateTo);
    const haystack = [
      itinerary.TravelDate,
      itinerary.SearchDirection,
      itinerary.ItineraryOrigin,
      itinerary.ItineraryDestination,
      itinerary.OperatingCarriers,
      itinerary.LoyaltyScheme,
      ...itinerary.segments.map((segment) => `${segment.number} ${segment.origin} ${segment.destination}`),
    ].join(" ").toLowerCase();
    return matchesDirection && matchesType && matchesCabin && matchesDate && haystack.includes(query);
  });
  return filtered.sort((left, right) => {
    for (const { key, direction } of sortCriteria) {
      const leftValue = getSortValue(left, key);
      const rightValue = getSortValue(right, key);
      const comparison = typeof leftValue === "number" && typeof rightValue === "number"
        ? leftValue - rightValue
        : String(leftValue).localeCompare(String(rightValue), "en", { numeric: true, sensitivity: "base" });
      if (comparison !== 0) return direction === "ascending" ? comparison : -comparison;
    }
    return 0;
  });
}

function getSortValue(itinerary, key) {
  if (key === "TravelDate") return parseUkDate(itinerary.TravelDate);
  if (key === "SeatsAvailable" || key === "PointsPerItinerary" || key === "TaxesPerItinerary") {
    const value = Number(itinerary[key]);
    return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
  }
  if (key === "ItineraryOrigin") {
    return [
      itinerary.ItineraryOrigin,
      itinerary.ItineraryDestination,
      ...itinerary.segments.map((segment) => segment.number),
    ].join(" ");
  }
  return itinerary[key] ?? "";
}

function createFlightDetail(className, text, label, tagName = "td") {
  const cell = document.createElement(tagName);
  cell.className = className;
  const caption = document.createElement("span");
  caption.className = "detail-label";
  caption.textContent = label;
  const value = document.createElement("span");
  value.className = "detail-value";
  value.textContent = text ?? "Not available";
  cell.append(caption, value);
  return cell;
}

function formatTaxes(itinerary) {
  const taxes = Number(itinerary.TaxesPerItinerary);
  if (!Number.isFinite(taxes) || itinerary.TaxesPerItinerary === "") return "Not available";
  try {
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency: itinerary.TaxesCurrency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(taxes);
  } catch {
    return `${itinerary.TaxesCurrency ?? ""} ${taxes.toFixed(2)}`.trim();
  }
}

function formatUtcDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return `${new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(date)} UTC`;
}

function getItineraryFields(itinerary) {
  const details = [
    ["Direction", itinerary.SearchDirection],
    ["Route", `${itinerary.ItineraryOrigin} → ${itinerary.ItineraryDestination}`],
    ["Travel date", itinerary.TravelDate],
    ["Cabin", itinerary.Cabin === "first" ? "First class" : itinerary.Cabin === "premium" ? "Premium economy" : itinerary.Cabin],
    ["Seats", itinerary.SeatsAvailable],
    ["Loyalty scheme", itinerary.LoyaltyScheme],
    ["Points", itinerary.PointsPerItinerary ? Number(itinerary.PointsPerItinerary).toLocaleString("en-GB") : ""],
    ["Taxes", formatTaxes(itinerary)],
    ["Operating carriers", itinerary.OperatingCarriers],
    ["Flights", itinerary.segments.map((segment) => segment.number).filter(Boolean).join(", ")],
    ["Stops", itinerary.Stops === "" ? "" : Number(itinerary.Stops) === 0 ? "Non-stop" : itinerary.Stops],
    ["Departs", formatUtcDateTime(itinerary.ItineraryDepartureUTC)],
    ["Arrives", formatUtcDateTime(itinerary.ItineraryArrivalUTC)],
    ["Availability source", itinerary.AvailabilitySource],
  ];
  return details
    .filter(([, value]) => value !== null && value !== undefined && value !== "");
}

function getItineraryDetails(itinerary) {
  return getItineraryFields(itinerary)
    .map(([label, value]) => `${label}: ${value}`)
    .join("\n");
}

function renderRouteCell(itinerary) {
  const cell = document.createElement("td");
  cell.className = "route-cell";

  const route = document.createElement("div");
  route.className = "route-title";
  route.textContent = `${itinerary.ItineraryOrigin} → ${itinerary.ItineraryDestination}`;
  cell.append(route);

  const path = document.createElement("div");
  path.className = "flight-path";
  for (const segment of itinerary.segments) {
    const leg = document.createElement("div");
    leg.className = "flight-leg";

    const flight = document.createElement("span");
    flight.className = "flight-number";
    flight.textContent = segment.number;
    leg.append(flight);

    if (segment.origin && segment.destination) {
      const airports = document.createElement("span");
      airports.textContent = `${segment.origin} → ${segment.destination}`;
      leg.append(airports);
    }
    path.append(leg);
  }
  cell.append(path);
  return cell;
}

function renderFlightChoice(itinerary, panelName, isSelected) {
  function updateSelection(checked, control, selector) {
    const restoreFocus = document.activeElement === control;
    if (panelName === "outbound") {
      selectedOutbound = checked ? itinerary : null;
      if (selectedOutbound && syncInboundDateCheckbox.checked) {
        dateInputs.inboundFrom.value = new Date(getInboundMinimumDate()).toISOString().slice(0, 10);
      }
    } else {
      selectedInbound = checked ? itinerary : null;
    }
    closeFlightSummary();
    synchronizeDateRanges();
    if (restoreFocus) {
      [...resultPanels[panelName].body.querySelectorAll(selector)]
        .find((input) => input.value === control.value)?.focus({ preventScroll: true });
    }
  }

  const controls = document.createElement("div");
  controls.className = "flight-choice-controls";
  const label = document.createElement("label");
  label.className = "flight-choice";
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "select-flight";
  checkbox.checked = isSelected;
  checkbox.value = itineraryKey(itinerary);
  checkbox.setAttribute(
    "aria-label",
    `Select ${panelName} flight ${itinerary.ItineraryOrigin} to ${itinerary.ItineraryDestination} on ${itinerary.TravelDate}`,
  );
  checkbox.addEventListener("change", () => {
    updateSelection(checkbox.checked, checkbox, ".select-flight");
  });
  label.append(checkbox, itinerary.TravelDate);
  const selectButton = document.createElement("button");
  selectButton.type = "button";
  selectButton.className = "button-secondary choose-flight";
  selectButton.value = itineraryKey(itinerary);
  selectButton.textContent = isSelected ? "Selected" : "Choose";
  selectButton.setAttribute("aria-pressed", String(isSelected));
  selectButton.setAttribute(
    "aria-label",
    `${isSelected ? "Deselect" : "Choose"} ${panelName} flight ${itinerary.ItineraryOrigin} to ${itinerary.ItineraryDestination} on ${itinerary.TravelDate}`,
  );
  selectButton.addEventListener("click", () => {
    updateSelection(!isSelected, selectButton, ".choose-flight");
  });
  controls.append(label, selectButton);
  return controls;
}

function renderItinerary(itinerary, panelName) {
  const row = document.createElement("tr");
  row.className = "flight-row";
  const details = getItineraryDetails(itinerary);
  const selectedFlight = panelName === "outbound" ? selectedOutbound : selectedInbound;
  const isSelected = Boolean(selectedFlight
    && itineraryKey(selectedFlight) === itineraryKey(itinerary));
  if (isSelected) row.classList.add("selected-flight");
  row.title = details;
  row.setAttribute("aria-label", details.replaceAll("\n", ". "));
  row.tabIndex = 0;
  const dateCell = document.createElement("td");
  dateCell.className = "date-cell";
  dateCell.append(renderFlightChoice(itinerary, panelName, isSelected));
  row.append(dateCell);
  row.append(renderRouteCell(itinerary));
  const times = document.createElement("td");
  times.className = "flight-times";
  times.append(
    createFlightDetail("departure-time", formatUtcDateTime(itinerary.ItineraryDepartureUTC) || "Not available", "Departs", "div"),
    createFlightDetail("arrival-time", formatUtcDateTime(itinerary.ItineraryArrivalUTC) || "Not available", "Arrives", "div"),
  );
  row.append(times);

  const cabinCell = createFlightDetail("cabin-cell", "", "Cabin");
  const cabinPill = document.createElement("span");
  const cabin = itinerary.Cabin.toLowerCase();
  cabinPill.className = `cabin-pill ${["first", "business"].includes(cabin) ? cabin : ""}`;
  cabinPill.textContent = cabin === "first"
    ? "First class"
    : cabin === "premium"
      ? "Premium economy"
      : itinerary.Cabin;
  cabinCell.lastElementChild.append(cabinPill);
  row.append(cabinCell);

  row.append(createFlightDetail("seats-cell", itinerary.SeatsAvailable, "Available seats"));
  row.append(createFlightDetail("loyalty-cell", itinerary.LoyaltyScheme, "Loyalty scheme"));

  const points = Number(itinerary.PointsPerItinerary);
  row.append(createFlightDetail("points-cell", Number.isFinite(points) && points > 0 ? points.toLocaleString("en-GB") : "—", "Points / passenger"));

  const taxesText = itinerary.TaxesPerItinerary === "" ? "—" : formatTaxes(itinerary);
  row.append(createFlightDetail("taxes-cell", taxesText, "Taxes"));
  return row;
}

function renderPanel(panelName) {
  const panel = resultPanels[panelName];
  const filtered = getFilteredItineraries(panelName);
  const pageCount = Math.ceil(filtered.length / PAGE_SIZE);
  pages[panelName] = Math.min(pages[panelName], Math.max(0, pageCount - 1));
  const firstIndex = pages[panelName] * PAGE_SIZE;
  const currentRows = filtered.slice(firstIndex, firstIndex + PAGE_SIZE);
  panel.body.replaceChildren(...currentRows.map((itinerary) => renderItinerary(itinerary, panelName)));
  panel.count.textContent = `${filtered.length.toLocaleString("en-GB")} itineraries`;
  document.querySelector(`[data-panel="${panelName}"] .tab-count`).textContent =
    filtered.length.toLocaleString("en-GB");
  panel.summary.textContent = filtered.length === 0
    ? "No results"
    : `Showing ${firstIndex + 1}–${Math.min(firstIndex + PAGE_SIZE, filtered.length)} of ${filtered.length.toLocaleString("en-GB")}`;
  panel.previous.disabled = pages[panelName] === 0;
  panel.next.disabled = pages[panelName] >= pageCount - 1;
  panel.empty.hidden = filtered.length > 0;
}

function closeFlightSummary() {
  flightSummary.hidden = true;
  continueSelection.setAttribute("aria-expanded", "false");
}

function showDirection(panelName) {
  for (const tab of directionTabs) {
    const active = tab.dataset.panel === panelName;
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
    document.querySelector(`#${tab.dataset.panel}-panel`).hidden = !active;
  }
}

function renderSelection() {
  for (const [direction, itinerary] of [
    ["outbound", selectedOutbound],
    ["inbound", selectedInbound],
  ]) {
    selectionPreviews[direction].textContent = itinerary
      ? `${itinerary.ItineraryOrigin} → ${itinerary.ItineraryDestination} · ${itinerary.TravelDate} · ${itinerary.Cabin}`
      : "No flight selected";
  }
  continueSelection.disabled = !selectedOutbound;
  clearOutboundSelection.hidden = !selectedOutbound;
  clearInboundSelection.hidden = !selectedInbound;
  selectionStatus.textContent = selectedOutbound
    ? selectedInbound
      ? "Both flights selected. Continue to review your flight summary."
      : "Outbound selected. Add an inbound flight or continue with outbound only."
    : selectedInbound
      ? "Inbound selected. Choose an outbound flight to continue."
      : "Choose an outbound flight to continue. Inbound is optional.";
}

function createSummaryCard(itinerary, direction) {
  const card = document.createElement("article");
  card.className = "flight-summary-card";
  const label = document.createElement("p");
  label.className = "eyebrow";
  label.textContent = direction === "outbound" ? "OUTBOUND FLIGHT" : "INBOUND FLIGHT";
  const heading = document.createElement("h4");
  heading.textContent = `${itinerary.ItineraryOrigin} → ${itinerary.ItineraryDestination}`;
  const details = document.createElement("dl");
  for (const [name, value] of getItineraryFields(itinerary)) {
    if (name === "Route" || name === "Direction") continue;
    const term = document.createElement("dt");
    term.textContent = name === "Points" ? "Points / passenger" : name;
    const description = document.createElement("dd");
    description.textContent = name === "Flights"
      ? itinerary.segments.map((segment) => [
        segment.number,
        segment.origin && segment.destination ? `${segment.origin} → ${segment.destination}` : "",
      ].filter(Boolean).join(" · ")).join("; ")
      : value;
    details.append(term, description);
  }
  card.append(label, heading, details);
  return card;
}

function render() {
  renderPanel("outbound");
  renderPanel("inbound");
  updateSortHeaders();
  const selectedDate = selectedOutbound?.TravelDate;
  inboundSelectionMessage.textContent = !syncInboundDateCheckbox.checked
    ? "Inbound dates are independent of the selected outbound flight."
    : selectedDate
      ? `Inbound travel starts at least one day after ${selectedDate}. It may depart from a different city.`
      : "Choose an outbound flight to set the inbound date minimum. Inbound may depart from a different city.";
  renderSelection();
  setNotice(rawRows.length
    ? `${rawRows.length.toLocaleString("en-GB")} flight legs grouped into ${itineraries.length.toLocaleString("en-GB")} itineraries.`
    : "No cached flights were returned for this feature.");
}

function updateSortHeaders() {
  for (const button of sortButtons) {
    const sortIndex = sortCriteria.findIndex(({ key }) => key === button.dataset.sort);
    const isActive = sortIndex !== -1;
    const sort = isActive ? sortCriteria[sortIndex] : null;
    const indicator = button.querySelector(".sort-indicator");
    button.setAttribute("aria-pressed", String(isActive));
    indicator.textContent = isActive
      ? `${sortIndex + 1} ${sort.direction === "ascending" ? "↑" : "↓"}`
      : "";
    button.setAttribute(
      "aria-label",
      `Sort by ${button.dataset.sortLabel}${isActive ? `, priority ${sortIndex + 1}, ${sort.direction}` : ", add as a sort level"}`,
    );
  }
  resetSortButton.hidden = sortCriteria.length === 1
    && sortCriteria[0].key === defaultSort.key
    && sortCriteria[0].direction === defaultSort.direction;
}

async function loadFeature(featureId) {
  const loadId = ++featureLoadId;
  pages.outbound = 0;
  pages.inbound = 0;
  rawRows = [];
  itineraries = [];
  selectedOutbound = null;
  selectedInbound = null;
  showDirection("outbound");
  closeFlightSummary();
  synchronizeDateRanges();
  setNotice("Loading flight results…");
  for (const panel of Object.values(resultPanels)) panel.count.textContent = "Loading…";
  try {
    const result = await fetchJson(`/api/features/${encodeURIComponent(featureId)}/results`);
    if (loadId !== featureLoadId) return;
    rawRows = result.rows;
    itineraries = buildItineraries(rawRows);
    const searchedLabel = result.searchDate ? `Searched ${result.searchDate}` : "No search date";
    searchDate.textContent = result.rateLimitRemaining === null
      ? searchedLabel
      : `${searchedLabel} · API remaining: ${Number(result.rateLimitRemaining).toLocaleString("en-GB")}`;
    render();
  } catch (error) {
    if (loadId !== featureLoadId) return;
    rawRows = [];
    itineraries = [];
    for (const panel of Object.values(resultPanels)) panel.count.textContent = "Unavailable";
    searchDate.textContent = "Search date unavailable";
    for (const panel of Object.values(resultPanels)) panel.empty.hidden = false;
    setNotice(error.message, true);
  }
}

async function initialize() {
  try {
    const result = await fetchJson("/api/features");
    featureRegistry = result.features;
    populateFeatureSelect(featureRegistry);
    const selectedFeature = featureRegistry[0];
    if (!selectedFeature) {
      for (const panel of Object.values(resultPanels)) panel.count.textContent = "No search features";
      setNotice("Add a search feature and its JSON results to the feature registry.", true);
      return;
    }
    populateTypeSelect(selectedFeature);
    await loadFeature(selectedFeature.id);
  } catch (error) {
    featureSelect.replaceChildren(createOption("", "Could not load features"));
    featureSelect.disabled = true;
    typeSelect.disabled = true;
    for (const panel of Object.values(resultPanels)) panel.count.textContent = "Unavailable";
    setNotice(error.message, true);
  }
}

featureSelect.addEventListener("change", () => {
  const feature = featureRegistry.find((item) => item.id === featureSelect.value);
  populateTypeSelect(feature);
  if (feature) loadFeature(feature.id);
});
typeSelect.addEventListener("change", () => {
  selectedOutbound = null;
  selectedInbound = null;
  closeFlightSummary();
  synchronizeDateRanges();
});
cabinSelect.addEventListener("change", () => {
  pages.outbound = 0;
  pages.inbound = 0;
  render();
});
function synchronizeDateRanges() {
  const outboundStart = dateInputs.outboundFrom.value;
  if (outboundStart) {
    dateInputs.outboundTo.min = outboundStart;
  } else {
    dateInputs.outboundTo.removeAttribute("min");
  }
  if (outboundStart && dateInputs.outboundTo.value && dateInputs.outboundTo.value < outboundStart) {
    dateInputs.outboundTo.value = outboundStart;
  }
  const inboundMinimumDate = getInboundMinimumDate();
  const inboundMinimum = inboundMinimumDate === null
    ? ""
    : new Date(inboundMinimumDate).toISOString().slice(0, 10);
  if (inboundMinimum) dateInputs.inboundFrom.min = inboundMinimum;
  else dateInputs.inboundFrom.removeAttribute("min");
  if (inboundMinimum && dateInputs.inboundFrom.value && dateInputs.inboundFrom.value < inboundMinimum) {
    dateInputs.inboundFrom.value = inboundMinimum;
  }
  const inboundMinimumEnd = dateInputs.inboundFrom.value || inboundMinimum;
  if (inboundMinimumEnd) dateInputs.inboundTo.min = inboundMinimumEnd;
  else dateInputs.inboundTo.removeAttribute("min");
  if (
    inboundMinimumEnd
    && dateInputs.inboundTo.value
    && dateInputs.inboundTo.value < inboundMinimumEnd
  ) {
    dateInputs.inboundTo.value = dateInputs.inboundFrom.value || inboundMinimum;
  }
  pages.outbound = 0;
  pages.inbound = 0;
  const inboundSelectionExpired = selectedInbound
    && inboundMinimumDate !== null
    && parseUkDate(selectedInbound.TravelDate) < inboundMinimumDate;
  if (inboundSelectionExpired) {
    selectedInbound = null;
    closeFlightSummary();
  }
  render();
  if (inboundSelectionExpired) {
    selectionStatus.textContent = "Your previous inbound flight is before the new minimum date and has been removed. Choose a later inbound flight or continue with outbound only.";
  }
}
for (const input of Object.values(dateInputs)) {
  input.addEventListener("input", synchronizeDateRanges);
  input.addEventListener("change", synchronizeDateRanges);
}
syncInboundDateCheckbox.addEventListener("change", () => {
  if (syncInboundDateCheckbox.checked && selectedOutbound) {
    dateInputs.inboundFrom.value = new Date(getInboundMinimumDate()).toISOString().slice(0, 10);
  }
  synchronizeDateRanges();
});
clearOutboundSelection.addEventListener("click", () => {
  selectedOutbound = null;
  closeFlightSummary();
  synchronizeDateRanges();
});
clearInboundSelection.addEventListener("click", () => {
  selectedInbound = null;
  closeFlightSummary();
  render();
});
continueSelection.addEventListener("click", () => {
  if (!selectedOutbound) {
    selectionStatus.textContent = "Choose an outbound flight before continuing.";
    return;
  }
  const cards = [createSummaryCard(selectedOutbound, "outbound")];
  if (selectedInbound) cards.push(createSummaryCard(selectedInbound, "inbound"));
  summaryCards.replaceChildren(...cards);
  summaryDescription.textContent = selectedInbound
    ? "Outbound and inbound flights selected. Review the details for each flight below."
    : "Outbound only. No inbound flight selected; you can add one by editing your selection.";
  flightSummary.hidden = false;
  continueSelection.setAttribute("aria-expanded", "true");
  summaryHeading.focus({ preventScroll: true });
  flightSummary.scrollIntoView({ block: "start" });
});
editSelection.addEventListener("click", () => {
  closeFlightSummary();
  selectionBar.scrollIntoView({ block: "start" });
  continueSelection.focus({ preventScroll: true });
});
for (const [index, tab] of directionTabs.entries()) {
  tab.addEventListener("click", () => showDirection(tab.dataset.panel));
  tab.addEventListener("keydown", (event) => {
    let targetIndex;
    if (event.key === "ArrowRight") targetIndex = (index + 1) % directionTabs.length;
    else if (event.key === "ArrowLeft") targetIndex = (index + directionTabs.length - 1) % directionTabs.length;
    else if (event.key === "Home") targetIndex = 0;
    else if (event.key === "End") targetIndex = directionTabs.length - 1;
    else return;
    event.preventDefault();
    const target = directionTabs[targetIndex];
    showDirection(target.dataset.panel);
    target.focus();
  });
}
searchInput.addEventListener("input", () => {
  pages.outbound = 0;
  pages.inbound = 0;
  render();
});
for (const [panelName, panel] of Object.entries(resultPanels)) {
  panel.previous.addEventListener("click", () => {
    pages[panelName] = Math.max(0, pages[panelName] - 1);
    renderPanel(panelName);
  });
  panel.next.addEventListener("click", () => {
    pages[panelName] += 1;
    renderPanel(panelName);
  });
}
for (const button of sortButtons) {
  button.addEventListener("click", () => {
    const existingSort = sortCriteria.find(({ key }) => key === button.dataset.sort);
    if (existingSort) {
      existingSort.direction = existingSort.direction === "ascending" ? "descending" : "ascending";
    } else if (!hasCustomSort) {
      sortCriteria = [{ key: button.dataset.sort, direction: "ascending" }];
    } else {
      sortCriteria.push({ key: button.dataset.sort, direction: "ascending" });
    }
    hasCustomSort = true;
    pages.outbound = 0;
    pages.inbound = 0;
    render();
  });
}
resetSortButton.addEventListener("click", () => {
  sortCriteria = [{ ...defaultSort }];
  hasCustomSort = false;
  pages.outbound = 0;
  pages.inbound = 0;
  render();
});

initialize();
