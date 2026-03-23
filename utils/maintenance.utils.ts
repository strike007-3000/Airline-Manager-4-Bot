import { Page } from "@playwright/test";
import { GeneralUtils } from "./general.utils";

require('dotenv').config();

export class MaintenanceUtils {
    page: Page;
    repairThreshold: string;

    constructor(page: Page) {
        this.page = page;
        this.repairThreshold = process.env.REPAIR_THRESHOLD_PERCENT ?? '30';
    }

    private async isVisibleSafe(selector: string) {
        const locator = this.page.locator(selector).first();
        return locator.isVisible().catch(() => false);
    }

    private async openPlanningMenu() {
        await this.page.getByRole('button', { name: ' Plan' }).click();
        await GeneralUtils.sleep(500);
    }

    public async repairPlanes() {
        await this.openPlanningMenu();
        await this.page.getByRole('button', { name: ' Bulk repair' }).click();
        await this.page.locator('#repairPct').selectOption(this.repairThreshold);
        await GeneralUtils.sleep(1000);

        const noPlaneExists = await this.page.getByText('There are no aircraft worn to').isVisible().catch(() => false);
        if (!noPlaneExists) {
            await this.page.getByRole('button', { name: 'Plan bulk repair' }).click();
            return true;
        }

        return false;
    }

    public async checkPlanes() {
        await this.openPlanningMenu();
        await this.page.getByRole('button', { name: ' Bulk check' }).click();

        await GeneralUtils.sleep(2000);
        let clicked = false;

        const allCheckHoursDanger = this.page.locator('.bg-white > .text-danger');
        const dangerChecksExist = await allCheckHoursDanger.first().isVisible().catch(() => false);
        if (dangerChecksExist) {
            let count = await allCheckHoursDanger.count();
            for (let i = 0; i < count; i++) {
                const element = allCheckHoursDanger.first();
                await element.click();
                clicked = true;
                await GeneralUtils.sleep(500);
            }
        }

        if (clicked) {
            await this.page.getByRole('button', { name: 'Plan bulk check' }).click();
        }

        return clicked;
    }

    public async prepareFlightsForDeparture() {
        const checksPlanned = await this.checkPlanes();
        await GeneralUtils.sleep(1000);
        const repairsPlanned = await this.repairPlanes();
        await GeneralUtils.sleep(1000);

        return {
            checksPlanned,
            repairsPlanned,
            workScheduled: checksPlanned || repairsPlanned,
        };
    }

    public async closeMaintenanceModal() {
        const closeButtonSelector = '#popup > .modal-dialog > .modal-content > .modal-header > div > .glyphicons';
        const closeButtonVisible = await this.isVisibleSafe(closeButtonSelector);
        if (closeButtonVisible) {
            await this.page.locator(closeButtonSelector).click();
            await this.page.locator('#popup').waitFor({ state: 'hidden', timeout: 3000 }).catch(async () => {
                await GeneralUtils.sleep(1000);
            });
        }
    }
}
