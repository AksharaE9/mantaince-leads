import { test, expect } from '@playwright/test';

test.describe('Follow-Ups E2E Flow', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/login');
    await page.fill('input[type="email"]', 'adminofleads@gmail.com');
    await page.fill('input[type="password"]', 'hile@dsbase@123');
    await page.click('button[type="submit"]');
    await page.waitForURL('**/leads**');
  });

  test('navigates to calendar and checks follow-up details', async ({ page }) => {
    const viewport = page.viewportSize();
    const isMobile = viewport && viewport.width < 768;

    if (isMobile) {
      const hamburger = page.locator('[data-testid="hamburger-btn"]');
      await expect(hamburger).toBeVisible();
      await hamburger.click();
      const drawerLink = page.locator('div.fixed a[href="/calendar"]');
      await expect(drawerLink).toBeVisible();
      await drawerLink.click();
    } else {
      const asideLink = page.locator('aside a[href="/calendar"]');
      await expect(asideLink).toBeVisible();
      await asideLink.click();
    }
    await expect(page.locator('text=Follow-up Calendar')).toBeVisible();

    // Verify grid view presence
    await expect(page.locator('[data-testid="calendar-grid-view"]')).toBeVisible();
  });
});
