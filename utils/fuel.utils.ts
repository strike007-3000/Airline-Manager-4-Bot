import fs from 'fs';
import path from 'path';
import { Locator, Page } from "@playwright/test";
import { ConfigUtils } from "./config.utils";
import { GeneralUtils } from "./general.utils";

require('dotenv').config();

type ResourceType = 'fuel' | 'co2';

type PriceHistoryEntry = {
    timestamp: string;
    price: number;
};

type PlannedDepartureSnapshot = {
    capturedAt: string;
    departuresInNext24Hours: number;
    departuresInNext48Hours: number;
    departuresInNext7Days: number;
    averageDeparturesPerHour: number;
};

type PriceHistoryFile = {
    fuel: PriceHistoryEntry[];
    co2: PriceHistoryEntry[];
};

type MarketDecision = {
    shouldBuy: boolean;
    quantity: number;
    reason: string;
};

export class FuelUtils {
    maxFuelPrice: number;
    maxCo2Price: number;
    minimumFuelCoverHours: number;
    targetFuelCoverHours: number;
    aggressiveFuelCoverHours: number;
    minimumCo2CoverHours: number;
    targetCo2CoverHours: number;
    aggressiveCo2CoverHours: number;
    maxPriceHistoryEntries: number;
    favorableFuelPercentile: number;
    favorableCo2Percentile: number;
    averageFuelBurnPerDeparture: number;
    averageCo2BurnPerDeparture: number;
    marketHistoryFile: string;
    plannedDepartureSnapshot: PlannedDepartureSnapshot | null;

    page: Page;

    constructor(page: Page) {
        this.maxFuelPrice = ConfigUtils.requireNumber('MAX_FUEL_PRICE');
        this.maxCo2Price = ConfigUtils.requireNumber('MAX_CO2_PRICE');
        this.minimumFuelCoverHours = ConfigUtils.optionalNumber('MINIMUM_FUEL_COVER_HOURS', 12);
        this.targetFuelCoverHours = ConfigUtils.optionalNumber('TARGET_FUEL_COVER_HOURS', 36);
        this.aggressiveFuelCoverHours = ConfigUtils.optionalNumber('AGGRESSIVE_FUEL_COVER_HOURS', 72);
        this.minimumCo2CoverHours = ConfigUtils.optionalNumber('MINIMUM_CO2_COVER_HOURS', 24);
        this.targetCo2CoverHours = ConfigUtils.optionalNumber('TARGET_CO2_COVER_HOURS', 72);
        this.aggressiveCo2CoverHours = ConfigUtils.optionalNumber('AGGRESSIVE_CO2_COVER_HOURS', 120);
        this.maxPriceHistoryEntries = ConfigUtils.optionalNumber('MAX_PRICE_HISTORY_ENTRIES', 200);
        this.favorableFuelPercentile = ConfigUtils.optionalNumber('FAVORABLE_FUEL_PERCENTILE', 35);
        this.favorableCo2Percentile = ConfigUtils.optionalNumber('FAVORABLE_CO2_PERCENTILE', 35);
        this.averageFuelBurnPerDeparture = ConfigUtils.optionalNumber('AVERAGE_FUEL_BURN_PER_DEPARTURE', 250000);
        this.averageCo2BurnPerDeparture = ConfigUtils.optionalNumber('AVERAGE_CO2_BURN_PER_DEPARTURE', 100000);
        this.marketHistoryFile = ConfigUtils.optionalString('MARKET_HISTORY_FILE', path.join(process.cwd(), '.cache', 'market-history.json'));
        this.plannedDepartureSnapshot = null;
        this.page = page;

        console.log(`Fuel intelligence configured from in-game market prices only. Fuel cap=${this.maxFuelPrice}, CO2 cap=${this.maxCo2Price}, history file=${this.marketHistoryFile}`);
    }

