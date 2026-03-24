import { Locator, Page } from '@playwright/test';
import { appendFileSync } from 'fs';
import { ConfigUtils } from './config.utils';

export class PricingUtils {
  private readonly page: Page;
  private readonly githubStepSummary?: string;
  private readonly maxPriceUpdatesPerRun: number;
  private readonly pricingDeadlineMs: number;
  private readonly gameMode: string;
  private readonly enablePricing: boolean;
  private readonly multipliers: any;

  constructor(page: Page) {
    this.page = page;
    this.githubStepSummary = process.env.GITHUB_STEP_SUMMARY;
    this.maxPriceUpdatesPerRun = ConfigUtils.optionalNumber('MAX_PRICE_UPDATES_PER_RUN', 12);
    this.pricingDeadlineMs = ConfigUtils.optionalNumber('PRICING_DEADLINE_MS', 15000);
    this.gameMode = ConfigUtils.optionalString('GAME_MODE', 'easy').toLowerCase();
    this.enablePricing = ConfigUtils.optionalBoolean('ENABLE_PRICING', true);
    
    this.multipliers = {
      economy: ConfigUtils.optionalNumber('EASY_MODE_ECONOMY_MULTIPLIER_PERCENT', 110) / 100,
      business: ConfigUtils.optionalNumber('EASY_MODE_BUSINESS_MULTIPLIER_PERCENT', 108) / 100,
      first: ConfigUtils.optionalNumber('EASY_MODE_FIRST_MULTIPLIER_PERCENT', 106) / 100,
      cargoLarge: ConfigUtils.optionalNumber('EASY_MODE_CARGO_LARGE_MULTIPLIER_PERCENT', 110) / 100,
      cargoHeavy: ConfigUtils.optionalNumber('EASY_MODE_CARGO_HEAVY_MULTIPLIER_PERCENT', 108) / 100,
    };
  }

  public async waitForRoutesPageReady(timeoutMs = 15000): Promise<boolean> {
    try {
      console.log('Waiting for routes page to be ready...');
      // Look for the "Cost index" header that only appears when the Routes list loads
      await this.page.getByText(/Cost index/i).first().waitFor({ state: 'visible', timeout: timeoutMs });
      return true;
    } catch {
      console.log(`Routes page readiness timed out after ${timeoutMs}ms.`);
      return false;
    }
  }

