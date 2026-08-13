import ExcelJS from 'exceljs';
import fs from 'fs';
import path from 'path';

const downloadsDir = 'C:\\Users\\jishn\\Downloads';

async function inspectFile(fileName) {
    const filePath = path.join(downloadsDir, fileName);
    if (!fs.existsSync(filePath)) {
        console.log(`File not found: ${fileName}`);
        return;
    }
    const workbook = new ExcelJS.Workbook();
    try {
        await workbook.xlsx.readFile(filePath);
        console.log(`\n📄 File: ${fileName}`);
        console.log(`   Sheets: ${workbook.worksheets.map(w => `${w.name} (${w.rowCount} rows)`).join(', ')}`);
        
        // Print first 2 rows of first sheet
        const sheet = workbook.worksheets[0];
        if (sheet && sheet.rowCount > 0) {
            console.log('   Row 1:', sheet.getRow(1).values.slice(1, 10));
            console.log('   Row 2:', sheet.getRow(2).values.slice(1, 10));
        }
    } catch (err) {
        console.error(`Error reading ${fileName}:`, err.message);
    }
}

async function run() {
    const files = fs.readdirSync(downloadsDir);
    console.log(`\nScan for checkpoint or talenty files:`);
    const matches = files.filter(f => f.toLowerCase().includes('checkpoint') || f.toLowerCase().includes('talenty'));
    for (const f of matches) {
        const stats = fs.statSync(path.join(downloadsDir, f));
        console.log(`  - ${f} (${(stats.size/1024).toFixed(1)} KB)`);
    }
}

run();