    public async analyzePlannedDepartures() {
        console.log('Analyzing planned departures for in-game market intelligence...');

        const rowTexts = await this.collectPotentialDepartureTexts();
        const now = new Date();

        let departuresInNext24Hours = 0;
        let departuresInNext48Hours = 0;
        let departuresInNext7Days = 0;

        for (const rowText of rowTexts) {
            const hoursUntilDeparture = this.extractHoursUntilDeparture(rowText, now);
            if (hoursUntilDeparture === null) {
                continue;
            }

            if (hoursUntilDeparture <= 24) {
                departuresInNext24Hours++;
            }
            if (hoursUntilDeparture <= 48) {
                departuresInNext48Hours++;
            }
            if (hoursUntilDeparture <= 24 * 7) {
                departuresInNext7Days++;
            }
        }

        const averageDeparturesPerHour = departuresInNext24Hours > 0
            ? departuresInNext24Hours / 24
            : Math.max(departuresInNext48Hours / 48, departuresInNext7Days / (24 * 7), 1 / 24);

        this.plannedDepartureSnapshot = {
            capturedAt: now.toISOString(),
            departuresInNext24Hours,
            departuresInNext48Hours,
            departuresInNext7Days,
            averageDeparturesPerHour,
        };

        console.log(`Planned departures snapshot: 24h=${departuresInNext24Hours}, 48h=${departuresInNext48Hours}, 7d=${departuresInNext7Days}, avg/hr=${averageDeparturesPerHour.toFixed(3)}`);
    }

    public async buyFuel() {
        console.log('Buying Fuel...');

        const state = await this.readMarketState();
        if (state.emptyCapacity === 0) {
            return;
        }

        const history = this.recordPriceHistory('fuel', state.currentPrice);
        const percentile = this.calculatePricePercentile(history, state.currentPrice);
        const estimatedUsagePerHour = this.estimateUsagePerHour('fuel');
        const coverHours = this.calculateCoverHours(state.currentHolding, estimatedUsagePerHour);
        const decision = this.decidePurchase({
            resource: 'fuel',
            currentPrice: state.currentPrice,
            currentHolding: state.currentHolding,
            emptyCapacity: state.emptyCapacity,
            priceCap: this.maxFuelPrice,
            percentile,
            favorablePercentile: this.favorableFuelPercentile,
            minimumCoverHours: this.minimumFuelCoverHours,
            targetCoverHours: this.targetFuelCoverHours,
            aggressiveCoverHours: this.aggressiveFuelCoverHours,
            estimatedUsagePerHour,
        });

        console.log(`Fuel cover=${coverHours.toFixed(2)}h, percentile=${percentile.toFixed(1)}, usage/hr=${estimatedUsagePerHour.toFixed(0)}.`);
        await this.executePurchaseIfNeeded('fuel', decision);
    }

    public async buyCo2() {
        console.log('Buying CO2...');

        const state = await this.readMarketState();
        if (state.emptyCapacity === 0 && state.currentHolding >= 0) {
            return;
        }

        const history = this.recordPriceHistory('co2', state.currentPrice);
        const percentile = this.calculatePricePercentile(history, state.currentPrice);
        const estimatedUsagePerHour = this.estimateUsagePerHour('co2');
        const coverHours = this.calculateCoverHours(state.currentHolding, estimatedUsagePerHour);
        const decision = this.decidePurchase({
            resource: 'co2',
            currentPrice: state.currentPrice,
            currentHolding: state.currentHolding,
            emptyCapacity: state.emptyCapacity,
            priceCap: this.maxCo2Price,
            percentile,
            favorablePercentile: this.favorableCo2Percentile,
            minimumCoverHours: this.minimumCo2CoverHours,
            targetCoverHours: this.targetCo2CoverHours,
            aggressiveCoverHours: this.aggressiveCo2CoverHours,
            estimatedUsagePerHour,
        });

        console.log(`CO2 cover=${coverHours.toFixed(2)}h, percentile=${percentile.toFixed(1)}, usage/hr=${estimatedUsagePerHour.toFixed(0)}.`);
        await this.executePurchaseIfNeeded('co2', decision);
    }

