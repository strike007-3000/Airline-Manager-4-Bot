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

interface PricingEditorState {
  fareInputsVisible: number;
  autoButton: Locator;
  saveButton: Locator;
}

interface RouteEntrySelectorFamily {
  label: string;
  selector: string;
}

export class PricingUtils {
  private readonly page: Page;
  private readonly githubStepSummary?: string;
  private readonly maxPriceUpdatesPerRun: number;
  private readonly maxRouteDiscoveryAttemptsPerRun: number;
  private readonly pricingDeadlineMs: number;
  private readonly gameMode: string;
  private readonly multipliers: PriceMultipliers;
  private routeListDiagnosticsLogged = false;

  constructor(page: Page) {
    this.page = page;
    this.githubStepSummary = process.env.GITHUB_STEP_SUMMARY;
    this.maxPriceUpdatesPerRun = ConfigUtils.optionalNumber('MAX_PRICE_UPDATES_PER_RUN', 12);
    this.maxRouteDiscoveryAttemptsPerRun = ConfigUtils.optionalNumber(
      'MAX_ROUTE_DISCOVERY_ATTEMPTS_PER_RUN',
      Math.max(3, Math.min(this.maxPriceUpdatesPerRun, 6)),
    );
    this.pricingDeadlineMs = ConfigUtils.optionalNumber('PRICING_DEADLINE_MS', 15000);
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
    const runStartedAt = Date.now();
    const runDeadline = runStartedAt + this.pricingDeadlineMs;
    console.log(`Pricing deadline budget: ${this.pricingDeadlineMs}ms.`);

    let routeLinks: Locator[] = [];
    try {
      routeLinks = await this.findPriceButtons();
    } catch (error) {
      console.warn('Pricing discovery failed; skipping pricing update and continuing.', error);
      this.appendSummary('## Dynamic ticket pricing\n- Skipped pricing update because route discovery failed.');
      return;
    }

    if (this.isDeadlineExceeded(runDeadline)) {
      console.warn(`Pricing deadline reached (${this.pricingDeadlineMs}ms) before route processing started; skipping pricing update.`);
      this.appendSummary('## Dynamic ticket pricing\n- Skipped pricing update because pricing deadline was reached before route processing.');
      return;
    }

    console.log(`Found ${routeLinks.length} eligible route links on the routes page.`);
    let updatedFlights = 0;
    let inspectedFlights = 0;
    let pricingStoppedByDeadline = false;

    for (const routeLink of routeLinks.slice(0, this.maxRouteDiscoveryAttemptsPerRun)) {
      if (updatedFlights >= this.maxPriceUpdatesPerRun) {
        break;
      }
      if (this.isDeadlineExceeded(runDeadline)) {
        pricingStoppedByDeadline = true;
        console.log(`Pricing deadline reached after inspecting ${inspectedFlights} routes; stopping further pricing updates.`);
        break;
      }

      inspectedFlights += 1;
      const rowText = await this.readRowText(routeLink);
      console.log(`route row selected [${inspectedFlights}/${routeLinks.length}]: ${rowText.slice(0, 200) || '[no row text found]'}`);
      if (this.hasFlightAlreadyDeparted(rowText)) {
        console.log(`route skipped [departed status]: ${rowText.slice(0, 200)}`);
        continue;
      }

      const openedRouteDetails = await this.openRouteDetails(routeLink, inspectedFlights, runDeadline);
      if (!openedRouteDetails) {
        console.log(`route skipped [details not opened]: ${rowText.slice(0, 200)}`);
        if (this.isDeadlineExceeded(runDeadline)) {
          pricingStoppedByDeadline = true;
          break;
        }
        continue;
      }

      const seatLayoutReady = await this.ensureSeatLayoutExpanded(runDeadline);
      if (!seatLayoutReady) {
        console.log(`route skipped [seat layout unavailable]: ${rowText.slice(0, 200)}`);
        await this.returnToRoutesList(runDeadline);
        if (this.isDeadlineExceeded(runDeadline)) {
          pricingStoppedByDeadline = true;
          break;
        }
        continue;
      }

      const changedAnyPrice = await this.updateVisiblePriceInputs(inspectedFlights, rowText, runDeadline);
      await this.closePopupIfOpen();
      await this.returnToRoutesList(runDeadline);
      if (this.isDeadlineExceeded(runDeadline)) {
        pricingStoppedByDeadline = true;
      }

      if (changedAnyPrice) {
        updatedFlights += 1;
        console.log(`route updated: ${rowText.slice(0, 200)}`);
      } else {
        console.log(`route skipped [no fare changes made]: ${rowText.slice(0, 200)}`);
      }
    }

    const summary = pricingStoppedByDeadline
      ? `## Dynamic ticket pricing\n- Pricing deadline reached after ${inspectedFlights} route inspections; updated ${updatedFlights} flights before exit.`
      : updatedFlights > 0
      ? `## Dynamic ticket pricing\n- Updated prices for ${updatedFlights} not-yet-departed flights using Easy mode multipliers before departures.`
      : `## Dynamic ticket pricing\n- No not-yet-departed flights needed a price update before departures. Inspected ${inspectedFlights} route details pages.`;
    this.appendSummary(summary);
    console.log(`Pre-departure Easy mode ticket-price check finished. Updated flights: ${updatedFlights}.`);
  }

