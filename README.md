# Airline-Manager-4-Bot

This repository contains a bot for Airline Manager 4, built with Playwright and scheduled to run on GitHub Actions. The workflow stays on a single GitHub Actions job, uses cached Chromium, and avoids extra jobs, artifacts, or paid services so it remains friendly to the GitHub free tier.

## Features

### Implemented
- Start an eco-friendly campaign if not already started.
- Keep the Eco Friendly campaign running with a simple 12-hour default activation.
- Track in-game fuel and CO2 price history in a local JSON cache for lightweight local state.
- Buy fuel and CO2 using simplified cover-threshold rules driven by upcoming departures.
- Depart all planes.
- Schedule due A-Checks and repairs (30%+ wear by default), including a departure-time retry flow if maintenance blocks a flight.
- Force CO2 purchases when holdings go negative, even if the market is expensive.
- Change ticket prices once a day for Easy mode flights that have not departed yet, using simple built-in multipliers.

## Usage Instructions

### 1. Fork this repository

Fork the repository to your own GitHub account.

### 2. Set up secrets

Go to **Settings** > **Secrets and variables** > **Actions** > **Secrets** and create:

- `EMAIL`: your Airline Manager 4 email.
- `PASSWORD`: your Airline Manager 4 password.

### 3. Set up variables

Go to **Settings** > **Secrets and variables** > **Actions** > **Variables** and create these baseline variables:

- `MAX_FUEL_PRICE`: `550`
- `MAX_CO2_PRICE`: `120`
- `MINIMUM_FUEL_COVER_HOURS`: `12`
- `MINIMUM_CO2_COVER_HOURS`: `24`
- `AVERAGE_FUEL_BURN_PER_DEPARTURE`: `250000`
- `AVERAGE_CO2_BURN_PER_DEPARTURE`: `100000`
- `MARKET_HISTORY_FILE`: optional local cache path such as `.cache/market-history.json`
- `GAME_MODE`: `easy`
- `REPAIR_THRESHOLD_PERCENT`: optional wear threshold for bulk repairs, default `30`
- `MAX_PRICE_UPDATES_PER_RUN`: `12`
- `EASY_MODE_ECONOMY_MULTIPLIER_PERCENT`: `110`
- `EASY_MODE_BUSINESS_MULTIPLIER_PERCENT`: `108`
- `EASY_MODE_FIRST_MULTIPLIER_PERCENT`: `106`
- `EASY_MODE_CARGO_LARGE_MULTIPLIER_PERCENT`: `110`
- `EASY_MODE_CARGO_HEAVY_MULTIPLIER_PERCENT`: `108`

### 5. Daily Easy mode pricing

You said you do **not** want to maintain route-by-route pricing JSON.

This version now works differently:

- it does **not** require any route list.
- it only tries to update flights that look **not yet departed** on the routes page.
- it applies simple Easy mode multipliers to the visible price inputs it can find every run, right before departures.

Default Easy mode multipliers:
- Economy: `110%`
- Business: `108%`
- First: `106%`

Optional cargo multipliers if you use cargo aircraft:
- `EASY_MODE_CARGO_LARGE_MULTIPLIER_PERCENT`
- `EASY_MODE_CARGO_HEAVY_MULTIPLIER_PERCENT`

### 6. What the pricing assistant does

The pricing assistant now follows a simpler Easy mode flow:
- it looks for price editors on the routes page
- it skips rows that appear to already be departed
- it updates up to `MAX_PRICE_UPDATES_PER_RUN` flights before the bot departs planes

### 7. Enable GitHub Actions

Open the **Actions** tab in your fork and enable workflows.

### 8. Run it manually once first

1. Open **Actions**.
2. Select **Playwright Tests**.
3. Click **Run workflow**.
4. Wait for the job to finish.
5. Open the run and read the **step summary**.

That run should update the ticket prices of not-yet-departed Easy mode flights before the departure step.

### 9. Let the schedule run automatically

