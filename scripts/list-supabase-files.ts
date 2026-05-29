import { createClient } from "@supabase/supabase-js";
import * as fs from "fs";
import * as path from "path";

// read .env.local
const envPath = path.resolve(".env.local");
const envContent = fs.readFileSync(envPath, "utf-8");
const env: Record<string, string> = {};
envContent.split("\n").forEach(line => {
  const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?$/);
  if (match) {
    let key = match[1];
    let value = match[2] || "";
    value = value.trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.substring(1, value.length - 1);
    }
    env[key] = value;
  }
});

const supabaseUrl = env["SUPABASE_URL"];
const supabaseServiceKey = env["SUPABASE_SERVICE_KEY"];

if (!supabaseUrl || !supabaseServiceKey) {
  console.error("Missing credentials in .env.local at: " + envPath);
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

async function listFiles(bucket: string, prefix: string = ""): Promise<string[]> {
  const { data, error } = await supabase.storage.from(bucket).list(prefix, {
    limit: 100,
    offset: 0,
    sortBy: { column: "name", order: "asc" }
  });
  if (error) {
    console.error(`Error listing ${bucket}/${prefix}:`, error.message);
    return [];
  }
  let files: string[] = [];
  for (const item of data || []) {
    const fullPath = prefix ? `${prefix}/${item.name}` : item.name;
    // In supabase-js storage list, folders have id === null or do not have metadata
    if (!item.id || !item.metadata) {
      const subFiles = await listFiles(bucket, fullPath);
      files = files.concat(subFiles);
    } else {
      files.push(`${fullPath} (${item.metadata.size} bytes, created ${item.created_at})`);
    }
  }
  return files;
}

async function main() {
  console.log("Fetching buckets...");
  const { data: buckets, error } = await supabase.storage.listBuckets();
  if (error) {
    console.error("Error listing buckets:", error.message);
    return;
  }
  console.log(`Found ${buckets?.length || 0} buckets:`);
  for (const bucket of buckets || []) {
    console.log(`\nBucket: ${bucket.name} (Public: ${bucket.public})`);
    const files = await listFiles(bucket.name);
    console.log(`Total files: ${files.length}`);
    files.slice(0, 50).forEach(f => console.log(`  - ${f}`));
    if (files.length > 50) {
      console.log(`  ... and ${files.length - 50} more files`);
    }
  }
}

main().catch(console.error);
