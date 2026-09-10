#!/usr/bin/env node
// Offline only. Production evidence is collected by the protected server endpoint.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditReceiptOutcomes } from './lib/receipt-outcome-audit.mjs';
const USAGE = 'usage: node scripts/audit-receipt-outcomes.mjs --snapshot FILE [--now ISO]';
const isMainModule = fileURLToPath(import.meta.url) === resolve(process.argv[1] || '');
export function parseArgs(argv) {
  const opts = {snapshot:null,now:null};
  for(let i=0;i<argv.length;i++) {
    const key=argv[i] === '--snapshot' ? 'snapshot' : argv[i] === '--now' ? 'now' : null;
    if(!key || opts[key] !== null || !argv[i+1] || argv[i+1].startsWith('--')) throw new Error(USAGE);
    opts[key]=argv[++i];
  }
  if(!opts.snapshot) throw new Error(USAGE);
  return opts;
}
function main() {
  let opts;
  try { opts=parseArgs(process.argv.slice(2)); }
  catch { console.error(USAGE); process.exitCode=1; return; }
  let snapshot;
  try { snapshot=JSON.parse(readFileSync(opts.snapshot,'utf8')); }
  catch { console.error('receipt-outcome-audit: snapshot file unreadable or not valid JSON'); process.exitCode=2; return; }
  try { process.stdout.write(JSON.stringify(auditReceiptOutcomes(snapshot,opts.now ?? snapshot.capturedAt),null,2)+'\n'); }
  catch { console.error('receipt-outcome-audit: snapshot shape or --now value invalid'); process.exitCode=2; }
}
if(isMainModule) { main(); }
