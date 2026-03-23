import { test } from '@playwright/test';
import { GeneralUtils } from '../utils/general.utils';
import { FuelUtils } from '../utils/fuel.utils';
import { CampaignUtils } from '../utils/campaign.utils';
import { FleetUtils } from '../utils/fleet.utils';
import { MaintenanceUtils } from '../utils/maintenance.utils';
import { PricingUtils } from '../utils/pricing.utils';

require('dotenv').config();

test('All Operations', async ({ page }) => {
  test.setTimeout(process.env.CI ? 120000 : 90000);

  const fuelUtils = new FuelUtils(page);
  const generalUtils = new GeneralUtils(page);
  const campaignUtils = new CampaignUtils(page);
  const fleetUtils = new FleetUtils(page);
  const maintenanceUtils = new MaintenanceUtils(page);
  const pricingUtils = new PricingUtils(page);

  await generalUtils.login(page);

  await page.locator('#mapRoutes').getByRole('img').click();
  await GeneralUtils.sleep(2500);
  await fuelUtils.analyzePlannedDepartures();
  await generalUtils.closePopupIfOpen();

  await page.locator('#mapMaint > img').first().click();
  await fuelUtils.buyFuel();

  await page.getByRole('button', { name: ' Co2' }).click();
  await GeneralUtils.sleep(1000);
  await fuelUtils.buyCo2();
  await generalUtils.closePopupIfOpen();

  await page.locator('div:nth-child(5) > #mapMaint > img').click();
  await campaignUtils.createCampaign();
  await generalUtils.closePopupIfOpen();
  await GeneralUtils.sleep(1000);

  await page.locator('div:nth-child(4) > #mapMaint > img').click();
  await maintenanceUtils.checkPlanes();
  await GeneralUtils.sleep(1000);
  await maintenanceUtils.repairPlanes();
  await GeneralUtils.sleep(1000);
  await generalUtils.closePopupIfOpen();

  await page.locator('#mapRoutes').getByRole('img').click();
  const routesPageUrl = page.url();
  const routesPageTitle = await page.title().catch(() => '');
  console.log(`Opened routes page for pricing. URL: ${routesPageUrl || 'unavailable'}. Title: ${routesPageTitle || 'unavailable'}.`);
  const routesPageReadyForPricing = await pricingUtils.waitForRoutesPageReady();
  if (routesPageReadyForPricing) {
    await pricingUtils.updateDailyEasyModePrices();
  }
  await generalUtils.closePopupIfOpen();
  await fleetUtils.departPlanes();

  await page.close();
});
