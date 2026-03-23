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

interface RouteDiscoveryMatch {
  container: Locator;
  selector: string;
}

interface FareUpdateResult {
  label: string;
  autoBaseline: number;
  finalValue: number;
  changed: boolean;
}

export class PricingUtils {
  private readonly page: Page;
  private readonly githubStepSummary?: string;
  private readonly maxPriceUpdatesPerRun: number;
  private readonly maxRouteDiscoveryAttemptsPerRun: number;
  private readonly gameMode: string;
  private readonly multipliers: PriceMultipliers;

  constructor(page: Page) {
    this.page = page;
    this.githubStepSummary = process.env.GITHUB_STEP_SUMMARY;
    this.maxPriceUpdatesPerRun = ConfigUtils.optionalNumber('MAX_PRICE_UPDATES_PER_RUN', 12);
    this.maxRouteDiscoveryAttemptsPerRun = ConfigUtils.optionalNumber(
      'MAX_ROUTE_DISCOVERY_ATTEMPTS_PER_RUN',
      Math.max(3, Math.min(this.maxPriceUpdatesPerRun, 6)),
    );
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
    console.log(`Route discovery attempt cap for this run: ${this.maxRouteDiscoveryAttemptsPerRun}. Price update cap: ${this.maxPriceUpdatesPerRun}.`);

    const routeLinks = await this.findPriceButtons();
    console.log(`Found ${routeLinks.length} eligible route links on the routes page.`);
    let updatedFlights = 0;
    let inspectedFlights = 0;

    for (const routeLink of routeLinks.slice(0, this.maxRouteDiscoveryAttemptsPerRun)) {
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
    if (routeRows.length === 0) {
      console.log('findPriceButtons aborted because scoped route discovery found no valid route rows.');
      return [];
    }

    const routeLinks: Locator[] = [];

    for (let index = 0; index < routeRows.length; index++) {
      const row = routeRows[index];
      const rowText = await this.getRouteRowText(row);
      if (!rowText) {
        console.log(`findPriceButtons skipped row ${index + 1} because readRowText returned no meaningful text.`);
        continue;
      }

      const routeLink = await this.findRouteLinkInRow(row);
      if (!routeLink) {
        console.log(`findPriceButtons skipped row ${index + 1} because no visible route details link was found: ${rowText.slice(0, 200)}`);
        continue;
      }

      const linkText = ((await routeLink.innerText().catch(() => '')) || (await routeLink.textContent().catch(() => '')) || '').replace(/\s+/g, ' ').trim();

      routeLinks.push(routeLink);
      console.log(`findPriceButtons row ${index + 1} route link: ${linkText || rowText.slice(0, 120)}`);
    }

    console.log(`findPriceButtons collected ${routeLinks.length} visible route links from ${routeRows.length} route rows.`);
    return routeLinks;
  }

  private async findRouteRows(): Promise<Locator[]> {
    const routesModal = this.page.locator(
      '[role="dialog"]:has-text("ROUTES"), .modal:has-text("ROUTES"), #popup:has-text("ROUTES"), body',
    ).first();
    const routeListMatch = await this.findRouteListContainer(routesModal);
    if (!routeListMatch) {
      console.log('findRouteRows aborted because no scoped route-list container was found inside the ROUTES modal.');
      return [];
    }

    const routeRows: Locator[] = [];
    const candidateSelectors = [
      ':scope > tr',
      ':scope > tbody > tr',
      ':scope > li',
      ':scope > [role="row"]',
      ':scope > .list-group-item',
      ':scope > [class*="route" i]',
      ':scope > [class*="flight" i]',
      ':scope > div:has-text("#ST-"):has-text("Depart")',
      ':scope > *:has(a:has-text("Depart"))',
    ];
    const seenRows = new Set<string>();
    let selectorFamiliesExamined = 0;

    for (const selector of candidateSelectors) {
      if (selectorFamiliesExamined >= this.maxRouteDiscoveryAttemptsPerRun) {
        console.log(`findRouteRows stopped after ${selectorFamiliesExamined} selector families due to discovery cap ${this.maxRouteDiscoveryAttemptsPerRun}.`);
        break;
      }

      selectorFamiliesExamined += 1;
      const rows = routeListMatch.container.locator(selector);
      const rowCount = await rows.count().catch(() => 0);
      if (rowCount === 0) {
        continue;
      }

      for (let index = 0; index < rowCount; index++) {
        const row = rows.nth(index);
        if (!(await row.isVisible().catch(() => false))) {
          continue;
        }

        if (!(await this.isLikelyRouteRow(row))) {
          continue;
        }

        const rowText = await this.getRouteRowText(row);
        const routeLink = await this.findRouteLinkInRow(row);
        if (!routeLink) {
          continue;
        }

        const departButton = row.getByRole('button', { name: /depart/i }).first();
        const departLink = row.getByRole('link', { name: /depart/i }).first();
        const hasRouteNumber = /#ST-\d{3,}/i.test(rowText);
        const hasRoutePattern = /[A-Z]{3}\s*-\s*[A-Z]{3}\s*-\s*[A-Z0-9]/i.test(rowText);
        const hasDepartButton = await departButton.isVisible().catch(() => false) || await departLink.isVisible().catch(() => false);
        const signalCount = [hasRouteNumber, hasRoutePattern, hasDepartButton, true].filter(Boolean).length;

        if (signalCount < 3) {
          continue;
        }

        const dedupeKey = `${rowText}::${await routeLink.getAttribute('href').catch(() => '')}`;
        if (seenRows.has(dedupeKey)) {
          continue;
        }

        seenRows.add(dedupeKey);
        routeRows.push(row);
      }

      if (routeRows.length > 0) {
        break;
      }
    }

    if (routeRows.length === 0) {
      console.log(`findRouteRows found container via "${routeListMatch.selector}" but no valid route rows after ${selectorFamiliesExamined} selector families; skipping pricing discovery.`);
      return [];
    }

    const rowSamples = await Promise.all(routeRows.slice(0, 3).map(row => this.getRouteRowText(row)));
    console.log(`findRouteRows identified ${routeRows.length} valid route rows in the ROUTES modal via "${routeListMatch.selector}" after ${selectorFamiliesExamined} selector families. Samples: ${rowSamples.map(sample => sample.slice(0, 120) || '[no row text found]').join(' | ')}`);
    return routeRows;
  }

  private async findRouteListContainer(routesModal: Locator): Promise<RouteDiscoveryMatch | undefined> {
    const scopedSelectors = [
      ':scope >> [role="tabpanel"]:has-text("260 ROUTES")',
      ':scope >> [role="tabpanel"]:has-text("263 ROUTES")',
      ':scope >> .tab-pane:has-text("260 ROUTES")',
      ':scope >> .tab-pane:has-text("263 ROUTES")',
      ':scope >> *:has-text("Cost index"):has-text("Depart")',
      ':scope >> *:has-text("#ST-"):has-text("Depart")',
    ];
    let selectorsExamined = 0;

    for (const selector of scopedSelectors) {
      if (selectorsExamined >= this.maxRouteDiscoveryAttemptsPerRun) {
        console.log(`findRouteListContainer stopped after ${selectorsExamined} selectors due to discovery cap ${this.maxRouteDiscoveryAttemptsPerRun}.`);
        break;
      }

      selectorsExamined += 1;
      const container = routesModal.locator(selector).first();
      if (!(await container.isVisible().catch(() => false))) {
        continue;
      }

      const containerText = await this.getRouteRowText(container);
      const hasRoutesAnchor = /\b\d+\s+ROUTES\b/i.test(containerText);
      const hasHeaderAnchor = /Cost index/i.test(containerText) && /Depart/i.test(containerText);
      const hasEntryAnchor = /#ST-\d{3,}/i.test(containerText) && /[A-Z]{3}\s*-\s*[A-Z]{3}\s*-\s*[A-Z0-9]/i.test(containerText);
      if (hasRoutesAnchor || hasHeaderAnchor || hasEntryAnchor) {
        console.log(`findRouteRows scoped route-list container selected via "${selector}" after ${selectorsExamined} selector checks.`);
        return { container, selector };
      }
    }

    return undefined;
  }

  private async isLikelyRouteRow(row: Locator): Promise<boolean> {
    const quickSignals = await Promise.all([
      row.locator('a').count().catch(() => 0),
      row.getByRole('button', { name: /depart/i }).count().catch(() => 0),
      row.getByRole('link', { name: /depart/i }).count().catch(() => 0),
    ]);

    if (quickSignals.every(count => count === 0)) {
      return false;
    }

    const rowText = await this.getRouteRowText(row);
    if (!rowText) {
      return false;
    }

    return /#ST-\d{3,}/i.test(rowText) || /[A-Z]{3}\s*-\s*[A-Z]{3}\s*-\s*[A-Z0-9]/i.test(rowText) || /depart/i.test(rowText);
  }

  private async findRouteLinkInRow(row: Locator): Promise<Locator | undefined> {
    const routeLink = row.locator(
      'a.text-info, a.text-primary, a.font-blue, a[style*="color: blue" i], a[href*="route" i], a',
    ).filter({ hasText: /[A-Z]{3}\s*-\s*[A-Z]{3}\s*-\s*[A-Z0-9]/i }).first();

    if (await routeLink.isVisible().catch(() => false)) {
      return routeLink;
    }

    return undefined;
  }

  private async getRouteRowText(row: Locator): Promise<string> {
    return (await row.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
  }

  private async readRowText(routeLink: Locator): Promise<string> {
    const row = await this.findClosestRouteRow(routeLink);
    const rowText = await this.getRouteRowText(row);
    return rowText ? rowText.toLowerCase() : '';
  }

  private async findClosestRouteRow(routeLink: Locator): Promise<Locator> {
    const rowAncestors = [
      'xpath=ancestor::*[self::tr or self::li or self::div][.//button[contains(translate(normalize-space(.), "DEPART", "depart"), "depart")]][1]',
      'xpath=ancestor::*[self::tr or self::li or self::div][.//*[contains(normalize-space(.), "#ST-")]][1]',
      'xpath=ancestor::*[self::tr or self::li or self::div][1]',
    ];

    for (const selector of rowAncestors) {
      const row = routeLink.locator(selector).first();
      if (await row.isVisible().catch(() => false)) {
        return row;
      }
    }

    return routeLink;
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
    const visibleFareInputs = await this.countVisibleFareInputs();
    console.log(`fare inputs found for route ${controlIndex}: ${visibleFareInputs}`);

    const autoApplied = await this.applyAutoPricing(controlIndex);
    if (!autoApplied) {
      console.log(`Pricing control ${controlIndex} opened, but the Auto baseline could not be confirmed.`);
      return false;
    }

    const results: FareUpdateResult[] = [];
    const passengerFareConfigs = [
      { label: 'Economy', pattern: /economy|eco|\by\b/i, multiplier: this.multipliers.economy },
      { label: 'Business', pattern: /business|bus|\bj\b/i, multiplier: this.multipliers.business },
      { label: 'First', pattern: /first|\bf\b/i, multiplier: this.multipliers.first },
    ];

    for (const config of passengerFareConfigs) {
      const result = await this.tryUpdatePriceInput(config.label, config.pattern, config.multiplier);
      if (result) {
        results.push(result);
      }
    }

    if (results.length === 0) {
      console.log(`Pricing control ${controlIndex} opened, but no visible passenger fare inputs were available after Auto.`);
      return false;
    }

    for (const result of results) {
      console.log(`route ${controlIndex} ${result.label}: Auto baseline ${result.autoBaseline} -> final ${result.finalValue}${result.changed ? '' : ' (unchanged)'}`);
    }

    const updated = results.some(result => result.changed);
    if (updated) {
      const saveButton = this.page.getByRole('button', { name: /^save$/i }).first();
      if (await saveButton.isVisible().catch(() => false)) {
        await saveButton.click();
        await this.page.waitForTimeout(500);
        console.log(`save clicked for route ${controlIndex}.`);
      } else {
        console.log(`route ${controlIndex} fares changed, but no Save button was visible.`);
      }
    } else {
      console.log(`route ${controlIndex} Auto-based fare targets already matched the visible values; Save was not clicked.`);
    }

    return updated;
  }

  private async applyAutoPricing(controlIndex: number): Promise<boolean> {
    const fareInputsBeforeAuto = await this.captureVisibleFareSnapshot();
    const autoButton = this.page.getByRole('button', { name: /^auto$/i }).first();
    if (!(await autoButton.isVisible().catch(() => false))) {
      console.log(`route ${controlIndex} has no visible Auto button in the seat layout.`);
      return false;
    }

    await autoButton.click();
    const autoApplied = await this.waitForAutoFarePopulation(fareInputsBeforeAuto);
    if (autoApplied) {
      console.log(`route ${controlIndex} Auto pricing baseline captured.`);
    } else {
      console.log(`route ${controlIndex} Auto pricing click did not produce a confirmed fare update.`);
    }

    return autoApplied;
  }

  private async tryUpdatePriceInput(label: string, labelPattern: RegExp, multiplier: number): Promise<FareUpdateResult | undefined> {
    const input = await this.findInputByLabel(labelPattern);
    if (!input) {
      return undefined;
    }

    const currentValue = await this.readNumericInputValue(input);
    if (!currentValue || currentValue <= 0) {
      return undefined;
    }

    const nextValue = Math.max(1, Math.floor((currentValue * multiplier) / 10) * 10);
    const changed = nextValue !== currentValue;

    if (changed) {
      await input.click();
      await input.press('Control+a');
      await input.fill(nextValue.toString());
      await input.press('Tab').catch(() => undefined);
    }

    return {
      label,
      autoBaseline: currentValue,
      finalValue: nextValue,
      changed,
    };
  }

  private async waitForAutoFarePopulation(previousSnapshot: Map<string, number>, timeoutMs = 5000): Promise<boolean> {
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;

    while (Date.now() < deadline) {
      const currentSnapshot = await this.captureVisibleFareSnapshot();
      if (currentSnapshot.size > 0) {
        const elapsedMs = Date.now() - startedAt;
        const hasChangedValue = Array.from(currentSnapshot.entries()).some(([key, value]) => previousSnapshot.get(key) !== value);
        const hasPopulatedValue = Array.from(currentSnapshot.values()).some(value => value > 0);
        const faresAppearedAfterAuto = previousSnapshot.size === 0 && hasPopulatedValue;
        const faresStayedStableAfterAuto = previousSnapshot.size > 0 && hasPopulatedValue && elapsedMs >= 800;

        if (hasChangedValue || faresAppearedAfterAuto || faresStayedStableAfterAuto) {
          return true;
        }
      }

      await this.page.waitForTimeout(200);
    }

    return false;
  }

  private async captureVisibleFareSnapshot(): Promise<Map<string, number>> {
    const snapshot = new Map<string, number>();
    const selectors = [
      /economy|eco|\by\b/i,
      /business|bus|\bj\b/i,
      /first|\bf\b/i,
      /large|cargo large|\bl\b/i,
      /heavy|cargo heavy|\bh\b/i,
    ];

    for (const selector of selectors) {
      const input = await this.findInputByLabel(selector);
      if (!input) {
        continue;
      }

      const key = await this.describeInput(input);
      const value = await this.readNumericInputValue(input);
      snapshot.set(key, value);
    }

    return snapshot;
  }

  private async describeInput(input: Locator): Promise<string> {
    const [name, id, placeholder, ariaLabel] = await Promise.all([
      input.getAttribute('name').catch(() => ''),
      input.getAttribute('id').catch(() => ''),
      input.getAttribute('placeholder').catch(() => ''),
      input.getAttribute('aria-label').catch(() => ''),
    ]);

    return [name, id, placeholder, ariaLabel].filter(Boolean).join('|') || `input-${await input.evaluate(el => (el as HTMLInputElement).type || 'text').catch(() => 'unknown')}`;
  }

  private async readNumericInputValue(input: Locator): Promise<number> {
    const currentValue = await input.inputValue().catch(() => '');
    const normalizedValue = currentValue.replace(/,/g, '').trim();
    const parsedCurrentValue = Number.parseInt(normalizedValue, 10);
    return Number.isNaN(parsedCurrentValue) ? 0 : parsedCurrentValue;
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
