import { defineConfig } from '@playwright/test';
export default defineConfig({
    testDir: './tests/ui',
    timeout: 15000,
    workers: 2,
    use: { headless: true, viewport: { width: 1050, height: 800 } },
});
