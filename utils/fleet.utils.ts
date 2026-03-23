import { Page } from "@playwright/test";
import { GeneralUtils } from "./general.utils";
import { MaintenanceUtils } from "./maintenance.utils";

require('dotenv').config();

export class FleetUtils {
    page: Page;
    maxTry: number; // Added to prevent infinite loop in case of no fuel available
    maintenanceUtils: MaintenanceUtils;
    generalUtils: GeneralUtils;

    constructor(page: Page) {
        this.page = page;
        this.maxTry = 8; // TODO: Find another way
        this.maintenanceUtils = new MaintenanceUtils(page);
        this.generalUtils = new GeneralUtils(page);
    }

    private async getDepartureModalText() {
        const modalText = await this.page.locator('#popup .modal-content').innerText().catch(() => '');
        return modalText.replace(/\s+/g, ' ').trim().toLowerCase();
    }

    private async maintenanceBlockingDeparture() {
        const modalText = await this.getDepartureModalText();
        if (!modalText.includes('unable to depart')) {
            return false;
        }

        const overdueACheckPatterns = [
            /some a\/c was due for a-check/i,
            /aircraft .* due for a-check/i,
            /a-check .* due/i,
        ];

        const repairThresholdPatterns = [
            /some a\/c was worn to/i,
            /aircraft .* worn to/i,
            /repair required/i,
        ];

        return [...overdueACheckPatterns, ...repairThresholdPatterns].some((pattern) => pattern.test(modalText));
    }

    private async scheduleMaintenanceAndReturnToRoutes() {
        await this.generalUtils.closePopupIfOpen();
        await this.page.locator('div:nth-child(4) > #mapMaint > img').click();
        await GeneralUtils.sleep(1500);
        const summary = await this.maintenanceUtils.prepareFlightsForDeparture();
        await this.maintenanceUtils.closeMaintenanceModal();
        await this.generalUtils.closePopupIfOpen();
        await this.page.locator('#mapRoutes').getByRole('img').click();
        await GeneralUtils.sleep(2500);
        return summary;
    }

    public async departPlanes() {
        console.log('Preparing flights for departure with A-check and repair scheduling...');
        await this.scheduleMaintenanceAndReturnToRoutes();

        let departAllVisible = await this.page.locator('#departAll').isVisible().catch(() => false);
        console.log('Looking if there are any planes to be departed...');

        let count = 0;
        while (departAllVisible && count < this.maxTry) {
            console.log('Departing 20 or less...');

            const departAll = this.page.locator('#departAll');
            await departAll.click();
            await GeneralUtils.sleep(1500);

            const maintenanceBlocked = await this.maintenanceBlockingDeparture();
            if (maintenanceBlocked) {
                console.log('Departure blocked by due A-check or repair threshold; scheduling maintenance before retrying.');
                const summary = await this.scheduleMaintenanceAndReturnToRoutes();
                if (!summary.workScheduled) {
                    console.log('No additional maintenance could be scheduled, stopping departure attempts.');
                    break;
                }
            }

            departAllVisible = await this.page.locator('#departAll').isVisible().catch(() => false);
            count++;

            console.log('Departed 20 or less planes...');
        }
    }
}
