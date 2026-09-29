// Runs the unit-test allow-list with Node's test runner through tsx:
//   node --import tsx --test <every path in tests/unit-list.txt>
// `npm run test:unit` calls this. The list lives in its own file, one path per
// line, so PRs that add tests append lines there (merge=union in
// .gitattributes) instead of all editing one package.json line. Arguments
// after the script name go to node ahead of the file list, e.g.
//   npm run test:unit -- --test-name-pattern="deposit"
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIST = "tests/unit-list.txt";

const files = [
  ...new Set(
    readFileSync(path.join(root, LIST), "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"))
  ),
];

const missing = files.filter(
  (file) => !statSync(path.join(root, file), { throwIfNoEntry: false })?.isFile()
);
if (files.length === 0) {
  console.error(`${LIST} lists no test files.`);
  process.exit(1);
}
if (missing.length > 0) {
  console.error(`${LIST} lists ${missing.length} file(s) that do not exist:`);
  for (const file of missing) console.error(`  ${file}`);
  process.exit(1);
}

// Windows caps a whole command line at 32,767 characters and the list is
// already over 11,000, so split it into as few node runs as stay under the cap
// (one run today). Every run happens even if an earlier one fails.
const MAX_COMMAND_CHARS = 30_000;
const nodeArgs = ["--import", "tsx", "--test", ...process.argv.slice(2)];
const cost = (arg) => arg.length + 3; // the argument, a space, and quotes if needed
const baseCost = [process.execPath, ...nodeArgs].reduce((sum, arg) => sum + cost(arg), 0);
const runs = [[]];
let used = baseCost;
for (const file of files) {
  if (used + cost(file) > MAX_COMMAND_CHARS && runs.at(-1).length > 0) {
    runs.push([]);
    used = baseCost;
  }
  runs.at(-1).push(file);
  used += cost(file);
}

console.log(
  `Running ${files.length} test files from ${LIST}` +
    (runs.length > 1 ? ` in ${runs.length} batches.` : ".")
);
for (const batch of runs) {
  const result = spawnSync(process.execPath, [...nodeArgs, ...batch], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
}
