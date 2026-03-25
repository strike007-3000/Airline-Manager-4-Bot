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

    private async getDepartureModalText(): Promise<string> {
        // AM4 errors frequently appear as sweet-alerts or bootstrap alerts.
        const popup = this.page.locator('.sweet-alert:visible, .alert:visible, #error:visible').first();
        if (await popup.isVisible().catch(() => false)) {
            const modalText = await popup.innerText().catch(() => '');
            if (modalText) {
                console.log(`Departure alert says: ${modalText.substring(0, 150).replace(/\n/g, ' ')}`);
            }
            return modalText.replace(/\s+/g, ' ').trim().toLowerCase();
        }
        return '';
    }
        return '';
    }

    private maintenanceBlockingDeparture(modalText: string): boolean {
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

            // Wait dynamically for the button to disappear or an alert to appear to avoid spamming clicks
            await Promise.any([
                this.page.locator('.sweet-alert:visible, .alert:visible, #error:visible').waitFor({ state: 'visible', timeout: 15000 }).catch(() => {}),
                departAll.waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {})
            ]);
            await this.page.waitForTimeout(500); // Small buffer for rendering/text population

            const modalText = await this.getDepartureModalText();
            const maintenanceBlocked = this.maintenanceBlockingDeparture(modalText);

            if (maintenanceBlocked) {
                console.log('Departure blocked by due A-check or repair threshold; scheduling maintenance before retrying.');
                const summary = await this.scheduleMaintenanceAndReturnToRoutes();
                if (!summary.workScheduled) {
                    console.log('No additional maintenance could be scheduled, stopping departure attempts.');
                    break;
                }
            } else if (modalText !== '') {
                if (modalText.includes('fuel') || modalText.includes('co2') || modalText.includes('quota')) {
                    console.log('Departure blocked by fuel/CO2/quota constraints. Stopping to avoid infinite loop.');
                    await this.generalUtils.closePopupIfOpen();
                    break;
                }
                
                // If it's a success popup or other non-blocking message, clear it to continue
                await this.generalUtils.closePopupIfOpen();
            }

            departAllVisible = await this.page.locator('#departAll').isVisible().catch(() => false);
            count++;

            console.log('Departed 20 or less planes...');
        }
    }
}
