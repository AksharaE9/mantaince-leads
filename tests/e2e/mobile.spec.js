import { test, expect, devices } from '@playwright/test';

test.use({ ...devices['Pixel 5'] });

test.describe('Mobile Viewport E2E Flow', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/login');
    await page.fill('input[type="email"]', 'adminofleads@gmail.com');
    await page.fill('input[type="password"]', 'hile@dsbase@123');
    await page.click('button[type="submit"]');
    await page.waitForURL('**/leads**');
  });

  test('collapses navigation menu on small viewport', async ({ page }) => {
    // Hamburger menu toggle should be visible on mobile
    const hamburger = page.locator('[data-testid="hamburger-btn"]');
    await expect(hamburger).toBeVisible();
  });
});
