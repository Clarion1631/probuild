import { readdirSync, statSync } from 'fs';
import { join } from 'path';

const SEARCH_DIRS = [
    'C:\\Users\\jat00\\Desktop',
    'C:\\Users\\jat00\\Documents',
    'C:\\Users\\jat00\\Downloads',
];

const EXTENSIONS = ['.csv', '.json', '.sql', '.zip', '.xlsx'];
const THIRTY_DAYS_AGO = Date.now() - 60 * 24 * 60 * 60 * 1000; // Last 60 days

function scanDir(dir, depth = 0) {
    if (depth > 6) return []; // Limit depth
    let results = [];
    try {
        const files = readdirSync(dir);
        for (const file of files) {
            if (file.startsWith('.') || file === 'node_modules' || file === 'AppData') continue;
            const fullPath = join(dir, file);
            try {
                const stat = statSync(fullPath);
                if (stat.isDirectory()) {
                    results = results.concat(scanDir(fullPath, depth + 1));
                } else {
                    const ext = file.substring(file.lastIndexOf('.')).toLowerCase();
                    if (EXTENSIONS.includes(ext) && stat.mtimeMs > THIRTY_DAYS_AGO && stat.size > 100) {
                        results.push({
                            path: fullPath,
                            size: stat.size,
                            mtime: new Date(stat.mtimeMs).toISOString(),
                        });
                    }
                }
            } catch (e) {
                // ignore
            }
        }
    } catch (e) {
        // ignore
    }
    return results;
}

async function main() {
    console.log("Searching user directories (Downloads, Desktop, Documents) for recent files...");
    let allFiles = [];
    for (const dir of SEARCH_DIRS) {
        allFiles = allFiles.concat(scanDir(dir));
    }
    
    console.log(`\nFound ${allFiles.length} recent JSON, CSV, SQL, ZIP, or XLSX files:`);
    allFiles.sort((a, b) => b.size - a.size);
    allFiles.forEach(f => {
        console.log(`- ${f.path} (${(f.size / 1024).toFixed(1)} KB, Modified: ${f.mtime})`);
    });
}

main().catch(console.error);
