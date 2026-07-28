import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Structural/source-level check, not a rendered-component test — CLAUDE.md
// documents that full RTL renders of LeadsPage currently crash (two live
// React copies across root/client node_modules in this repo's dependency
// tree), and prescribes source-level checks as the fallback for "does this
// JSX exist in the right place" until that structural gap is fixed. Real
// visual/interaction verification (nav entries render, cross-link buttons
// navigate, the section pages load records) is done manually in a running
// dev server instead.
//
// Raw Data / Delivery Data were promoted from "button that pops a modal
// inside LeadsPage" to full sections of their own (own route, own toolbar,
// own table) — see client/src/components/DataSectionPage.jsx and
// client/src/pages/RawDataPage.jsx / DeliveryDataPage.jsx. LeadsPage no
// longer mounts <RawDataModal>/<DeliveryDataModal> directly; it only
// cross-links to the new sections, the same way it already links to
// Positives & Follow-ups.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const leadsPageSource = fs.readFileSync(
    path.join(__dirname, '../../../../client/src/pages/LeadsPage.jsx'),
    'utf-8'
);

describe('LeadsPage — Raw Data / Delivery Data are cross-links, not modals', () => {
    it('no longer imports or mounts RawDataModal/DeliveryDataModal directly', () => {
        expect(leadsPageSource).not.toContain("from '../components/RawDataModal.jsx'");
        expect(leadsPageSource).not.toContain("from '../components/DeliveryDataModal.jsx'");
        expect(leadsPageSource).not.toContain('<RawDataModal');
        expect(leadsPageSource).not.toContain('<DeliveryDataModal');
        expect(leadsPageSource).not.toContain('rawDataModalOpen');
        expect(leadsPageSource).not.toContain('deliveryDataModalOpen');
    });

    it('renders a "Raw Data →" cross-link button matching the Positives & Follow-ups convention', () => {
        expect(leadsPageSource).toMatch(/onClick=\{\(\) => navigate\([`']\/raw-data\?verticalId=\$\{activeVertical\?\._id\}[`']\)\}[\s\S]{0,300}Raw Data/);
    });

    it('renders a "Delivery Data →" cross-link button matching the Positives & Follow-ups convention', () => {
        expect(leadsPageSource).toMatch(/onClick=\{\(\) => navigate\([`']\/delivery-data\?verticalId=\$\{activeVertical\?\._id\}[`']\)\}[\s\S]{0,300}Delivery Data/);
    });

    it('styles the Raw Data/Delivery Data cross-links identically to the existing Positives & Follow-ups cross-link (equally-weighted entry points)', () => {
        const emeraldButtonClass = 'border border-emerald-300 hover:border-emerald-500 text-emerald-600 bg-white rounded-lg font-bold text-sm hover:bg-stone-50 shadow-sm transition-all';
        const occurrences = leadsPageSource.split(emeraldButtonClass).length - 1;
        // 4: the landing-state "Positives & Follow-ups →" button, the main
        // toolbar's "Positives & Follow-ups →", "Raw Data →", "Delivery Data →".
        expect(occurrences).toBe(4);
    });

    it('keeps the action-bar row flex-wrapping, so 7 buttons still degrade to multiple lines rather than overflowing', () => {
        expect(leadsPageSource).toContain('flex flex-wrap gap-2');
    });
});