    private async collectPotentialDepartureTexts(): Promise<string[]> {
        const selectors = [
            'tr',
            '.route',
            '.route-row',
            '.flight',
            '.flight-row',
            '.list-group-item',
        ];

        for (const selector of selectors) {
            const locator = this.page.locator(selector);
            const count = await locator.count();
            if (count === 0) {
                continue;
            }

            const texts = await locator.allInnerTexts();
            const filtered = texts
                .map(text => text.replace(/\s+/g, ' ').trim())
                .filter(text => /depart|flight|route|gate|eta|remaining|hour|min/i.test(text));

            if (filtered.length > 0) {
                return filtered;
            }
        }

        return [];
    }

    private extractHoursUntilDeparture(text: string, now: Date): number | null {
        const lowerText = text.toLowerCase();

        const daysHoursMinutes = lowerText.match(/(\d+)d\s*(\d+)h\s*(\d+)m/);
        if (daysHoursMinutes) {
            return Number.parseInt(daysHoursMinutes[1], 10) * 24 + Number.parseInt(daysHoursMinutes[2], 10) + Number.parseInt(daysHoursMinutes[3], 10) / 60;
        }

        const hoursMinutes = lowerText.match(/(\d+)h\s*(\d+)m/);
        if (hoursMinutes) {
            return Number.parseInt(hoursMinutes[1], 10) + Number.parseInt(hoursMinutes[2], 10) / 60;
        }

        const minutesOnly = lowerText.match(/(\d+)m/);
        if (minutesOnly && /depart|remaining|eta|next/i.test(lowerText)) {
            return Number.parseInt(minutesOnly[1], 10) / 60;
        }

        const absoluteMatch = text.match(/(\d{1,2})[:.](\d{2})/);
        if (absoluteMatch && /depart|next|schedule/i.test(lowerText)) {
            const departureTime = new Date(now);
            departureTime.setUTCHours(Number.parseInt(absoluteMatch[1], 10), Number.parseInt(absoluteMatch[2], 10), 0, 0);
            if (departureTime.getTime() < now.getTime()) {
                departureTime.setUTCDate(departureTime.getUTCDate() + 1);
            }

            return (departureTime.getTime() - now.getTime()) / (1000 * 60 * 60);
        }

        return null;
    }

    private async readMarketState() {
        return {
            currentPrice: await this.readInteger(this.page.getByText('Total price$').locator('b > span')),
            currentHolding: await this.readInteger(this.page.locator('#holding')),
            emptyCapacity: await this.readInteger(this.page.locator('#remCapacity')),
        };
    }

    private async readInteger(locator: Locator): Promise<number> {
        const rawText = (await locator.innerText()).replaceAll(',', '').trim();
        const match = rawText.match(/-?\d+/);
        return match ? Number.parseInt(match[0], 10) : 0;
    }

    private recordPriceHistory(resource: ResourceType, price: number): number[] {
        const history = this.readPriceHistory();
        const resourceHistory = history[resource];

        resourceHistory.push({
            timestamp: new Date().toISOString(),
            price,
        });

        history[resource] = resourceHistory.slice(-this.maxPriceHistoryEntries);
        fs.mkdirSync(path.dirname(this.marketHistoryFile), { recursive: true });
        fs.writeFileSync(this.marketHistoryFile, JSON.stringify(history, null, 2));

        return history[resource].map(entry => entry.price);
    }

    private readPriceHistory(): PriceHistoryFile {
        if (!fs.existsSync(this.marketHistoryFile)) {
            return { fuel: [], co2: [] };
        }

        const rawContent = fs.readFileSync(this.marketHistoryFile, 'utf8');
        const parsedContent = JSON.parse(rawContent) as Partial<PriceHistoryFile>;

        return {
            fuel: parsedContent.fuel ?? [],
            co2: parsedContent.co2 ?? [],
        };
    }

