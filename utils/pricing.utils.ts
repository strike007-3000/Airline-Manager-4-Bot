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

interface RoutesReadySignal {
  description: string;
  isSatisfied: () => Promise<boolean>;
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

  public async waitForRoutesPageReady(timeoutMs = 5000): Promise<boolean> {
    const readySignals: RoutesReadySignal[] = [
      {
        description: 'routes table has data rows beyond the header',
        isSatisfied: async () => {
          const tableRows = this.page.locator('table tr');
          const rowCount = await tableRows.count().catch(() => 0);
          if (rowCount < 2) {
            return false;
          }

          for (let index = 1; index < rowCount; index++) {
            const row = tableRows.nth(index);
            if (!(await row.isVisible().catch(() => false))) {
              continue;
            }

            const rowText = (await row.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
            if (rowText.length > 0) {
              return true;
            }
          }

          return false;
        },
      },
      {
        description: 'routes summary text is visible with route details',
        isSatisfied: async () => {
          const mainArea = this.page.locator('main, #main, #content, .content, body').first();
          const mainAreaText = (await mainArea.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
          return mainAreaText.includes('Routes (') && (mainAreaText.includes('Cost index') || mainAreaText.includes('Depart'));
        },
      },
      {
        description: 'stable AM4 routes container is visible',
        isSatisfied: async () => {
          const routesContainers = this.page.locator('table, .table-responsive, #routes, [id*="route" i], [class*="route" i]');
          const totalCount = await routesContainers.count().catch(() => 0);
          for (let index = 0; index < totalCount; index++) {
            const container = routesContainers.nth(index);
            if (!(await container.isVisible().catch(() => false))) {
              continue;
            }

            const containerText = (await container.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
            if (containerText.includes('Routes (') || (containerText.includes('Cost index') && containerText.includes('Depart'))) {
              return true;
            }
          }

          return false;
        },
      },
    ];

    const routeContainerSelectors = ['tr', 'text=/Routes \(\d+\)/', 'text=Depart', 'text=Cost index', '.route', '.route-row', '.flight', '.flight-row', '.list-group-item'];
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const routeContainerCounts = await Promise.all(
        routeContainerSelectors.map(async selector => ({
          selector,
          count: await this.page.locator(selector).count().catch(() => 0),
        })),
      );
      console.log(`Routes page readiness probe counts: ${routeContainerCounts.map(({ selector, count }) => `${selector}=${count}`).join(', ')}`);

      for (const signal of readySignals) {
        if (await signal.isSatisfied().catch(() => false)) {
          console.log(`Routes page readiness satisfied: ${signal.description}.`);
          return true;
        }
      }

      await this.page.waitForTimeout(250);
    }

    const mainArea = this.page.locator('main, #main, #content, .content, body').first();
    const mainAreaText = (await mainArea.innerText().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 200);
    console.log(`Routes page readiness timed out after ${timeoutMs}ms; skipping pricing update because no verified routes-page signals appeared.`);
    console.log(`Routes page readiness timeout sample text: ${mainAreaText || '[no visible main area text found]'}`);
    return false;
  }

  public async updateDailyEasyModePrices(): Promise<void> {
    if (this.gameMode !== 'easy') {
      console.log(`Dynamic pricing skipped because GAME_MODE is set to ${this.gameMode}.`);
      return;
    }

    console.log('Pre-departure Easy mode ticket-price check started...');

    const routeLinks = await this.findPriceButtons();
    console.log(`Found ${routeLinks.length} eligible route links on the routes page.`);
    let updatedFlights = 0;
    let inspectedFlights = 0;

    for (const routeLink of routeLinks) {
      if (updatedFlights >= this.maxPriceUpdatesPerRun) {
        break;
      }

      inspectedFlights += 1;
      const rowText = await this.readRowText(routeLink);
      console.log(`route row selected [${inspectedFlights}/${routeLinks.length}]: ${rowText.slice(0, 200) || '[no row text found]'}`);
      if (this.hasFlightAlreadyDeparted(rowText)) {
        console.log(`route skipped [departed status]: ${rowText.slice(0, 200)}`);
        continue;
      }

      const openedRouteDetails = await this.openRouteDetails(routeLink, inspectedFlights);
      if (!openedRouteDetails) {
        console.log(`route skipped [details not opened]: ${rowText.slice(0, 200)}`);
        continue;
      }

      const seatLayoutReady = await this.ensureSeatLayoutExpanded();
      if (!seatLayoutReady) {
        console.log(`route skipped [seat layout unavailable]: ${rowText.slice(0, 200)}`);
        await this.returnToRoutesList();
        continue;
      }

      const changedAnyPrice = await this.updateVisiblePriceInputs(inspectedFlights);
      await this.closePopupIfOpen();
      await this.returnToRoutesList();

      if (changedAnyPrice) {
        updatedFlights += 1;
        console.log(`route updated: ${rowText.slice(0, 200)}`);
      } else {
        console.log(`route skipped [no fare changes made]: ${rowText.slice(0, 200)}`);
      }
    }

    const summary = updatedFlights > 0
      ? `## Dynamic ticket pricing\n- Updated prices for ${updatedFlights} not-yet-departed flights using Easy mode multipliers before departures.`
      : `## Dynamic ticket pricing\n- No not-yet-departed flights needed a price update before departures. Inspected ${inspectedFlights} route details pages.`;
    this.appendSummary(summary);
    console.log(`Pre-departure Easy mode ticket-price check finished. Updated flights: ${updatedFlights}.`);
  }

  private async findPriceButtons(): Promise<Locator[]> {
    const routeRows = await this.findRouteRows();
    const routeLinks: Locator[] = [];

    for (let index = 0; index < routeRows.length; index++) {
      const row = routeRows[index];
      const rowText = (await row.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
      const routeLink = row.locator(
        'a.text-info, a.text-primary, a.font-blue, a[style*="color: blue"], a[href*="route" i], a',
      ).filter({ hasText: /[A-Z]{3}\s*-\s*[A-Z]{3}\s*-/i }).first();

      if (await routeLink.isVisible().catch(() => false)) {
        routeLinks.push(routeLink);
      } else {
        console.log(`findPriceButtons skipped row ${index + 1} because no visible blue route link was found: ${rowText.slice(0, 200) || '[no row text found]'}`);
      }
    }

    console.log(`findPriceButtons collected ${routeLinks.length} visible route links from ${routeRows.length} route rows.`);
    return routeLinks;
  }

  private async findRouteRows(): Promise<Locator[]> {
    const routesModal = this.page.locator(
      '[role="dialog"]:has-text("ROUTES"), .modal:has-text("ROUTES"), #popup:has-text("ROUTES"), body',
    ).first();
    const fleetScope = routesModal.locator(
      ':scope >> [role="tabpanel"]:has-text("FLEET"), :scope >> .tab-pane:has-text("FLEET"), :scope',
    ).first();
    const rows = fleetScope.locator('tr');
    const rowCount = await rows.count().catch(() => 0);
    const routeRows: Locator[] = [];

    for (let index = 0; index < rowCount; index++) {
      const row = rows.nth(index);
      if (!(await row.isVisible().catch(() => false))) {
        continue;
      }

      const rowText = (await row.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
      if (!rowText || !/[A-Z]{3}\s*-\s*[A-Z]{3}/i.test(rowText) || /depart\b/i.test(rowText) && !/-/.test(rowText)) {
        continue;
      }

      routeRows.push(row);
    }

    console.log(`findRouteRows identified ${routeRows.length} visible route rows in the ROUTES modal FLEET tab.`);
    return routeRows;
  }

  private async readRowText(routeLink: Locator): Promise<string> {
    const row = routeLink.locator('xpath=ancestor::tr[1]');
    return (await row.innerText().catch(() => '')).toLowerCase();
  }

  private hasFlightAlreadyDeparted(rowText: string): boolean {
    return rowText.includes('departed') || rowText.includes('airborne') || rowText.includes('arrived');
  }

  private async openRouteDetails(routeLink: Locator, controlIndex: number): Promise<boolean> {
    const linkText = ((await routeLink.innerText().catch(() => '')) || (await routeLink.textContent().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
    await routeLink.click();
    await this.page.waitForTimeout(750);

    const seatLayoutHeader = this.page.getByText(/seat layout/i).first();
    if (await seatLayoutHeader.isVisible().catch(() => false)) {
      console.log(`route details opened [${controlIndex}]: ${linkText || '[no route link text found]'}`);
      return true;
    }

    const saveButton = this.page.getByRole('button', { name: /^save$/i }).first();
    if (await saveButton.isVisible().catch(() => false)) {
      console.log(`route details opened [${controlIndex}] via Save button visibility: ${linkText || '[no route link text found]'}`);
      return true;
    }

    console.log(`route details did not open cleanly [${controlIndex}]: ${linkText || '[no route link text found]'}`);
    return false;
  }

  private async ensureSeatLayoutExpanded(): Promise<boolean> {
    const seatLayoutHeader = this.page.getByText(/seat layout/i).first();
    if (!(await seatLayoutHeader.isVisible().catch(() => false))) {
      return false;
    }

    const visibleInputsBeforeExpand = await this.countVisibleFareInputs();
    if (visibleInputsBeforeExpand > 0) {
      console.log(`seat layout already open; visible fare inputs before expand attempt: ${visibleInputsBeforeExpand}`);
      return true;
    }

    await seatLayoutHeader.click().catch(() => undefined);
    await this.page.waitForTimeout(400);

    const visibleInputsAfterExpand = await this.countVisibleFareInputs();
    if (visibleInputsAfterExpand > 0) {
      console.log(`seat layout expanded; visible fare inputs after expand: ${visibleInputsAfterExpand}`);
      return true;
    }

    console.log('seat layout header was found, but no visible fare inputs appeared after expand attempt.');
    return false;
  }

  private async updateVisiblePriceInputs(controlIndex: number): Promise<boolean> {
    let updated = false;
    const visibleFareInputs = await this.countVisibleFareInputs();
    console.log(`fare inputs found for route ${controlIndex}: ${visibleFareInputs}`);

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
        console.log(`save clicked for route ${controlIndex}.`);
      }
    } else {
      console.log(`Pricing control ${controlIndex} opened, but no visible fare inputs could be updated.`);
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

    const popupInputs = this.page.locator('#popup input:visible, .modal input:visible');
    const popupInputCount = await popupInputs.count().catch(() => 0);
    for (let index = 0; index < popupInputCount; index++) {
      const locator = popupInputs.nth(index);
      const nearbyText = await locator.locator('xpath=ancestor::*[self::div or self::td or self::label][1]').innerText().catch(() => '');
      const descriptor = `${nearbyText} ${await locator.getAttribute('name').catch(() => '')} ${await locator.getAttribute('id').catch(() => '')} ${await locator.getAttribute('placeholder').catch(() => '')}`.toLowerCase();
      if (descriptor && labelPattern.test(descriptor) && await locator.isVisible().catch(() => false)) {
        return locator;
      }
    }

    return undefined;
  }

  private async countVisibleFareInputs(): Promise<number> {
    const fareInputs = this.page.locator(
      'input:visible[placeholder*="Economy" i], input:visible[placeholder*="Business" i], input:visible[placeholder*="First" i], input:visible[placeholder*="Large" i], input:visible[placeholder*="Heavy" i], input:visible[name*="economy" i], input:visible[name*="business" i], input:visible[name*="first" i], input:visible[name*="large" i], input:visible[name*="heavy" i], input:visible[id*="economy" i], input:visible[id*="business" i], input:visible[id*="first" i], input:visible[id*="large" i], input:visible[id*="heavy" i]',
    );
    return fareInputs.count().catch(() => 0);
  }

  private async returnToRoutesList(): Promise<void> {
    await this.page.goBack().catch(() => undefined);
    await this.page.waitForTimeout(750);
    await this.waitForRoutesPageReady().catch(() => false);
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
