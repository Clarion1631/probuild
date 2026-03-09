const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const fs = require('fs');
const path = require('path');

chromium.use(stealth);

async function runAudit() {
  const browser = await chromium.launch({ headless: true }); // Using headless for stealth script as requested
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  });

  // Load cookies
  const cookiesData = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/houzz-cookies.json'), 'utf8'));
  const cookies = Array.isArray(cookiesData) ? cookiesData : (cookiesData.cookies || []);
  await context.addCookies(cookies);

  const page = await context.newPage();
  
  // Log API calls
  const apiLogs = [];
  page.on('request', request => {
    if (request.url().includes('api') || request.url().includes('graphql')) {
      apiLogs.push(`[${request.method()}] ${request.url()}`);
    }
  });

  const modules = [
    { name: 'Dashboard', url: 'https://pro.houzz.com/dashboard' },
    { name: 'Leads', url: 'https://pro.houzz.com/leads' },
    { name: 'EstimateForm', url: 'https://pro.houzz.com/estimates/new' }, // Guessed URL
    { name: 'Timeline', url: 'https://pro.houzz.com/projects/hoppe-remodel/schedule' } // Placeholder URL
  ];

  for (const mod of modules) {
    console.log(`Auditing ${mod.name}...`);
    try {
      await page.goto(mod.url, { waitUntil: 'load', timeout: 60000 });
      
      // Random delay
      const delay = Math.floor(Math.random() * (8000 - 2000 + 1) + 2000);
      await page.waitForTimeout(delay);

      // Human-like scroll
      await page.mouse.wheel(0, 500);
      await page.waitForTimeout(1000);

      await page.screenshot({ path: path.join(__dirname, `../docs/screenshots/${mod.name.toLowerCase()}.png`), fullPage: true });
      
      if (page.url().includes('429')) {
        console.error(`Blocked at ${mod.name} (429)`);
        break;
      }
    } catch (e) {
      console.error(`Failed to audit ${mod.name}: ${e.message}`);
    }
  }

  fs.writeFileSync(path.join(__dirname, '../docs/houzz-api-calls.md'), "# Houzz API Calls\n\n" + apiLogs.join('\n\n'));
  await browser.close();
}

runAudit();