    private calculatePricePercentile(history: number[], currentPrice: number): number {
        if (history.length <= 1) {
            return 50;
        }

        const cheaperOrEqualSamples = history.filter(price => price <= currentPrice).length;
        return (cheaperOrEqualSamples / history.length) * 100;
    }

    private estimateUsagePerHour(resource: ResourceType): number {
        const snapshot = this.plannedDepartureSnapshot;
        const departuresPerHour = snapshot?.averageDeparturesPerHour ?? (1 / 24);
        const averageBurnPerDeparture = resource === 'fuel' ? this.averageFuelBurnPerDeparture : this.averageCo2BurnPerDeparture;

        return Math.max(departuresPerHour * averageBurnPerDeparture, 1);
    }

    private calculateCoverHours(currentHolding: number, estimatedUsagePerHour: number): number {
        if (currentHolding <= 0) {
            return 0;
        }

        return currentHolding / estimatedUsagePerHour;
    }

    private decidePurchase(input: {
        resource: ResourceType;
        currentPrice: number;
        currentHolding: number;
        emptyCapacity: number;
        priceCap: number;
        percentile: number;
        favorablePercentile: number;
        minimumCoverHours: number;
        targetCoverHours: number;
        aggressiveCoverHours: number;
        estimatedUsagePerHour: number;
    }): MarketDecision {
        const currentCoverHours = this.calculateCoverHours(input.currentHolding, input.estimatedUsagePerHour);
        const isNegativeCo2 = input.resource === 'co2' && input.currentHolding < 0;
        const favorablePrice = input.currentPrice <= input.priceCap;
        const favorablePercentile = input.percentile <= input.favorablePercentile;
        const emergency = isNegativeCo2 || currentCoverHours < input.minimumCoverHours;

        if (!emergency && !favorablePrice && !favorablePercentile) {
            return {
                shouldBuy: false,
                quantity: 0,
                reason: `${input.resource.toUpperCase()} in-game price is not favorable and minimum cover is safe.`,
            };
        }

        let targetCoverHours = input.targetCoverHours;
        let reason = `${input.resource.toUpperCase()} top-up to target cover.`;

        if (emergency) {
            targetCoverHours = Math.max(input.targetCoverHours, input.minimumCoverHours * 1.5);
            reason = isNegativeCo2
                ? 'CO2 holding is negative, forcing purchase even at an expensive price.'
                : `${input.resource.toUpperCase()} cover is below the minimum threshold, forcing purchase.`;
        } else if (favorablePercentile) {
            targetCoverHours = input.aggressiveCoverHours;
            reason = `${input.resource.toUpperCase()} in-game price percentile is favorable, buying aggressively in bulk.`;
        } else if (favorablePrice) {
            reason = `${input.resource.toUpperCase()} in-game price is below cap, topping up to target cover.`;
        }

        const targetUnits = Math.ceil(targetCoverHours * input.estimatedUsagePerHour);
        const shortfall = Math.max(targetUnits - Math.max(input.currentHolding, 0), 0);
        const quantity = Math.min(Math.max(shortfall, 0), input.emptyCapacity);

        if (quantity <= 0) {
            return {
                shouldBuy: false,
                quantity: 0,
                reason: `${input.resource.toUpperCase()} cover target already satisfied.`,
            };
        }

        return {
            shouldBuy: true,
            quantity,
            reason,
        };
    }

    private async executePurchaseIfNeeded(resource: ResourceType, decision: MarketDecision) {
        console.log(`${resource.toUpperCase()} decision: ${decision.reason}`);
        if (!decision.shouldBuy) {
            return;
        }

        await this.page.getByPlaceholder('Amount to purchase').click();
        await this.page.getByPlaceholder('Amount to purchase').press('Control+a');
        await this.page.getByPlaceholder('Amount to purchase').fill(String(decision.quantity));
        await this.page.getByRole('button', { name: ' Purchase' }).click();

        console.log(`Bought ${resource.toUpperCase()} successfully. Amount purchased: ${decision.quantity}.`);
        await GeneralUtils.sleep(1000);
    }
}
