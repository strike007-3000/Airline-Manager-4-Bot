import { test } from '@playwright/test';
import { GeneralUtils } from '../utils/general.utils';
import { CampaignUtils } from '../utils/campaign.utils';

test('Marketing Suite Test Run', async ({ page }) => {
  test.setTimeout(120000);

  const generalUtils = new GeneralUtils(page);
  const campaignUtils = new CampaignUtils(page);

  // 1. Log in
  await generalUtils.login();

  // 2. Open Marketing Page
  await page.locator('div:nth-child(5) > #mapMaint > img').click();
  await page.waitForSelector('.modal-title', { timeout: 10000 }).catch(() => {});

  // 3. Trigger campaigns purchase flow
  await campaignUtils.createCampaign();

  // 4. Clean up
  await generalUtils.closePopupIfOpen();
  await page.close();
});