  private async findPriceButtons(): Promise<Locator[]> {
    const routesModal = this.page.locator(
      '[role="dialog"]:has-text("ROUTES"), .modal:has-text("ROUTES"), #popup:has-text("ROUTES"), body',
    ).first();
    const routeListMatch = await this.findRouteListContainer(routesModal);
    if (!routeListMatch) {
      console.log('findPriceButtons aborted because no scoped route-list container was found inside the ROUTES modal.');
      return [];
    }

    const directRouteLinks = await this.findRouteLinksInContainer(routeListMatch.container, routeListMatch.selector);
    if (directRouteLinks.length > 0) {
      console.log(`findPriceButtons collected ${directRouteLinks.length} visible route links directly from scoped container "${routeListMatch.selector}".`);
      return directRouteLinks;
    }

    if (!this.routeListDiagnosticsLogged) {
      await this.logScopedRouteListDiagnostics(routeListMatch.container, routeListMatch.selector);
      this.routeListDiagnosticsLogged = true;
    }

    console.log('findPriceButtons skipping pricing quickly because no suitable clickable route entry was found in the scoped route-list container.');
    return [];
  }

  private async findRouteRows(routeListMatch?: RouteDiscoveryMatch): Promise<Locator[]> {
    const scopedRouteListMatch = routeListMatch ?? await this.findRouteListContainer(
      this.page.locator(
        '[role="dialog"]:has-text("ROUTES"), .modal:has-text("ROUTES"), #popup:has-text("ROUTES"), body',
      ).first(),
    );
    if (!scopedRouteListMatch) {
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
      ':scope > div:has-text("#ST-")',
      ':scope > *:has(a, button, [role="link"], [role="button"], [onclick])',
    ];
    const seenRows = new Set<string>();
    let selectorFamiliesExamined = 0;

    for (const selector of candidateSelectors) {
      if (selectorFamiliesExamined >= this.maxRouteDiscoveryAttemptsPerRun) {
        console.log(`findRouteRows stopped after ${selectorFamiliesExamined} selector families due to discovery cap ${this.maxRouteDiscoveryAttemptsPerRun}.`);
        break;
      }

      selectorFamiliesExamined += 1;
      const rows = scopedRouteListMatch.container.locator(selector);
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

        const hasRouteNumber = /#ST-\d{3,}/i.test(rowText);
        const hasRoutePattern = /[A-Z]{3}\s*-\s*[A-Z]{3}\s*-\s*[A-Z0-9]/i.test(rowText);

        if (!hasRouteNumber && !hasRoutePattern) {
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
      console.log(`findRouteRows found container via "${scopedRouteListMatch.selector}" but no valid route rows after ${selectorFamiliesExamined} selector families; skipping pricing discovery.`);
      return [];
    }

    const rowSamples = await Promise.all(routeRows.slice(0, 3).map(row => this.getRouteRowText(row)));
    console.log(`findRouteRows identified ${routeRows.length} valid route rows in the ROUTES modal via "${scopedRouteListMatch.selector}" after ${selectorFamiliesExamined} selector families. Samples: ${rowSamples.map(sample => sample.slice(0, 120) || '[no row text found]').join(' | ')}`);
    return routeRows;
  }


  private async findRouteLinksInContainer(container: Locator, containerSelector: string): Promise<Locator[]> {
    const routeEntrySelectorFamily = await this.selectRouteEntrySelectorFamily(container, containerSelector);
    if (!routeEntrySelectorFamily) {
      if (!this.routeListDiagnosticsLogged) {
        await this.logScopedRouteListDiagnostics(container, containerSelector);
        this.routeListDiagnosticsLogged = true;
      }

      console.log(`findRouteLinksInContainer found no suitable clickable selector family inside "${containerSelector}"; pricing will be skipped for this route list.`);
      return [];
    }

    const candidateSelectors = [routeEntrySelectorFamily.selector];
    const routeLinks: Locator[] = [];
    const seenLinks = new Set<string>();
    let selectorFamiliesExamined = 0;

    for (const selector of candidateSelectors) {
      if (selectorFamiliesExamined >= this.maxRouteDiscoveryAttemptsPerRun) {
        console.log(`findRouteLinksInContainer stopped after ${selectorFamiliesExamined} selector families due to discovery cap ${this.maxRouteDiscoveryAttemptsPerRun}.`);
        break;
      }

      selectorFamiliesExamined += 1;
      const candidates = container.locator(selector);
      const candidateCount = await candidates.count().catch(() => 0);
      if (candidateCount === 0) {
        continue;
      }

      for (let index = 0; index < candidateCount; index++) {
        const candidate = candidates.nth(index);
        if (!(await candidate.isVisible().catch(() => false))) {
          continue;
        }

        const linkText = await this.readVisibleText(candidate);
        if (!this.isLikelyRouteLinkText(linkText)) {
          const sampleText = await this.getContainerTextSample(candidate);
          const hasDepartAnchor = /\bdepart\b/i.test(sampleText);
          const hasRouteNumber = /#ST-\d{3,}/i.test(sampleText);
          const looksBlueLink = await this.isLinkStyledCandidate(candidate);
          if (!looksBlueLink || !hasDepartAnchor || !hasRouteNumber) {
            continue;
          }
        }

        const dedupeKey = [linkText, await candidate.getAttribute('href').catch(() => ''), await candidate.evaluate(el => String((el as { outerHTML?: string }).outerHTML ?? '').slice(0, 160)).catch(() => '')].join('::');
        if (seenLinks.has(dedupeKey)) {
          continue;
        }

        seenLinks.add(dedupeKey);
        const containerSample = await this.getContainerTextSample(candidate);
        const rowText = await this.readRowText(candidate);
        routeLinks.push(candidate);
        console.log(`findRouteLinksInContainer accepted route link ${routeLinks.length} from "${containerSelector}": text="${linkText || '[no visible text found]'}", parentSample="${containerSample}", rowText="${rowText.slice(0, 200) || '[no row text found]'}"`);
      }

      if (routeLinks.length > 0) {
        break;
      }
    }

    return routeLinks;
  }

  private async selectRouteEntrySelectorFamily(container: Locator, containerSelector: string): Promise<RouteEntrySelectorFamily | undefined> {
    const selectorFamilies: RouteEntrySelectorFamily[] = [
      { label: 'anchor', selector: ':scope a' },
      { label: 'button', selector: ':scope button' },
      { label: 'role=link', selector: ':scope [role="link"]' },
      { label: 'role=button', selector: ':scope [role="button"]' },
      { label: 'onclick', selector: ':scope [onclick]' },
    ];

    for (const family of selectorFamilies) {
      const candidates = container.locator(family.selector);
      const candidateCount = await candidates.count().catch(() => 0);
      if (candidateCount === 0) {
        continue;
      }

      for (let index = 0; index < candidateCount; index++) {
        const candidate = candidates.nth(index);
        if (!(await candidate.isVisible().catch(() => false))) {
          continue;
        }

        if (await this.isLikelyRouteEntryCandidate(candidate)) {
          console.log(`findRouteLinksInContainer selected route entry selector family "${family.label}" (${family.selector}) inside "${containerSelector}".`);
          return family;
        }
      }
    }

    return undefined;
  }

  private async logScopedRouteListDiagnostics(container: Locator, containerSelector: string): Promise<void> {
    const selectorFamilies: RouteEntrySelectorFamily[] = [
      { label: 'a', selector: ':scope a' },
      { label: 'button', selector: ':scope button' },
      { label: 'role="link"', selector: ':scope [role="link"]' },
      { label: 'role="button"', selector: ':scope [role="button"]' },
      { label: 'onclick', selector: ':scope [onclick]' },
    ];
    const elementSampleCap = 3;
    const textSampleCap = 4;

    const counts = await Promise.all(selectorFamilies.map(async family => ({
      label: family.label,
      count: await this.countVisibleElements(container.locator(family.selector)),
    })));
    console.log(`Scoped route-list diagnostics for "${containerSelector}": ${counts.map(({ label, count }) => `${label}=${count}`).join(', ')}`);

    const candidateSamples: string[] = [];
    for (const family of selectorFamilies) {
      if (candidateSamples.length >= elementSampleCap) {
        break;
      }

      const candidates = container.locator(family.selector);
      const candidateCount = await candidates.count().catch(() => 0);
      for (let index = 0; index < candidateCount && candidateSamples.length < elementSampleCap; index++) {
        const candidate = candidates.nth(index);
        if (!(await candidate.isVisible().catch(() => false))) {
          continue;
        }

        if (!(await this.hasMeaningfulRouteContext(candidate))) {
          continue;
        }

        candidateSamples.push(await this.describeRouteCandidate(candidate, family.label));
      }
    }

    if (candidateSamples.length > 0) {
      console.log(`Scoped route-list clickable samples: ${candidateSamples.join(' | ')}`);
    } else {
      console.log('Scoped route-list clickable samples: none of the visible candidates looked route-related.');
    }

    const nearbyTextSamples = await this.collectNearbyTextSamples(container, textSampleCap);
    if (nearbyTextSamples.length > 0) {
      console.log(`Scoped route-list nearby text samples: ${nearbyTextSamples.join(' | ')}`);
    } else {
      console.log('Scoped route-list nearby text samples: no visible route-adjacent text matches were found.');
    }
  }

  private async countVisibleElements(locator: Locator): Promise<number> {
    const count = await locator.count().catch(() => 0);
    let visibleCount = 0;

    for (let index = 0; index < count; index++) {
      if (await locator.nth(index).isVisible().catch(() => false)) {
        visibleCount += 1;
      }
    }

    return visibleCount;
  }

  private async describeRouteCandidate(candidate: Locator, familyLabel: string): Promise<string> {
    const [tagName, text, className, id, href, role, parentSample] = await Promise.all([
      candidate.evaluate(el => el.tagName.toLowerCase()).catch(() => ''),
      this.readVisibleText(candidate),
      candidate.getAttribute('class').catch(() => ''),
      candidate.getAttribute('id').catch(() => ''),
      candidate.getAttribute('href').catch(() => ''),
      candidate.getAttribute('role').catch(() => ''),
      this.getContainerTextSample(candidate),
    ]);

    return `[${familyLabel}] tag=${tagName || '-'} text=${JSON.stringify(text.slice(0, 80))} class=${JSON.stringify((className || '').slice(0, 80))} id=${JSON.stringify((id || '').slice(0, 40))} href=${JSON.stringify((href || '').slice(0, 120))} role=${JSON.stringify((role || '').slice(0, 40))} parent=${JSON.stringify(parentSample.slice(0, 120))}`;
  }

  private async collectNearbyTextSamples(container: Locator, sampleCap: number): Promise<string[]> {
    const textBearingElements = container.locator(':scope span, :scope div, :scope td, :scope p, :scope li, :scope a, :scope button');
    const elementCount = await textBearingElements.count().catch(() => 0);
    const samples: string[] = [];
    const seenTexts = new Set<string>();

    for (let index = 0; index < elementCount && samples.length < sampleCap; index++) {
      const element = textBearingElements.nth(index);
      if (!(await element.isVisible().catch(() => false))) {
        continue;
      }

      const text = await this.readVisibleText(element);
      if (!text || text.length < 3) {
        continue;
      }

      if (!(/#ST-\d{3,}/i.test(text) || /[A-Z]{3}\s*-\s*[A-Z]{3}/.test(text) || /\bDepart\b/i.test(text))) {
        continue;
      }

      const normalized = text.slice(0, 140);
      if (seenTexts.has(normalized)) {
        continue;
      }

      seenTexts.add(normalized);
      samples.push(JSON.stringify(normalized));
    }

    return samples;
  }

  private async hasMeaningfulRouteContext(candidate: Locator): Promise<boolean> {
    const text = await this.readVisibleText(candidate);
    if (this.isLikelyRouteLinkText(text)) {
      return true;
    }

    const parentSample = await this.getContainerTextSample(candidate);
    return /#ST-\d{3,}/i.test(parentSample) || /[A-Z]{3}\s*-\s*[A-Z]{3}/.test(parentSample) || /\bDepart\b/i.test(parentSample);
  }

  private async isLikelyRouteEntryCandidate(candidate: Locator): Promise<boolean> {
    const linkText = await this.readVisibleText(candidate);
    if (this.isLikelyRouteLinkText(linkText)) {
      return true;
    }

    const sampleText = await this.getContainerTextSample(candidate);
    const hasDepartAnchor = /\bdepart\b/i.test(sampleText);
    const hasRouteNumber = /#ST-\d{3,}/i.test(sampleText);
    const hasRoutePattern = /[A-Z]{3}\s*-\s*[A-Z]{3}/.test(sampleText);

    return hasDepartAnchor && (hasRouteNumber || hasRoutePattern);
  }

  private isLikelyRouteLinkText(text: string): boolean {
    return /[A-Z]{3}\s*-\s*[A-Z]{3}\s*-\s*[A-Z0-9]/i.test(text);
  }

  private async isLinkStyledCandidate(candidate: Locator): Promise<boolean> {
    const className = await candidate.getAttribute('class').catch(() => '');
    if (/text-info|text-primary|font-blue/i.test(className || '')) {
      return true;
    }

    const style = await candidate.getAttribute('style').catch(() => '');
    if (/color\s*:\s*(blue|rgb\()/i.test(style || '')) {
      return true;
    }

    const tagName = await candidate.evaluate(el => el.tagName.toLowerCase()).catch(() => '');
    return tagName === 'a';
  }

  private async getContainerTextSample(candidate: Locator): Promise<string> {
    const sampleContainer = await this.findClosestRouteRow(candidate);
    return (await this.getRouteRowText(sampleContainer)).slice(0, 200);
  }

  private async readVisibleText(locator: Locator): Promise<string> {
    return ((await locator.innerText().catch(() => '')) || (await locator.textContent().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
  }

  private async findRouteListContainer(routesModal: Locator): Promise<RouteDiscoveryMatch | undefined> {
    const scopedSelectors = [
      ':scope >> [role="tabpanel"]:has-text("260 ROUTES")',
      ':scope >> [role="tabpanel"]:has-text("263 ROUTES")',
      ':scope >> .tab-pane:has-text("260 ROUTES")',
      ':scope >> .tab-pane:has-text("263 ROUTES")',
      ':scope >> *:has-text("Cost index")',
      ':scope >> *:has-text("#ST-")',
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
      const hasHeaderAnchor = /Cost index/i.test(containerText) || /Fleet/i.test(containerText);
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
      row.locator('[role="link"]').count().catch(() => 0),
    ]);

    if (quickSignals.every(count => count === 0)) {
      return false;
    }

    const rowText = await this.getRouteRowText(row);
    if (!rowText) {
      return false;
    }

    return /#ST-\d{3,}/i.test(rowText) || /[A-Z]{3}\s*-\s*[A-Z]{3}\s*-\s*[A-Z0-9]/i.test(rowText);
  }

  private async findRouteLinkInRow(row: Locator): Promise<Locator | undefined> {
    const routeLinks = await this.findRouteLinksInContainer(row, 'fallback row');
    return routeLinks[0];
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

  private async openRouteDetails(routeLink: Locator, controlIndex: number, deadlineAt: number): Promise<boolean> {
    if (this.isDeadlineExceeded(deadlineAt)) {
      return false;
    }

    const linkText = ((await routeLink.innerText().catch(() => '')) || (await routeLink.textContent().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
    const priorSeatLayoutVisibility = await this.page.getByText(/seat layout/i).first().isVisible().catch(() => false);
    const priorEditorVisible = await this.getPricingEditorState().catch(() => undefined);

    await routeLink.click().catch(() => undefined);
    const pauseAfterClick = this.getBoundedTimeout(750, deadlineAt);
    if (pauseAfterClick > 0) {
      await this.page.waitForTimeout(pauseAfterClick);
    }

    const detailsOpened = await this.waitForRouteDetailsOpen(priorSeatLayoutVisibility, Boolean(priorEditorVisible), this.getBoundedTimeout(4000, deadlineAt));
    if (detailsOpened) {
      console.log(`route details opened [${controlIndex}]: ${linkText || '[no route link text found]'}`);
      return true;
    }

    console.log(`route details did not open cleanly [${controlIndex}]: ${linkText || '[no route link text found]'}`);
    return false;
  }

  private async ensureSeatLayoutExpanded(deadlineAt: number): Promise<boolean> {
    if (this.isDeadlineExceeded(deadlineAt)) {
      return false;
    }

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
    const expandPause = this.getBoundedTimeout(400, deadlineAt);
    if (expandPause > 0) {
      await this.page.waitForTimeout(expandPause);
    }

    const visibleInputsAfterExpand = await this.countVisibleFareInputs();
    if (visibleInputsAfterExpand > 0) {
      console.log(`seat layout expanded; visible fare inputs after expand: ${visibleInputsAfterExpand}`);
      return true;
    }

    console.log('seat layout header was found, but no visible fare inputs appeared after expand attempt.');
    return false;
  }

  private async updateVisiblePriceInputs(controlIndex: number, routeName: string, deadlineAt: number): Promise<boolean> {
    if (this.isDeadlineExceeded(deadlineAt)) {
      return false;
    }

    const editorState = await this.getPricingEditorState();
    if (!editorState) {
      console.log(`route ${controlIndex} pricing editor was not confirmed because fare inputs or Auto/Save controls were missing.`);
      return false;
    }

    console.log(`fare inputs found for route ${controlIndex}: ${editorState.fareInputsVisible}`);

    const autoApplied = await this.applyAutoPricing(controlIndex, editorState, deadlineAt);
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

    const baselineSummary = results.map(result => `${result.label}=${result.autoBaseline}`).join(', ');
    const finalSummary = results.map(result => `${result.label}=${result.finalValue}`).join(', ');
    console.log(`route ${controlIndex} pricing summary [${routeName.slice(0, 200)}]: Auto baseline fares {${baselineSummary}} -> final fares {${finalSummary}}.`);

    const updated = results.some(result => result.changed);
    if (updated) {
      await editorState.saveButton.click();
      const savePause = this.getBoundedTimeout(500, deadlineAt);
      if (savePause > 0) {
        await this.page.waitForTimeout(savePause);
      }
      console.log(`save clicked for route ${controlIndex}.`);
    } else {
      console.log(`route ${controlIndex} Auto-based fare targets already matched the visible values; Save was not clicked.`);
    }

    return updated;
  }


  private async waitForRouteDetailsOpen(previousSeatLayoutVisible: boolean, previousEditorVisible: boolean, timeoutMs = 4000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const seatLayoutVisible = await this.page.getByText(/seat layout/i).first().isVisible().catch(() => false);
      const editorState = await this.getPricingEditorState().catch(() => undefined);
      if ((seatLayoutVisible && !previousSeatLayoutVisible) || (editorState && !previousEditorVisible) || (seatLayoutVisible && editorState)) {
        return true;
      }

      await this.page.waitForTimeout(200);
    }

    return false;
  }

  private async getPricingEditorState(): Promise<PricingEditorState | undefined> {
    const fareInputsVisible = await this.countVisibleFareInputs();
    const autoButton = this.page.getByRole('button', { name: /^auto$/i }).first();
    const saveButton = this.page.getByRole('button', { name: /^save$/i }).first();
    const autoVisible = await autoButton.isVisible().catch(() => false);
    const saveVisible = await saveButton.isVisible().catch(() => false);

    if (fareInputsVisible > 0 && autoVisible && saveVisible) {
      return { fareInputsVisible, autoButton, saveButton };
    }

    return undefined;
  }

  private async applyAutoPricing(controlIndex: number, editorState: PricingEditorState, deadlineAt: number): Promise<boolean> {
    if (this.isDeadlineExceeded(deadlineAt)) {
      return false;
    }

    const fareInputsBeforeAuto = await this.captureVisibleFareSnapshot();
    if (!(await editorState.autoButton.isVisible().catch(() => false))) {
      console.log(`route ${controlIndex} has no visible Auto button in the seat layout.`);
      return false;
    }

    await editorState.autoButton.click();
    const autoApplied = await this.waitForAutoFarePopulation(fareInputsBeforeAuto, this.getBoundedTimeout(5000, deadlineAt));
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
    if (timeoutMs <= 0) {
      return false;
    }

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

    return [name, id, placeholder, ariaLabel].filter(Boolean).join('|') || `input-${await input.evaluate(el => (el as { type?: string }).type || 'text').catch(() => 'unknown')}`;
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

  private async returnToRoutesList(deadlineAt: number): Promise<void> {
    if (this.isDeadlineExceeded(deadlineAt)) {
      return;
    }

    await this.page.goBack().catch(() => undefined);
    const backPause = this.getBoundedTimeout(750, deadlineAt);
    if (backPause > 0) {
      await this.page.waitForTimeout(backPause);
    }
    const readinessTimeout = this.getBoundedTimeout(5000, deadlineAt);
    if (readinessTimeout > 0) {
      await this.waitForRoutesPageReady(readinessTimeout).catch(() => false);
    }
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

  private isDeadlineExceeded(deadlineAt: number): boolean {
    return Date.now() >= deadlineAt;
  }

  private getBoundedTimeout(requestedMs: number, deadlineAt: number): number {
    return Math.max(0, Math.min(requestedMs, deadlineAt - Date.now()));
  }
}
