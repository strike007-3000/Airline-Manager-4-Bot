import * as fs from 'fs';
import * as path from 'path';
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

        // Wait for the page to be ready
        await page.waitForLoadState('networkidle').catch(() => {});

        // Click the main 'Log In' button to open the modal
        // We try both the JS evaluate and a direct locator to be robust
        const loginTriggered = await page.evaluate(() => {
            if (typeof (window as any).login === 'function') {
                (window as any).login('show');
                return true;
            }
            return false;
        }).catch(() => false);

        if (!loginTriggered) {
            await page.locator('.btn-grey, button:has-text("Log In")').first().click().catch(() => {});
        }
        
        const emailInput = page.locator('#lEmail');
        try {
            await emailInput.waitFor({ state: 'visible', timeout: 15000 });
        } catch (e) {
            console.warn('Login modal did not appear via standard trigger, retrying with direct click...');
            await page.locator('.btn-grey').first().click().catch(() => {});
            await emailInput.waitFor({ state: 'visible', timeout: 5000 });
        }
        
        await emailInput.click();
        await emailInput.fill(this.username);
        await emailInput.press('Tab');
        
        const passwordInput = page.locator('#lPass');
        await passwordInput.click();
        await passwordInput.fill(this.password);
        
        await page.locator('#btnLogin').click();

        // Wait for a successful login indicator (like the presence of the map or logout button)
        await page.waitForSelector('#mapRoutes, .logout', { timeout: 30000 }).catch(() => {
            console.warn('Login might have failed or is taking too long to load the dashboard.');
        });

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

    /**
     * Atomically writes data to a file by writing to a temporary file first 
     * and kemudian performing a synchronous rename. Prevents file corruption.
     */
    public static atomicWriteFileSync(filePath: string, data: string) {
        const tempPath = `${filePath}.tmp_${Date.now()}`;
        try {
            // Ensure directory exists
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            
            // Write to temp file
            fs.writeFileSync(tempPath, data, 'utf8');
            
            // Atomic swap
            fs.renameSync(tempPath, filePath);
        } catch (error) {
            // Cleanup temp file if it exists and we failed
            if (fs.existsSync(tempPath)) {
                try { fs.unlinkSync(tempPath); } catch {}
            }
            throw new Error(`Atomic write failed to ${filePath}: ${error}`);
        }
    }
}
