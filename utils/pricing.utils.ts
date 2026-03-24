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

    const routeLinks = this.page.locator('a:visible, button:visible, [role="link"]:visible, [role="button"]:visible').filter({
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

      await this.waitForRoutesPageReady(5000).catch(() => false);

      const link = routeLinks.nth(index);
      if (!(await link.isVisible().catch(() => false))) {
        continue;
      }

      const linkText = await link.innerText().catch(() => '');
      if (/^(next|prev|previous)$/i.test(linkText) || /^\d+$/.test(linkText)) {
        continue;
      }

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

      try {
        await link.click();
      } catch (e) {
        continue;
      }

      const seatLayoutHeader = this.page.getByText(/seat layout/i).first();
      const autoButton = this.page.getByRole('button', { name: /^auto$/i }).first();
      
      try {
        await Promise.any([
          seatLayoutHeader.waitFor({ state: 'visible', timeout: 5000 }),
          autoButton.waitFor({ state: 'visible', timeout: 5000 })
        ]);
      } catch {
        console.log(`Details did not open cleanly for route: ${linkText}`);
        await this.returnToRoutesList();
        continue;
      }

      if (await seatLayoutHeader.isVisible().catch(() => false) && !(await autoButton.isVisible().catch(() => false))) {
        await seatLayoutHeader.click().catch(() => {});
        await this.page.waitForTimeout(500);
      }

      if (!(await autoButton.isVisible().catch(() => false))) {
        console.log('Auto button not found.');
        await this.returnToRoutesList();
        continue;
      }

      await autoButton.click();
      await this.page.waitForTimeout(1000);

      let changedAnyPrice = false;

      // AM4 uses a strict positional layout: 3 inputs = PAX (Y, J, F), 2 inputs = CARGO (Large, Heavy)
      const visibleInputs = this.page.locator('.modal:visible input[type="text"]:visible, .modal:visible input:not([type]):visible');
      const inputCount = await visibleInputs.count().catch(() => 0);

      if (inputCount === 3) {
        const changedY = await this.updateAmount(visibleInputs.nth(0), this.multipliers.economy);
        const changedJ = await this.updateAmount(visibleInputs.nth(1), this.businessMultiplierCheck(this.multipliers.business));
        const changedF = await this.updateAmount(visibleInputs.nth(2), this.firstMultiplierCheck(this.multipliers.first));
        changedAnyPrice = changedY || changedJ || changedF;
      } else if (inputCount === 2) {
        const changedL = await this.updateAmount(visibleInputs.nth(0), this.multipliers.cargoLarge);
        const changedH = await this.updateAmount(visibleInputs.nth(1), this.multipliers.cargoHeavy);
        changedAnyPrice = changedL || changedH;
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

      await this.returnToRoutesList();
    }

    const summary = updatedFlights > 0
      ? `## Dynamic ticket pricing\n- Updated prices for ${updatedFlights} not-yet-departed flights.`
      : `## Dynamic ticket pricing\n- No not-yet-departed flights needed a price update. Inspected ${inspectedFlights} route details pages.`;
    this.appendSummary(summary);
    console.log(`Pre-departure ticket-price check finished. Updated flights: ${updatedFlights}.`);
  }

  private async updateAmount(input: Locator, multiplier: number): Promise<boolean> {
    try {
      const currentValueStr = await input.inputValue();
      const currentValue = parseInt(currentValueStr.replace(/,/g, '').trim(), 10);
      if (currentValue > 0) {
        const nextValue = Math.max(1, Math.floor((currentValue * multiplier) / 10) * 10);
        if (nextValue !== currentValue) {
          await input.click();
          await input.press('Control+a');
          await input.fill(nextValue.toString());
          return true;
        }
      }
    } catch {}
    return false;
  }

  private businessMultiplierCheck(val: number) { return val; }
  private firstMultiplierCheck(val: number) { return val; }

  private async returnToRoutesList(): Promise<void> {
    // Navigate out of the seat-layout modal cleanly
    const backBtn = this.page.locator('.modal-header, .box-header').locator('span, i, div, a, button').filter({ hasText: /^</ }).first();
    if (await backBtn.isVisible().catch(() => false)) {
      await backBtn.click();
      await this.page.waitForTimeout(1000);
    } else {
      const textBackBtn = this.page.getByText(/<\s*[A-Z0-9-]{3,}/i).first();
      if (await textBackBtn.isVisible().catch(() => false)) {
        await textBackBtn.click();
        await this.page.waitForTimeout(1000);
      } else {
        await this.page.locator('.modal-header .close, .box-header .close').first().click().catch(() => undefined);
        await this.page.waitForTimeout(1000);
        const mapRoutes = this.page.locator('#mapRoutes').getByRole('img').first();
        if (await mapRoutes.isVisible().catch(() => false)) {
          await mapRoutes.click();
        }
      }
    }
  }

  private appendSummary(markdown: string): void {
    if (!this.githubStepSummary) return;
    try {
      appendFileSync(this.githubStepSummary, markdown + '\n\n');
    } catch {}
  }
}
