import { Page } from "@playwright/test";
import { GeneralUtils } from "./general.utils";
import { ConfigUtils } from "./config.utils";

type MarketingBudget = 'low' | 'medium' | 'high';

interface CampaignPlan {
    type: number;
    duration: number;
    description: string;
}

export class CampaignUtils {
    page: Page;
    marketingMode: string;
    marketingBudget: MarketingBudget;

    constructor(page: Page) {
        this.page = page;
        this.marketingMode = ConfigUtils.optionalString('MARKETING_MODE', 'smart');
        this.marketingBudget = ConfigUtils.optionalString('MARKETING_BUDGET', 'low') as MarketingBudget;
    }

    private getCampaignPlan(): CampaignPlan | undefined {
        if (this.marketingMode === 'off' || this.marketingMode === 'eco_only') {
            return undefined;
        }

        if (process.env.INCREASE_AIRLINE_REPUTATION === 'true') {
            return {
                type: ConfigUtils.requireNumber('CAMPAIGN_TYPE'),
                duration: ConfigUtils.requireNumber('CAMPAIGN_DURATION'),
                description: 'legacy reputation campaign settings',
            };
        }

        const budgetPlans: Record<MarketingBudget, CampaignPlan> = {
            low: { type: 1, duration: 4, description: 'low-budget reputation boost' },
            medium: { type: 2, duration: 8, description: 'balanced reputation boost' },
            high: { type: 3, duration: 12, description: 'aggressive reputation boost' },
        };

        return budgetPlans[this.marketingBudget] || budgetPlans.low;
    }

    private async createEcoFriendly() {
        const isEcoFriendlyExists = await this.page.getByRole('cell', { name: ' Eco friendly' }).isVisible();
        if (!isEcoFriendlyExists) {
            await this.page.getByRole('button', { name: ' New campaign' }).click();
            await this.page.getByRole('cell', { name: 'Eco-friendly Increases' }).click();
            await this.page.getByRole('button', { name: '$' }).click();

            console.log('Eco Friendly Campaign Created Successfully!');
        }
    }

    private async createReputation(plan: CampaignPlan) {
        const campaignType = plan.type.toString();
        const durationOption = (Math.floor(plan.duration / 4) || 1).toString();
        const isAirlineReputationExists = await this.page.getByRole('cell', { name: ' Airline reputation' }).isVisible();

        if (!isAirlineReputationExists) {
            await this.page.getByRole('button', { name: ' New campaign' }).click();
            await this.page.getByRole('cell', { name: 'Increase airline reputation' }).click();
            await this.page.locator('#dSelector').selectOption(durationOption);
            await this.page.locator(`tr:has(td:has-text("Campaign ${campaignType}")) .btn-danger`).click();

            console.log(`Started ${plan.description} successfully!`);
        }
    }

    public async createCampaign() {
        console.log('Create Campaign Started...');

        await this.page.getByRole('button', { name: ' Marketing' }).click();
        await GeneralUtils.sleep(1000);

        await this.createEcoFriendly();

        const campaignPlan = this.getCampaignPlan();
        if (campaignPlan) {
            await this.createReputation(campaignPlan);
        } else {
            console.log('Smart marketing selector skipped airline reputation campaign.');
        }

        console.log('Campaign Created Finished!');
    }
}
