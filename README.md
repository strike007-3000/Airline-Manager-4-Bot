# Airline-Manager-4-Bot

This repository contains a bot for Airline Manager 4, built with Playwright and scheduled to run on GitHub Actions. The workflow stays on a single GitHub Actions job, uses cached Chromium, and avoids extra jobs, artifacts, or paid services so it remains friendly to the GitHub free tier.

## Features

### Implemented
- Start an eco-friendly campaign if not already started.
- Run a lightweight smart marketing selector for airline reputation campaigns.
- Track in-game fuel and CO2 price history in a local JSON cache and score current game prices by percentile.
- Buy fuel and CO2 using in-game market-intelligence rules based on game price caps, favorable percentiles, and minimum cover hours.
- Depart all planes.
- Schedule repairs and A-Checks if needed.
- Force CO2 purchases when holdings go negative, even if the market is expensive.
- Change ticket prices once a day for Easy mode flights that have not departed yet, using simple built-in multipliers.

## Why the campaign selector is simpler than route optimization

Yes — a **smart marketing/campaign selector** can be added without requiring much information.

This implementation only needs:
- `MARKETING_MODE`
- optionally `MARKETING_BUDGET`

If you do not provide detailed campaign settings, the bot can still make a simple choice:
- always keep eco-friendly active.
- start a low, medium, or high reputation campaign based on one budget variable.

That is much easier than route optimization because it does not require airport, aircraft, or route candidate data.

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
- `TARGET_FUEL_COVER_HOURS`: `36`
- `AGGRESSIVE_FUEL_COVER_HOURS`: `72`
- `MINIMUM_CO2_COVER_HOURS`: `24`
- `TARGET_CO2_COVER_HOURS`: `72`
- `AGGRESSIVE_CO2_COVER_HOURS`: `120`
- `AVERAGE_FUEL_BURN_PER_DEPARTURE`: `250000`
- `AVERAGE_CO2_BURN_PER_DEPARTURE`: `100000`
- `FAVORABLE_FUEL_PERCENTILE`: `35`
- `FAVORABLE_CO2_PERCENTILE`: `35`
- `MARKET_HISTORY_FILE`: optional local cache path such as `.cache/market-history.json`
- `MARKETING_MODE`: `smart`
- `MARKETING_BUDGET`: `low`
- `GAME_MODE`: `easy`
- `PRICE_UPDATE_HOUR_UTC`: `23`
- `PRICE_UPDATE_HOURS_UTC`: optional comma-separated list such as `1,13,23`
- `MAX_PRICE_UPDATES_PER_RUN`: `12`
- `EASY_MODE_ECONOMY_MULTIPLIER_PERCENT`: `110`
- `EASY_MODE_BUSINESS_MULTIPLIER_PERCENT`: `108`
- `EASY_MODE_FIRST_MULTIPLIER_PERCENT`: `106`
- `EASY_MODE_CARGO_LARGE_MULTIPLIER_PERCENT`: `110`
- `EASY_MODE_CARGO_HEAVY_MULTIPLIER_PERCENT`: `108`

### 4. Optional legacy campaign variables

If you want to keep manually controlling the exact reputation campaign instead of using the smart selector, you can still set:

- `INCREASE_AIRLINE_REPUTATION`: `true`
- `CAMPAIGN_TYPE`: `1`
- `CAMPAIGN_DURATION`: `4`

If those legacy variables are present, they override the smart selector for the reputation campaign.

### 5. Daily Easy mode pricing

You said you do **not** want to maintain route-by-route pricing JSON.

This version now works differently:

- it does **not** require any route list.
- it only runs during your configured pricing hour window, controlled by `PRICE_UPDATE_HOUR_UTC` or `PRICE_UPDATE_HOURS_UTC`.
- it only tries to update flights that look **not yet departed** on the routes page.
- it applies simple Easy mode multipliers to the visible price inputs it can find.

Default Easy mode multipliers:
- Economy: `110%`
- Business: `108%`
- First: `106%`

Optional cargo multipliers if you use cargo aircraft:
- `EASY_MODE_CARGO_LARGE_MULTIPLIER_PERCENT`
- `EASY_MODE_CARGO_HEAVY_MULTIPLIER_PERCENT`