The default schedule is aligned to CET and runs at:
- `23:00 CET` (`22:00 UTC`)
- `01:00 CET` (`00:00 UTC`)
- `03:00 CET` (`02:00 UTC`)
- `05:00 CET` (`04:00 UTC`)
- `07:00 CET` (`06:00 UTC`)
- `09:00 CET` (`08:00 UTC`)

If you want fewer GitHub minutes, reduce the cron schedule in `.github/workflows/playwright.yml`.

## Maintenance behavior

The bot now handles maintenance in two places:
- during the normal maintenance step
- again immediately before departure attempts

That means if a flight becomes blocked because of a due A-Check or because wear is at or above the configured repair threshold, the bot goes back to maintenance, schedules the work, returns to the routes page, and retries departures.

Bulk repairs now default to `30%` wear, configurable with `REPAIR_THRESHOLD_PERCENT`.

The pricing step also runs immediately before departures on every workflow run, so there is no longer a separate UTC pricing-hour gate to configure.

## Free-tier guidance

This setup is designed to stay inexpensive on GitHub Actions:

- One workflow job only.
- No matrix builds.
- No artifact uploads.
- No paid APIs.
- Chromium only.
- No route-optimizer scan or route JSON maintenance.
- Updates are capped by `MAX_PRICE_UPDATES_PER_RUN`.

If you want to keep usage even lower:
- reduce the schedule frequency.
- keep Playwright on a single browser.

## Step-by-step: how to start running this on GitHub Actions

1. Fork the repository.
2. Add the `EMAIL` and `PASSWORD` secrets.
3. Add `MAX_FUEL_PRICE` and `MAX_CO2_PRICE`.
4. Add `GAME_MODE=easy`.
5. Add `MAX_PRICE_UPDATES_PER_RUN=12`.
6. Add `EASY_MODE_ECONOMY_MULTIPLIER_PERCENT=110`.
7. Add `EASY_MODE_BUSINESS_MULTIPLIER_PERCENT=108`.
8. Add `EASY_MODE_FIRST_MULTIPLIER_PERCENT=106`.
9. Enable GitHub Actions.
10. Run the workflow manually once.
11. If everything looks good, leave the schedule enabled.

## Notes
- Language of your game must be **English** for this bot to work.
- Trigger times may vary due to heavy loads on GitHub Actions.
- To change the schedule, edit the **cron** expressions under **schedule** in `.github/workflows/playwright.yml`. Use [crontab.guru](https://crontab.guru/) to generate your desired cron expression.
- GitHub Actions cron itself is UTC, so the default workflow already uses the UTC equivalents for the listed CET run times.
- This repository can be public as long as your login details stay in GitHub **Actions secrets** and your thresholds stay in GitHub **Actions variables**. Do not commit credentials or personal values directly into the repository.
- If you still prefer not to expose the code publicly, you can clone this project and commit it to a private repository instead.
- For questions, reach out on Discord: `muhittin852`.

## Fuel / CO2 market intelligence

The fuel purchaser keeps a local JSON history of in-game fuel and CO2 values, estimates upcoming consumption from the visible planned departures on the routes page, and uses simple threshold-based purchases instead of a more aggressive top-up strategy.

This logic is driven only by what the bot observes inside Airline Manager 4. It does not use or react to any real-world fuel or carbon market data.

The logic now:
- snapshots planned departures before opening the fuel market
- estimates hourly fuel and CO2 usage using configurable average burn-per-departure values
- if fuel or CO2 is at or below the configured market-price threshold, it buys to full remaining capacity immediately
- maintains minimum cover in hours
- if fuel or CO2 falls below the configured minimum cover threshold, it buys to full remaining capacity immediately
- if CO2 is already negative while the market is above the configured threshold, it buys a buffered top-up (at least enough to clear the deficit, otherwise about half the remaining capacity) before departures
- if CO2 is already negative while the market is above the configured threshold, it keeps buying until the deficit is cleared
- skips additional purchases whenever the current cover is already healthy

Because GitHub-hosted runners are ephemeral, the price-history cache is most useful on a persistent runner or when your workflow preserves the file between runs.
