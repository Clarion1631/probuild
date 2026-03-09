const fs = require('fs');

const path = 'src/app/page.tsx';
const content = fs.readFileSync(path, 'utf8');
const lines = content.split('\n');

const mainIndex = lines.findIndex(l => l.includes('<main className="flex-1 p-8 bg-gray-100">'));
const endMainIndex = lines.findIndex(l => l.includes('</main>'));

if (mainIndex === -1 || endMainIndex === -1) {
    console.error("Could not find <main> tags.");
    process.exit(1);
}

// Keep the imports and function declaration
const topPart = lines.slice(0, 10);
// Wait, return is on line 9!
// Let's find "return (" instead.
const returnIndex = lines.findIndex(l => l.includes('return ('));

const importsPart = lines.slice(0, returnIndex + 1);

const middlePart = lines.slice(mainIndex, endMainIndex + 1);

const bottomPart = ['  );', '}'];

const newContent = [...importsPart, ...middlePart, ...bottomPart].join('\n');

fs.writeFileSync(path, newContent);
console.log('Successfully patched page.tsx');
