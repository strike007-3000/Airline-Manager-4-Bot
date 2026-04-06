import { test } from '@playwright/test';
import { GeneralUtils } from '../utils/general.utils';
import { FuelUtils } from '../utils/fuel.utils';

require('dotenv').config();

test('Fuel and CO2 Monitor', async ({ page }) => {
  // Set a shorter timeout for the monitor run
  test.setTimeout(process.env.CI ? 60000 : 30000);

  const generalUtils = new GeneralUtils(page);
  const fuelUtils = new FuelUtils(page);

  // 1. Login
  await generalUtils.login(page);

  // 2. Quick analysis of departures to inform buying logic (Cover Hours)
  await page.locator('#mapRoutes').getByRole('img').click();
  await GeneralUtils.sleep(2000);
  await fuelUtils.analyzePlannedDepartures();
  await generalUtils.closePopupIfOpen();

  // 3. Navigate to Fuel/Maintenance and Buy Fuel
  await page.locator('#mapMaint > img').first().click();
  await fuelUtils.buyFuel();

  // 4. Buy CO2
  await page.getByRole('button', { name: ' Co2' }).click();
  await GeneralUtils.sleep(1000);
  await fuelUtils.buyCo2();

  await page.close();
});
