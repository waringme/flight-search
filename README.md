# Flight search alert

A small Seats.aero scanner for award availability from the UK and European gateways to eastern Australia, run manually or on a GitHub Actions schedule. It reports:

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

Use `npm run search -- --aer-lingus-only` to update only the Aer Lingus feature without running the Australia and North America searches. Each full search run writes its individual flight legs as JSON arrays to **`Australia Flights.json`**, **`North America Flights.json`**, and **`Aer Lingus Rewards.json`**; the Aer Lingus-only mode updates only its corresponding JSON and metadata. North America and Aer Lingus exports are also split into calendar-quarter JSON files by travel date, with chunk names and row counts recorded in their metadata. Latest combined JSON files are used by the web interface, and timestamped, non-overwriting snapshots are saved in **`history/`**. Matching metadata JSON files store the rate-limit remaining value for each run; the latest values are displayed beside the searched date in the app. This is the minimum `X-RateLimit-Remaining` seen across the scan's requests. Timestamps use UTC and include milliseconds. Exports are implemented as named search features in `src/flight-results-csv.js`.

The local web interface runs at `http://127.0.0.1:3000`. Shared master controls select the feature, loyalty/search type, cabin, and text filter. Full-width Outbound and Inbound tabs each contain a compact results table, inclusive From/To date filters and independent pagination. Tables show the route, individual flight segments, UTC departure/arrival times, cabin, available seats, loyalty scheme, points and taxes. Column headings and the date/Choose column stay visible while scrolling within the table. Points and taxes are colour-highlighted. Shared sort buttons above the tabs retain multi-level sorting and show each active sort's priority and direction. The direction tabs also support Left/Right arrow, Home and End keys.

Tick the checkbox beside an outbound itinerary's travel date, or use its Choose button below the date, to select it and set inbound From to the following day (the inbound-date link is enabled by default). Only one outbound itinerary can be selected at a time; selecting another replaces it. Switch to the Inbound tab to choose an optional return flight; inbound results are not restricted to the same city as the outbound destination. Turn off the inbound-date link to keep inbound dates independent. Hover or keyboard-focus an itinerary row to see its points, taxes, operating carriers, stops, flight list, departure/arrival times, and other trip details. Set `PORT` to choose another local port.

Choose an optional inbound flight in the same way. The selection bar above the results shows the selected flights and enables **Continue** once an outbound flight is selected. Continue reveals an inline flight summary above the results, with routes, dates, cabin, seats, loyalty schemes, points, taxes, individual flight segments and available departure/arrival times. **Edit selection** returns to the results without losing the selections. Points and taxes stay separate for each flight; this is a review screen, not a booking. Changing the search feature or search type clears both selections. Other filters and pagination retain the selected flights in the selection bar. When linked dates are enabled, moving the outbound date past a selected inbound flight removes that inbound selection and displays an explanation.

Date filters refresh the results immediately while the date is being edited, without waiting for focus to leave the field. Inbound From applies on its own: leaving the optional To date empty includes every available inbound flight on or after From. Choosing an outbound flight updates From to the next day and refreshes inbound results immediately.

## Deploy the web interface to Vercel

Use the repository root as the Vercel project root and the **Other** framework preset, with no build command or output-directory override. `vercel.json` disables framework auto-detection and routes requests to `api/index.js`, which exports the web request handler without opening a listening socket. `src/index.js` remains the local CLI scanner, not the deployment entry point.

The function bundles `public/` and the root-level flight JSON and metadata files. It does not read `history/`. Commit `Australia Flights.json`, the quarterly North America and Aer Lingus JSON files listed in their metadata, and the corresponding root-level `.meta.json` files. When a combined JSON file is absent, the server loads the quarterly files from its metadata and checks their row counts. Missing or invalid data is reported as an error, not as empty search results. The viewer reads JSON arrays, not legacy CSV exports.

The deployed app is a read-only viewer of these saved results. By default it reads bundled exports; alternatively, configure the R2 source below to refresh data without committing exports or redeploying the viewer. No Seats.aero API key or R2 upload credentials are needed by the web function. Do not commit `.env` or configure a deployment command that runs `npm run search`.

