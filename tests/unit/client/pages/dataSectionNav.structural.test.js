import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Structural/source-level checks for the Raw Data / Delivery Data section
// promotion — same rationale as LeadsPage.actionBar.test.js: full RTL
// renders of these route/layout files aren't feasible in this repo (see
// CLAUDE.md), so this verifies the routing/nav wiring exists in the right
// place at the source level instead.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf-8');

const appSource = read('../../../../client/src/App.jsx');
const layoutSource = read('../../../../client/src/layouts/AppLayout.jsx');

describe('App.jsx — Raw Data / Delivery Data routes', () => {
    it('registers /raw-data and /delivery-data as lazy-loaded routes nested under the protected AppLayout', () => {
        expect(appSource).toMatch(/const RawDataPage = lazy\(\(\) => import\('\.\/pages\/RawDataPage\.jsx'\)\)/);
        expect(appSource).toMatch(/const DeliveryDataPage = lazy\(\(\) => import\('\.\/pages\/DeliveryDataPage\.jsx'\)\)/);
        expect(appSource).toContain('<Route path="raw-data" element={<RawDataPage />} />');
        expect(appSource).toContain('<Route path="delivery-data" element={<DeliveryDataPage />} />');
    });

    it('registers the new routes alongside the other per-vertical sections (leads, follow-ups-positives), not inside the admin-gated block', () => {
        const protectedBlock = appSource.slice(appSource.indexOf('<Route path="/" element='), appSource.indexOf('{/* Admin Scoped views */}'));
        expect(protectedBlock).toContain('raw-data');
        expect(protectedBlock).toContain('delivery-data');
    });
});

describe('AppLayout.jsx — Raw Data / Delivery Data nav entries', () => {
    it('adds Raw Data and Delivery Data to the desktop nav, next to COS', () => {
        expect(layoutSource).toMatch(/navLink\('\/raw-data', Database, 'Raw Data', true\)/);
        expect(layoutSource).toMatch(/navLink\('\/delivery-data', Truck, 'Delivery Data', true\)/);
    });

    it('adds Raw Data and Delivery Data to the mobile drawer nav array too, so both are reachable on small screens', () => {
        expect(layoutSource).toMatch(/\['\/raw-data', Database, 'Raw Data'\]/);
        expect(layoutSource).toMatch(/\['\/delivery-data', Truck, 'Delivery Data'\]/);
    });

    it('imports the Database and Truck icons used by the new nav entries', () => {
        expect(layoutSource).toMatch(/Database,\s*Truck,/);
    });
});