### 6. What the pricing assistant does

The pricing assistant now follows a simpler Easy mode flow:
- it checks the current UTC hour
- it only runs when the hour matches `PRICE_UPDATE_HOUR_UTC`, or any hour in `PRICE_UPDATE_HOURS_UTC`
- it looks for price editors on the routes page
- it skips rows that appear to already be departed
- it updates up to `MAX_PRICE_UPDATES_PER_RUN` flights in that daily window

### 7. Enable GitHub Actions

Open the **Actions** tab in your fork and enable workflows.

### 8. Run it manually once first

1. Open **Actions**.
2. Select **Playwright Tests**.
3. Click **Run workflow**.
4. Wait for the job to finish.
5. Open the run and read the **step summary**.

That run should update the ticket prices of not-yet-departed Easy mode flights during the daily pricing window.

### 9. Let the schedule run automatically

The default schedule runs at:
- `23:00 UTC`
- `01:00 UTC`
- `03:00 UTC`
- `05:00 UTC`
- `07:00 UTC`
- `09:00 UTC`

If you want fewer GitHub minutes, reduce the cron schedule in `.github/workflows/playwright.yml`.

## Free-tier guidance

This setup is designed to stay inexpensive on GitHub Actions:

- One workflow job only.
- No matrix builds.
- No artifact uploads.
- No paid APIs.
- Chromium only.
- No route-optimizer scan or route JSON maintenance.
- Price updates are limited to one UTC hour per day.
- Updates are capped by `MAX_PRICE_UPDATES_PER_RUN`.

If you want to keep usage even lower:
- reduce the schedule frequency.
- keep Playwright on a single browser.

## Step-by-step: how to start running this on GitHub Actions

1. Fork the repository.
2. Add the `EMAIL` and `PASSWORD` secrets.
3. Add `MAX_FUEL_PRICE` and `MAX_CO2_PRICE`.
4. Add `MARKETING_MODE=smart`.
5. Add `MARKETING_BUDGET=low`.
6. Add `GAME_MODE=easy`.
7. Add `PRICE_UPDATE_HOUR_UTC=23`.
8. Add `MAX_PRICE_UPDATES_PER_RUN=12`.
9. Add `EASY_MODE_ECONOMY_MULTIPLIER_PERCENT=110`.
10. Add `EASY_MODE_BUSINESS_MULTIPLIER_PERCENT=108`.
11. Add `EASY_MODE_FIRST_MULTIPLIER_PERCENT=106`.
12. Enable GitHub Actions.
13. Run the workflow manually once near one of your configured pricing hours.
14. If everything looks good, leave the schedule enabled.

## Notes
- Language of your game must be **English** for this bot to work.
- Trigger times may vary due to heavy loads on GitHub Actions.
- To change the schedule, edit the **cron** expressions under **schedule** in `.github/workflows/playwright.yml`. Use [crontab.guru](https://crontab.guru/) to generate your desired cron expression.
- If you want pricing to run at multiple UTC hours, set `PRICE_UPDATE_HOURS_UTC` to a comma-separated list like `1,13,23` and make sure the workflow **schedule** includes those hours.
- This repository can be public as long as your login details stay in GitHub **Actions secrets** and your thresholds stay in GitHub **Actions variables**. Do not commit credentials or personal values directly into the repository.
- If you still prefer not to expose the code publicly, you can clone this project and commit it to a private repository instead.
- For questions, reach out on Discord: `muhittin852`.

## Fuel / CO2 market intelligence

The fuel purchaser now keeps a local JSON history of in-game fuel and CO2 prices, estimates upcoming consumption from the visible planned departures on the routes page, and buys by cover time rather than hard-coded low-stock numbers.

This logic is driven only by what the bot observes inside Airline Manager 4. It does not use or react to any real-world fuel or carbon market data.

The logic now:
- snapshots planned departures before opening the fuel market
- estimates hourly fuel and CO2 usage using configurable average burn-per-departure values
- maintains minimum cover in hours
- buys up to a larger bulk-cover target when the current in-game price percentile is favorable
- forces a CO2 purchase if holdings are negative, even when the price is above the normal cap

Because GitHub-hosted runners are ephemeral, the price-history cache is most useful on a persistent runner or when your workflow preserves the file between runs.