The results endpoints stream their JSON responses in batches to avoid Vercel's buffered-response size limit. The browser still receives the same complete JSON object and keeps its existing filtering and pagination behaviour.

## Scheduled refreshes with GitHub Actions and Cloudflare R2

`.github/workflows/refresh-flights.yml` runs daily at **02:00 UTC**, can be started with **Actions → Refresh and upload flight results → Run workflow**, and runs on pushes to `main` that change the scanner/server source, package manifest, or workflow. Scheduled runs use the workflow on the default branch and can be delayed by GitHub. Change the `cron` expression to adjust the time.

Create an R2 bucket and enable public read access through a custom domain (recommended for production) or the `r2.dev` development URL. Use the public bucket URL, not the authenticated `r2.cloudflarestorage.com` S3 endpoint. The exported flight data will be publicly readable; never put credentials or private files in this bucket.

In the GitHub repository's **Settings → Secrets and variables → Actions**, add these repository secrets:

| Secret | Value |
| --- | --- |
| `SEATS_AERO_API_KEY` | Seats.aero API key used by the scanner |
| `R2_ACCOUNT_ID` | Cloudflare account ID |
| `R2_ACCESS_KEY_ID` | R2 S3 API access key ID |
| `R2_SECRET_ACCESS_KEY` | R2 S3 API secret access key |
| `R2_BUCKET` | Destination bucket name |

Create an R2 API token with **Object Read & Write** access scoped to this bucket. The workflow checks configuration, runs the scanner in an empty temporary directory, and uses the runner's AWS CLI to upload only generated root-level JSON, including metadata and quarterly chunks. It does not upload `.env`, source code, or `history/`, and it does not commit generated data back to GitHub. There is no `npm ci` or npm cache step because this project has no dependencies or lockfile.

Each run uploads under `runs/<run-id>-<attempt>/`. Only after the complete upload succeeds does it replace `current.json` with that run's prefix. Failed scans/uploads leave the previous published dataset selected. Completed runs are immutable. After each successful publication, cleanup retains **at most two result folders**: the folder referenced by `current.json` and the newest other folder by object modification time. It deletes older run folders, oldest first, and verifies the final count. The root `current.json` and anything outside `runs/` are not deleted. Do not apply a Cloudflare cache rule that overrides the pointer's `Cache-Control: no-store` header.

To prune existing folders without fetching new flights, use **Actions → Keep two R2 result folders → Run workflow** (`.github/workflows/prune-flight-results.yml`). This uses the same R2 secrets and requires object list/read/delete permission. Both workflows share a concurrency group so cleanup cannot overlap an upload. Cleanup stops if the published folder is missing, an unexpected run path is found, the pointer changes, or a storage operation fails; it does not guess which folder is safe to delete. Failed uploads can leave partial folders until a subsequent successful publication or manual cleanup.

Set **`FLIGHT_RESULTS_BASE_URL`** in your web host's environment to the public bucket URL, for example `https://flights-data.example.com/`, and redeploy once to pick up this configuration. The web server resolves `current.json` once per API request and reads all files for that request from the same published run. Subsequent scheduled refreshes need no app redeployment. Invalid or unreachable remote data is reported as an error, never silently replaced with stale bundled data. Public data is fetched server-side, so browser CORS configuration is not required.

For a local viewer using R2, explicitly pass the variable to the web process:

```sh
FLIGHT_RESULTS_BASE_URL=https://flights-data.example.com/ npm run web
```

Omit `FLIGHT_RESULTS_BASE_URL` to keep using local JSON files. `npm run web` does not automatically load `.env`; the scanner's `npm run search` command does. Before enabling R2 for the viewer, complete the first successful workflow run and confirm `<public-bucket-url>/current.json` is accessible.

## Search configuration

Seats.aero tax totals are exported as currency major units with two decimal places. Integer source values are interpreted as minor units (for example, `107854 EUR` becomes `EUR 1,078.54`); the original API value is retained in the JSON row's `TaxesPerItineraryRaw` field for auditing.

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
