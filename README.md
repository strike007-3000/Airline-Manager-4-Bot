# Airline-Manager-4-Bot

This repository contains a bot for Airline Manager 4, built with Playwright and scheduled to run on GitHub Actions. The workflow stays on a single GitHub Actions job, uses cached Chromium, and avoids extra jobs, artifacts, or paid services so it remains friendly to the GitHub free tier.

## Features

### Implemented
- Start an eco-friendly campaign if not already started.
- Run a lightweight smart marketing selector for airline reputation campaigns.
- Buy fuel and CO2 if prices are below specified thresholds.
- Depart all planes.
- Schedule repairs and A-Checks if needed.
- Buy fuel and CO2 at higher prices if supplies are nearly finished.
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
- `MARKETING_MODE`: `smart`
- `MARKETING_BUDGET`: `low`
- `GAME_MODE`: `easy`
- `PRICE_UPDATE_HOUR_UTC`: `23`
- `MAX_PRICE_UPDATES_PER_RUN`: `12`
- `EASY_MODE_ECONOMY_MULTIPLIER_PERCENT`: `110`
- `EASY_MODE_BUSINESS_MULTIPLIER_PERCENT`: `108`
- `EASY_MODE_FIRST_MULTIPLIER_PERCENT`: `106`

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
- it only runs once per day, controlled by `PRICE_UPDATE_HOUR_UTC`.
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
- it only runs when the hour matches `PRICE_UPDATE_HOUR_UTC`
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
13. Run the workflow manually once near your configured `PRICE_UPDATE_HOUR_UTC`.
14. If everything looks good, leave the schedule enabled.

## Notes
- Language of your game must be **English** for this bot to work.
- Trigger times may vary due to heavy loads on GitHub Actions.
- To change the schedule, edit the **cron** expressions under **schedule** in `.github/workflows/playwright.yml`. Use [crontab.guru](https://crontab.guru/) to generate your desired cron expression.
- This repository can be public as long as your login details stay in GitHub **Actions secrets** and your thresholds stay in GitHub **Actions variables**. Do not commit credentials or personal values directly into the repository.
- If you still prefer not to expose the code publicly, you can clone this project and commit it to a private repository instead.
- For questions, reach out on Discord: `muhittin852`.
