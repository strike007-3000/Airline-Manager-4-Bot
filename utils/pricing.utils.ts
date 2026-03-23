import { Locator, Page } from '@playwright/test';
import { appendFileSync } from 'fs';
import { ConfigUtils } from './config.utils';

interface PriceMultipliers {
  economy: number;
  business: number;
  first: number;
  cargoLarge: number;
  cargoHeavy: number;
}

export class PricingUtils {
  private readonly page: Page;
  private readonly githubStepSummary?: string;
  private readonly maxPriceUpdatesPerRun: number;
  private readonly gameMode: string;
  private readonly multipliers: PriceMultipliers;

  constructor(page: Page) {
    this.page = page;
    this.githubStepSummary = process.env.GITHUB_STEP_SUMMARY;
    this.maxPriceUpdatesPerRun = ConfigUtils.optionalNumber('MAX_PRICE_UPDATES_PER_RUN', 12);
    this.gameMode = ConfigUtils.optionalString('GAME_MODE', 'easy').toLowerCase();
    this.multipliers = {
      economy: this.getMultiplierFromPercent('EASY_MODE_ECONOMY_MULTIPLIER_PERCENT', 110),
      business: this.getMultiplierFromPercent('EASY_MODE_BUSINESS_MULTIPLIER_PERCENT', 108),
      first: this.getMultiplierFromPercent('EASY_MODE_FIRST_MULTIPLIER_PERCENT', 106),
      cargoLarge: this.getMultiplierFromPercent('EASY_MODE_CARGO_LARGE_MULTIPLIER_PERCENT', 110),
      cargoHeavy: this.getMultiplierFromPercent('EASY_MODE_CARGO_HEAVY_MULTIPLIER_PERCENT', 108),
    };
  }

  public async updateDailyEasyModePrices(): Promise<void> {
    if (this.gameMode !== 'easy') {
      console.log(`Dynamic pricing skipped because GAME_MODE is set to ${this.gameMode}.`);
      return;
    }

    console.log('Pre-departure Easy mode ticket-price check started...');

    const priceButtons = await this.findPriceButtons();
    let updatedFlights = 0;

    for (const button of priceButtons) {
      if (updatedFlights >= this.maxPriceUpdatesPerRun) {
        break;
      }

      const rowText = await this.readRowText(button);
      if (this.hasFlightAlreadyDeparted(rowText)) {
        continue;
      }

      await button.click();
      await this.page.waitForTimeout(500);

      const changedAnyPrice = await this.updateVisiblePriceInputs();
      await this.closePopupIfOpen();

      if (changedAnyPrice) {
        updatedFlights += 1;
      }
    }

    const summary = updatedFlights > 0
      ? `## Dynamic ticket pricing\n- Updated prices for ${updatedFlights} not-yet-departed flights using Easy mode multipliers before departures.`
      : '## Dynamic ticket pricing\n- No not-yet-departed flights needed a price update before departures.';

    this.appendSummary(summary);
    console.log(`Pre-departure Easy mode ticket-price check finished. Updated flights: ${updatedFlights}.`);
  }

  private async findPriceButtons(): Promise<Locator[]> {
    const selectors = [
      this.page.getByRole('button', { name: /price/i }),
      this.page.getByRole('link', { name: /price/i }),
      this.page.locator('button:has-text("Price"), a:has-text("Price")'),
    ];

    const buttons: Locator[] = [];
    for (const locator of selectors) {
      const count = await locator.count().catch(() => 0);
      for (let index = 0; index < count; index++) {
        const item = locator.nth(index);
        if (await item.isVisible().catch(() => false)) {
          buttons.push(item);
        }
      }
    }

    return buttons;
  }

  private async readRowText(button: Locator): Promise<string> {
    const row = button.locator('xpath=ancestor::tr[1]');
    return (await row.innerText().catch(() => '')).toLowerCase();
  }

  private hasFlightAlreadyDeparted(rowText: string): boolean {
    return rowText.includes('departed') || rowText.includes('airborne') || rowText.includes('arrived');
  }

  private async updateVisiblePriceInputs(): Promise<boolean> {
    let updated = false;

    updated = await this.tryUpdatePriceInput(/economy|eco|y/i, this.multipliers.economy) || updated;
    updated = await this.tryUpdatePriceInput(/business|bus|j/i, this.multipliers.business) || updated;
    updated = await this.tryUpdatePriceInput(/first|f/i, this.multipliers.first) || updated;
    updated = await this.tryUpdatePriceInput(/large|cargo large|l/i, this.multipliers.cargoLarge) || updated;
    updated = await this.tryUpdatePriceInput(/heavy|cargo heavy|h/i, this.multipliers.cargoHeavy) || updated;

    if (updated) {
      const saveButton = this.page.getByRole('button', { name: /save|update|apply|confirm/i }).first();
      if (await saveButton.isVisible().catch(() => false)) {
        await saveButton.click();
        await this.page.waitForTimeout(500);
      }
    }

    return updated;
  }

  private async tryUpdatePriceInput(labelPattern: RegExp, multiplier: number): Promise<boolean> {
    const input = await this.findInputByLabel(labelPattern);
    if (!input) {
      return false;
    }

    const currentValue = await input.inputValue().catch(() => '');
    const parsedCurrentValue = Number.parseInt(currentValue.replace(/,/g, ''), 10);
    if (Number.isNaN(parsedCurrentValue) || parsedCurrentValue <= 0) {
      return false;
    }

    const nextValue = Math.max(1, Math.floor(parsedCurrentValue * multiplier));
    if (nextValue === parsedCurrentValue) {
      return false;
    }

    await input.click();
    await input.press('Control+a');
    await input.fill(nextValue.toString());
    return true;
  }

  private async findInputByLabel(labelPattern: RegExp): Promise<Locator | undefined> {
    const direct = this.page.getByLabel(labelPattern).first();
    if (await direct.isVisible().catch(() => false)) {
      return direct;
    }

    const fallbackSelectors = [
      `input[placeholder*="Economy" i], input[name*="economy" i], input[id*="economy" i]`,
      `input[placeholder*="Business" i], input[name*="business" i], input[id*="business" i]`,
      `input[placeholder*="First" i], input[name*="first" i], input[id*="first" i]`,
      `input[placeholder*="Large" i], input[name*="large" i], input[id*="large" i]`,
      `input[placeholder*="Heavy" i], input[name*="heavy" i], input[id*="heavy" i]`
    ];

    for (const selector of fallbackSelectors) {
      const locator = this.page.locator(selector).first();
      const descriptor = `${await locator.getAttribute('name').catch(() => '')} ${await locator.getAttribute('id').catch(() => '')} ${await locator.getAttribute('placeholder').catch(() => '')}`.toLowerCase();
      if (descriptor && labelPattern.test(descriptor) && await locator.isVisible().catch(() => false)) {
        return locator;
      }
    }

    return undefined;
  }

  private async closePopupIfOpen(): Promise<void> {
    const closeButton = this.page.locator('#popup .glyphicons, #popup .close, .modal-header .close').first();
    if (await closeButton.isVisible().catch(() => false)) {
      await closeButton.click();
      await this.page.waitForTimeout(300);
    }
  }

  private appendSummary(markdown: string): void {
    if (!this.githubStepSummary) {
      return;
    }

    appendFileSync(this.githubStepSummary, markdown + '\n\n');
  }

  private getMultiplierFromPercent(name: string, defaultPercent: number): number {
    return ConfigUtils.optionalNumber(name, defaultPercent) / 100;
  }
}
