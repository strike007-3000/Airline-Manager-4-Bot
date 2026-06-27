import { Page } from "@playwright/test";
import { GeneralUtils } from "./general.utils";
import { ConfigUtils } from "./config.utils";

const ECO_FRIENDLY_DURATION_HOURS = 12;
const ECO_FRIENDLY_DURATION_OPTION = (ECO_FRIENDLY_DURATION_HOURS / 2).toString(); // ECO_FRIENDLY_DURATION_HOURS / 2 is 6, which represents 12h option in the select

export class CampaignUtils {
    page: Page;
    enableReputationCampaign: boolean;
    enablePaxCampaign: boolean;
    enableCargoCampaign: boolean;
    campaignDurationOption: string; // "1" = 4h, "2" = 8h, "3" = 24h

    constructor(page: Page) {
        this.page = page;
        this.enableReputationCampaign = ConfigUtils.optionalBoolean('ENABLE_REPUTATION_CAMPAIGN', true);
        this.enablePaxCampaign = ConfigUtils.optionalBoolean('ENABLE_PAX_CAMPAIGN', true);
        this.enableCargoCampaign = ConfigUtils.optionalBoolean('ENABLE_CARGO_CAMPAIGN', true);
        
        // Duration Option map for select box:
        // "1" = 4 hours
        // "2" = 8 hours
        // "3" = 24 hours (default)
        const durationHours = ConfigUtils.optionalNumber('MARKETING_DURATION_HOURS', 24);
        if (durationHours === 4) {
            this.campaignDurationOption = "1";
        } else if (durationHours === 8) {
            this.campaignDurationOption = "2";
        } else {
            this.campaignDurationOption = "3"; // Default 24h
        }
    }

    private async createEcoFriendly() {
        const isEcoFriendlyExists = await this.page.getByRole('cell', { name: ' Eco friendly' }).isVisible().catch(() => false);
        if (isEcoFriendlyExists) {
            console.log('Eco Friendly campaign is already active.');
            return;
        }

        await this.page.getByRole('button', { name: ' New campaign' }).click({ force: true });
        await this.page.getByRole('cell', { name: 'Eco-friendly Increases' }).click({ force: true });

        const durationSelector = this.page.locator('#dSelector');
        if (await durationSelector.isVisible().catch(() => false)) {
            await durationSelector.selectOption(ECO_FRIENDLY_DURATION_OPTION);
        }

        await this.page.getByRole('button', { name: '$' }).click({ force: true });
        console.log(`Eco Friendly campaign created successfully for ${ECO_FRIENDLY_DURATION_HOURS} hours.`);

    }

    private async createReputation() {
        const isReputationExists = await this.page.getByRole('cell', { name: ' Airline reputation' }).isVisible().catch(() => false);
        if (isReputationExists) {
            console.log('Airline reputation campaign is already active.');
            return;
        }

        await this.page.getByRole('button', { name: ' New campaign' }).click({ force: true });
        await this.page.getByRole('cell', { name: 'Campaigns help to increase airline reputation' }).click({ force: true });

        const durationSelector = this.page.locator('#dSelector');
        if (await durationSelector.isVisible().catch(() => false)) {
            await durationSelector.selectOption(this.campaignDurationOption);
        }

        // Click first campaign option purchase button (largest reputation boost for cash)
        const buyBtn = this.page.locator('#c1Btn');
        if (await buyBtn.isVisible().catch(() => false)) {
            await buyBtn.click({ force: true });
            console.log('Airline reputation campaign purchased successfully.');
            await this.page.waitForTimeout(1000);
        } else {
            console.warn('Airline reputation purchase button not found.');
            // Click Close/Cancel on campaign option modal to return to modal
            const closeBtn = this.page.locator('.modal-header .close, .box-header .close, button.close').first();
            if (await closeBtn.isVisible().catch(() => false)) {
                await closeBtn.click({ force: true });
            }
        }
    }

    private async createCargo() {
        const isCargoExists = await this.page.getByRole('cell', { name: ' Cargo reputation' }).isVisible().catch(() => false);
        if (isCargoExists) {
            console.log('Cargo reputation campaign is already active.');
            return;
        }

        await this.page.getByRole('button', { name: ' New campaign' }).click({ force: true });
        await this.page.getByRole('cell', { name: 'Campaigns help to increase cargo reputation' }).click({ force: true });

        const durationSelector = this.page.locator('#dSelector');
        if (await durationSelector.isVisible().catch(() => false)) {
            await durationSelector.selectOption(this.campaignDurationOption);
        }

        const buyBtn = this.page.locator('#c1Btn');
        if (await buyBtn.isVisible().catch(() => false)) {
            await buyBtn.click({ force: true });
            console.log('Cargo reputation campaign purchased successfully.');
            await this.page.waitForTimeout(1000);
        } else {
            console.warn('Cargo reputation purchase button not found.');
            const closeBtn = this.page.locator('.modal-header .close, .box-header .close, button.close').first();
            if (await closeBtn.isVisible().catch(() => false)) {
                await closeBtn.click({ force: true });
            }
        }
    }



    public async createCampaign() {
        console.log('Create Campaign Started...');

        await this.page.getByRole('button', { name: ' Marketing' }).click();
        // Wait for the 'New campaign' button to appear as a signal the modal is ready
        await this.page.getByRole('button', { name: ' New campaign' }).waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});

        await this.createEcoFriendly();
        await this.page.waitForTimeout(1000);

        if (this.enableReputationCampaign) {
            await this.createReputation();
            await this.page.waitForTimeout(1000);
        }

        if (this.enableCargoCampaign) {
            await this.createCargo();
            await this.page.waitForTimeout(1000);
        }

        console.log('Campaign Created Finished!');
    }
}

