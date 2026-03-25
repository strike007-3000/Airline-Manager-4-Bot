import { Page } from "@playwright/test";
import { ConfigUtils } from "./config.utils";

require('dotenv').config();

export class GeneralUtils {
    username : string;
    password : string;
    page : Page;

    constructor(page : Page) {
        this.username = ConfigUtils.requireString('EMAIL');
        this.password = ConfigUtils.requireString('PASSWORD');
        this.page = page;
    }

    public static async sleep(ms: number) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    public async login(page: Page) {
        console.log('Logging in...')

        await page.goto('https://www.airlinemanager.com/');

        // Accept cookies if the popup exists (prevents click interception)
        const acceptCookies = page.getByRole('button', { name: /accept/i });
        if (await acceptCookies.isVisible().catch(() => false)) {
            await acceptCookies.click().catch(() => {});
        }

        // Click the main 'Log In' button to open the modal
        await page.evaluate(() => {
            if (typeof (window as any).login === 'function') {
                (window as any).login('show');
            } else {
                document.querySelector('.btn-grey')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            }
        });
        
        const emailInput = page.locator('#lEmail');
        await emailInput.waitFor({ state: 'visible', timeout: 15000 });
        
        await emailInput.click();
        await emailInput.fill(this.username);
        await emailInput.press('Tab');
        await page.locator('#lPass').click();
        await page.locator('#lPass').fill(this.password);
        await page.locator('#btnLogin').click();

        console.log('Logged in successfully!');
    }

    public async closePopupIfOpen() {
        const closeButton = this.page.locator('#popup .glyphicons, #popup .close, .modal-header .close').first();
        if (await closeButton.isVisible().catch(() => false)) {
            await closeButton.click();
            await this.page.locator('#popup').waitFor({ state: 'hidden', timeout: 3000 }).catch(async () => {
                await this.page.waitForTimeout(500);
            });
        }
    }
}