  public async updateDailyEasyModePrices(): Promise<void> {
    if (!this.enablePricing) {
      console.log('Pricing disabled by ENABLE_PRICING=false; skipping.');
      return;
    }

    if (this.gameMode !== 'easy') {
      console.log(`Dynamic pricing skipped because GAME_MODE is set to ${this.gameMode}.`);
      return;
    }

    console.log('Pre-departure Easy mode ticket-price check started...');
    const runDeadline = Date.now() + this.pricingDeadlineMs;

    // A valid route link in AM4 has a spaced hyphen separating the name and airplane model (e.g. "OO-319-2 - A220-100")
    // This perfectly distinguishes it from pagination numbers like "1" or text like "Next".
    const popupArea = this.page.locator('[role="dialog"], .modal, body').last();
    const routeLinks = popupArea.locator('a, button, [role="link"], [role="button"]').filter({
      hasText: /.+ - .+/i
    });

    const count = await routeLinks.count().catch(() => 0);
    console.log(`Found ${count} eligible route links matching route text pattern.`);

    let updatedFlights = 0;
    let inspectedFlights = 0;

    for (let index = 0; index < count; index++) {
      if (updatedFlights >= this.maxPriceUpdatesPerRun) {
        console.log(`Reached max price updates per run: ${this.maxPriceUpdatesPerRun}`);
        break;
      }
      if (Date.now() > runDeadline) {
        console.log(`Pricing deadline reached (${this.pricingDeadlineMs}ms); stopping further updates.`);
        break;
      }

      const link = routeLinks.nth(index);
      if (!(await link.isVisible().catch(() => false))) continue;

      const linkText = await link.innerText().catch(() => '');
      // Ensure we explicitly reject pagination
      if (/^(next|prev|previous)$/i.test(linkText) || /^\d+$/.test(linkText)) {
        continue;
      }

      // Check if it's already departed
      // Read parent row text
      const rowText = await link.evaluate((el: HTMLElement) => {
        let curr: HTMLElement | null = el.parentElement;
        for (let i = 0; i < 4 && curr; i++) {
          if (curr.innerText && curr.innerText.match(/depart|demand/i)) {
            return curr.innerText.toLowerCase();
          }
          curr = curr.parentElement;
        }
        return '';
      }).catch(() => '');

      if (rowText.includes('departed') || rowText.includes('airborne') || rowText.includes('arrived')) {
        continue;
      }

      inspectedFlights++;
      console.log(`Route row selected [${inspectedFlights}]: ${linkText}`);

      // Click the route to open details
      try {
        await link.click();
      } catch (e) {
        continue;
      }

      // Wait for seat layout or auto button
      const seatLayoutHeader = this.page.getByText(/seat layout/i).first();
      const autoButton = this.page.getByRole('button', { name: /^auto$/i }).first();
      
      try {
        await Promise.any([
          seatLayoutHeader.waitFor({ state: 'visible', timeout: 5000 }),
          autoButton.waitFor({ state: 'visible', timeout: 5000 })
        ]);
      } catch {
        console.log(`Details did not open cleanly for route: ${linkText}`);
        await this.page.goBack().catch(() => undefined);
        await this.page.waitForTimeout(1000);
        continue;
      }

      // Expand seat layout if necessary
      if (await seatLayoutHeader.isVisible().catch(() => false) && !(await autoButton.isVisible().catch(() => false))) {
        await seatLayoutHeader.click().catch(() => {});
        await this.page.waitForTimeout(500);
      }

      if (!(await autoButton.isVisible().catch(() => false))) {
        await this.page.goBack().catch(() => undefined);
        await this.page.waitForTimeout(1000);
        continue;
      }

      // Click Auto
      await autoButton.click();
      // Wait for inputs to populate
      await this.page.waitForTimeout(1000);

      const passengerFareConfigs = [
        { key: 'economy', multiplier: this.multipliers.economy },
        { key: 'business', multiplier: this.multipliers.business },
        { key: 'first', multiplier: this.multipliers.first },
        { key: 'large', multiplier: this.multipliers.cargoLarge },
        { key: 'heavy', multiplier: this.multipliers.cargoHeavy },
      ];

      let changedAnyPrice = false;

      // Update inputs
      for (const config of passengerFareConfigs) {
        // Since there is no visible text label (only SVGs of seats), we lookup by name, id, or placeholder.
        const inputLocator = this.page.locator(`input:visible[name*="${config.key}" i], input:visible[id*="${config.key}" i], input:visible[placeholder*="${config.key}" i]`).first();

        try {
          if (await inputLocator.isVisible()) {
            const currentValueStr = await inputLocator.inputValue();
            const currentValue = parseInt(currentValueStr.replace(/,/g, '').trim(), 10);
            
            if (currentValue > 0) {
              const nextValue = Math.max(1, Math.floor((currentValue * config.multiplier) / 10) * 10);
              if (nextValue !== currentValue) {
                await inputLocator.click();
                await inputLocator.press('Control+a');
                await inputLocator.fill(nextValue.toString());
                changedAnyPrice = true;
              }
            }
          }
        } catch (e) {
          // Ignore failures for specific fare classes
        }
      }

      if (changedAnyPrice) {
        const saveButton = this.page.getByRole('button', { name: /^save$/i }).first();
        if (await saveButton.isVisible().catch(() => false)) {
          await saveButton.click();
          await this.page.waitForTimeout(500);
          updatedFlights++;
          console.log(`Route updated: ${linkText}`);
        }
      }

      // AM4 uses History states for its modals, so we just 'go back' to return to the flights list
      await this.page.goBack().catch(() => undefined);
      await this.page.waitForTimeout(1000);
    }

    const summary = updatedFlights > 0
      ? `## Dynamic ticket pricing\n- Updated prices for ${updatedFlights} not-yet-departed flights.`
      : `## Dynamic ticket pricing\n- No not-yet-departed flights needed a price update. Inspected ${inspectedFlights} route details pages.`;
    this.appendSummary(summary);
    console.log(`Pre-departure ticket-price check finished. Updated flights: ${updatedFlights}.`);
  }

  private appendSummary(markdown: string): void {
    if (!this.githubStepSummary) {
      return;
    }
    try {
      appendFileSync(this.githubStepSummary, markdown + '\n\n');
    } catch (e) {}
  }
}
