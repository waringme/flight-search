# Flight search alert

A small, manual Seats.aero scanner for award availability from the UK and European gateways to eastern Australia. It reports:

- first-class award seats (`FRemainingSeats > 0`);
- business-cabin award seats (`JRemainingSeats > 0`); and
- premium-economy seats (`WRemainingSeats > 0`).

The scanner searches Europe ↔ Australia, Europe → Asia, and Europe ↔ the US/Canada across configurable airport groups. It queries the configured BA Executive Club (`british`) and Qantas Frequent Flyer (`qantas`) schemes separately without an operating-airline restriction, so partner redemptions are included. Separate BA-source searches in each direction to Australia and Asia apply the configured `UPGRADE_CARRIER` filter for possible upgrade-voucher candidates. Premium-economy availability is only a lead; voucher rules and upgrade inventory must be confirmed with British Airways.

The Aer Lingus Rewards feature searches British Airways Executive Club, Alaska Airlines Mileage Plan, United MileagePlus, and American AAdvantage cached availability. It requests premium-economy and business awards (not economy), applies Seats.aero's `EI` carrier filter, and retains itineraries operated exclusively by Aer Lingus. Coverage uses Seats.aero's Europe, US, Canada, Caribbean, and Mexico meta-airport groups, plus Manchester and Shannon. Results are limited to routes and dates Seats.aero tracks; verify inventory with the partner before booking.

## API key

Keep the key on the server/CLI side, never in browser code or source control.

1. Copy `.env.example` to `.env`.
2. Put your key in `.env` as `SEATS_AERO_API_KEY=...`.
3. Do not commit or share `.env`. It is ignored by `.gitignore`.

The API key is sent in the `Partner-Authorization` request header. For a deployed scanner, add it to the deployment platform's secret store instead of uploading `.env`.

## Run a search

Requires Node.js 20.6 or later. The initial scan is manual:

```sh
npm test
npm run search
npm run search -- --aer-lingus-only
npm run web
```

Use `npm run search -- --aer-lingus-only` to update only the Aer Lingus feature without running the Australia and North America searches. Each full search run writes its individual flight legs to **`Australia Flights.csv`**, **`North America Flights.csv`**, and **`Aer Lingus Rewards.csv`**; the Aer Lingus-only mode updates only its corresponding CSV and metadata. North America and Aer Lingus exports are also split into calendar-quarter CSVs by travel date, with chunk names and row counts recorded in their metadata. Latest combined CSVs are used by the web interface, and timestamped, non-overwriting snapshots are saved in **`history/`**. Matching metadata JSON files store the rate-limit remaining value for each run; the latest values are displayed beside the searched date in the app. This is the minimum `X-RateLimit-Remaining` seen across the scan's requests. Timestamps use UTC and include milliseconds. Exports are implemented as named search features in `src/flight-results-csv.js`.

The local web interface runs at `http://127.0.0.1:3000`. Shared master controls select the feature, loyalty/search type, cabin, and text filter. Results are split into outbound and inbound panels; each panel has inclusive From/To date filters and its own pagination, while sorting is shared. Choose an outbound itinerary and enable the inbound-date checkbox to set the inbound start to the following day; inbound results are not restricted to the same city as the outbound destination. Turn the checkbox off to keep inbound dates independent. Hover or keyboard-focus an itinerary row to see its points, taxes, operating carriers, stops, flight list, departure/arrival times, and other trip details. Each itinerary also shows its individual flight segments. Set `PORT` to choose another local port.

Seats.aero tax totals are exported as currency major units with two decimal places. Integer source values are interpreted as minor units (for example, `107854 EUR` becomes `EUR 1,078.54`); the original API value is retained in the CSV's `TaxesPerItineraryRaw` column for auditing.

By default, the search covers today through the next 12 months. Australia and Asia searches use the airport groups listed above; the North America feature uses four UK/European gateways (`LHR,CDG,AMS,FRA`) and four major US/Canadian gateways (`JFK,LAX,YYZ,YVR`) to keep the multi-city results practical to load. Both groups can be expanded or changed with `NORTH_AMERICAN_ORIGIN_AIRPORTS` and `NORTH_AMERICAN_AIRPORTS`. It searches Europe ↔ North America in both directions, allowing different arrival and departure cities. To change the search date range:

```sh
npm run search -- --start 2027-01-01 --end 2027-12-31
```

Airport groups and the operating-carrier filter can be overridden in `.env`:

```dotenv
ORIGIN_AIRPORTS=LHR,LGW,EDI,MAN
DESTINATION_AIRPORTS=SYD,MEL,BNE
OPERATING_CARRIER=BA
EUROPEAN_ORIGIN_AIRPORTS=LHR,LGW,CDG,AMS,FRA,MAD
AUSTRALIAN_AIRPORTS=SYD,MEL,BNE
ASIAN_AIRPORTS=BKK,HKG,HND,KUL,PVG,SIN
NORTH_AMERICAN_ORIGIN_AIRPORTS=LHR,CDG,AMS,FRA
NORTH_AMERICAN_AIRPORTS=JFK,LAX,YYZ,YVR
UPGRADE_CARRIER=BA
LOYALTY_SCHEMES=BA,QF
```

`ORIGIN_AIRPORTS`, `DESTINATION_AIRPORTS`, and `OPERATING_CARRIER` control the original UK scan. `EUROPEAN_ORIGIN_AIRPORTS` and `AUSTRALIAN_AIRPORTS` control both directions of the Europe–Australia loyalty searches; `ASIAN_AIRPORTS` controls the BA upgrade-voucher search between Europe and Asia in both directions. Its default excludes India. `LOYALTY_SCHEMES` accepts `BA`, `QF`, or both. BA/Qantas loyalty searches may include partner-operated itineraries; `UPGRADE_CARRIER=BA` keeps voucher candidates restricted to BA-operated trips.

Seats.aero returns cached availability, not live inventory. Multi-stop results (including possible connections via Asia) depend on the routes and trip details it has cached. Results are paginated and deduplicated; a missing or unusable API response is reported as an error rather than treated as no availability. Verify award bookability, points, taxes, and any voucher eligibility with the relevant airline before booking.

## API reference

[Seats.aero API documentation](https://seats.aero/skill.md)
