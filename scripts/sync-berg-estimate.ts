import { PrismaClient } from '@prisma/client';
import { decryptObject } from '../src/lib/crypto';
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const prisma = new PrismaClient();

const QB_API_BASE = process.env.QB_SANDBOX === "true"
    ? "https://sandbox-quickbooks.api.intuit.com/v3/company"
    : "https://quickbooks.api.intuit.com/v3/company";

const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";

interface QBTokens {
    accessToken: string;
    refreshToken: string;
    realmId: string;
}

// Refresh token helper
async function refreshQBToken(refreshToken: string): Promise<{ accessToken: string; refreshToken: string }> {
    const clientId = process.env.QB_CLIENT_ID!;
    const clientSecret = process.env.QB_CLIENT_SECRET!;
    const encoded = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

    const res = await fetch(TOKEN_URL, {
        method: "POST",
        headers: {
            Authorization: `Basic ${encoded}`,
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
        },
        body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: refreshToken,
        }),
    });

    if (!res.ok) {
        const err = await res.text();
        throw new Error(`QB token refresh failed: ${err}`);
    }
    const data = await res.json();
    return { accessToken: data.access_token, refreshToken: data.refresh_token };
}

// Get fresh tokens from database
async function getTokens(): Promise<QBTokens> {
    const row = await prisma.integration.findUnique({
        where: { id: "system_settings" }
    });
    if (!row) throw new Error("No integration settings found in database.");

    const settings = decryptObject(row.settings);
    const qb = settings?.quickbooks;
    if (!qb || !qb.connected || !qb.accessToken || !qb.refreshToken || !qb.realmId) {
        throw new Error("QuickBooks is not connected. Please go to http://localhost:3000/settings/integrations/quickbooks and connect first.");
    }

    console.log("Found QuickBooks tokens in database. Attempting to refresh...");
    try {
        const fresh = await refreshQBToken(qb.refreshToken);
        
        // Save back to db
        settings.quickbooks = {
            ...qb,
            accessToken: fresh.accessToken,
            refreshToken: fresh.refreshToken,
        };
        
        const { encryptObject } = require('../src/lib/crypto');
        await prisma.integration.update({
            where: { id: "system_settings" },
            data: { settings: encryptObject(settings) }
        });
        
        console.log("Tokens refreshed and updated in database successfully.");
        return { accessToken: fresh.accessToken, refreshToken: fresh.refreshToken, realmId: qb.realmId };
    } catch (err: any) {
        console.warn("Failed to refresh token, attempting to use existing tokens. Error:", err.message);
        return { accessToken: qb.accessToken, refreshToken: qb.refreshToken, realmId: qb.realmId };
    }
}

// Call QBO API
async function qbFetch(path: string, tokens: QBTokens, opts: RequestInit = {}): Promise<any> {
    const url = `${QB_API_BASE}/${tokens.realmId}${path}${path.includes('?') ? '&' : '?'}minorversion=73`;
    const res = await fetch(url, {
        ...opts,
        headers: {
            Authorization: `Bearer ${tokens.accessToken}`,
            Accept: "application/json",
            "Content-Type": "application/json",
            ...opts.headers,
        },
    });

    if (!res.ok) {
        const err = await res.text();
        throw new Error(`QBO API Error (${res.status}) on ${path}: ${err}`);
    }
    return res.json();
}

async function main() {
    console.log("Starting QuickBooks Estimate Sync...");
    const tokens = await getTokens();

    // 1. Get or create ItemRef
    console.log("Fetching QuickBooks Products and Services...");
    const itemsRes = await qbFetch("/query?query=select * from Item", tokens);
    const itemsList = itemsRes.QueryResponse?.Item || [];
    
    let targetItemRef: any = null;
    
    if (itemsList.length > 0) {
        // Find if there is a service item or any remodeling item
        const serviceItem = itemsList.find((i: any) => i.Type === "Service" || i.Name.toLowerCase().includes("remodel") || i.Name.toLowerCase().includes("service"));
        const fallbackItem = serviceItem || itemsList[0];
        targetItemRef = { value: fallbackItem.Id, name: fallbackItem.Name };
        console.log(`Using existing Item: "${fallbackItem.Name}" (ID: ${fallbackItem.Id})`);
    } else {
        // We need to create an item. But creating an item requires an income account.
        console.log("No items found. Fetching Accounts to find an Income Account...");
        const accountsRes = await qbFetch("/query?query=select * from Account where AccountType = 'Revenue' or AccountType = 'Income'", tokens);
        const accountsList = accountsRes.QueryResponse?.Account || [];
        
        if (accountsList.length === 0) {
            throw new Error("Could not find any Income/Revenue accounts in QuickBooks to link to a new service item. Please create at least one item or income account in QBO.");
        }
        
        const incomeAccount = accountsList[0];
        console.log(`Found Income Account: "${incomeAccount.Name}" (ID: ${incomeAccount.Id}). Creating "Remodeling Services" item...`);
        
        const newItemPayload = {
            Name: "Remodeling Services",
            Type: "Service",
            IncomeAccountRef: {
                value: incomeAccount.Id,
                name: incomeAccount.Name
            }
        };
        
        const createItemRes = await qbFetch("/item", tokens, {
            method: "POST",
            body: JSON.stringify(newItemPayload)
        });
        
        const createdItem = createItemRes.Item;
        targetItemRef = { value: createdItem.Id, name: createdItem.Name };
        console.log(`Created new Item: "${createdItem.Name}" (ID: ${createdItem.Id})`);
    }

    // 2. Find or Create Dixie Berg Customer
    console.log("Checking if customer 'Dixie Berg' exists in QuickBooks...");
    const customerQuery = "select * from Customer where DisplayName = 'Dixie Berg'";
    const customerCheckRes = await qbFetch(`/query?query=${encodeURIComponent(customerQuery)}`, tokens);
    const existingCustomer = customerCheckRes.QueryResponse?.Customer?.[0];
    
    let qbCustomerId = "";
    if (existingCustomer) {
        qbCustomerId = existingCustomer.Id;
        console.log(`Found existing customer: 'Dixie Berg' (ID: ${qbCustomerId})`);
    } else {
        console.log("Customer 'Dixie Berg' not found. Creating...");
        const customerPayload = {
            DisplayName: "Dixie Berg",
            PrimaryEmailAddr: { Address: "aprilvelilla@gmail.com" },
            BillAddr: {
                Line1: "219 Jones Rd",
                City: "Winlock",
                CountrySubDivisionCode: "WA",
                PostalCode: "98596"
            }
        };
        
        const createCustRes = await qbFetch("/customer", tokens, {
            method: "POST",
            body: JSON.stringify(customerPayload)
        });
        qbCustomerId = createCustRes.Customer.Id;
        console.log(`Created customer: 'Dixie Berg' (ID: ${qbCustomerId})`);
    }

    // 3. Find or Create Project (as sub-customer)
    const projectDisplayName = "Dixie Berg - Berg ADU";
    console.log(`Checking if project sub-customer '${projectDisplayName}' exists...`);
    const projectQuery = `select * from Customer where DisplayName = '${projectDisplayName}'`;
    const projectCheckRes = await qbFetch(`/query?query=${encodeURIComponent(projectQuery)}`, tokens);
    const existingProject = projectCheckRes.QueryResponse?.Customer?.[0];
    
    let qbProjectId = "";
    if (existingProject) {
        qbProjectId = existingProject.Id;
        console.log(`Found existing project sub-customer: '${projectDisplayName}' (ID: ${qbProjectId})`);
    } else {
        console.log(`Project sub-customer not found. Creating under Dixie Berg (ID: ${qbCustomerId})...`);
        const projectPayload = {
            DisplayName: projectDisplayName,
            Job: true,
            ParentRef: {
                value: qbCustomerId
            },
            IsProject: true,
            ProjectStatus: "RUNNING"
        };
        
        const createProjRes = await qbFetch("/customer", tokens, {
            method: "POST",
            body: JSON.stringify(projectPayload)
        });
        qbProjectId = createProjRes.Customer.Id;
        console.log(`Created project sub-customer: '${projectDisplayName}' (ID: ${qbProjectId})`);
    }

    // 4. Construct Estimate lines matching BergAUD.pdf
    console.log("Constructing Estimate payload...");
    const items = [
        // ADU Section
        { name: "ADU - Demo: Remove Water closet and open up walls in preparation for new layout. cut concrete for access to new drain locations", qty: 1, price: 1800 },
        { name: "ADU - Framing: Frame new bathroom with 32 inch bathroom door.", qty: 1, price: 1400 },
        { name: "ADU - Plumbing Allowance: expose main sewer line to prepare for new kitchen and bathroom layout. Rough in toilet, shower. vanity, kitchen sink and Possibly laundry area in shop. includes material and labor for all waste venting and supply lines. New water Heater with stand (500) Materials (2800)", qty: 1, price: 4000 },
        { name: "ADU - Electrical: Run new subpanel into ADU from shop and rough in all required circuits for new layout. This includes kitchen, bath and living area circuitry. including new lighting throughout interior. new lighting for exterior includes light at door and flood light to light path from ADU to main house.", qty: 1, price: 3500 },
        { name: "ADU - Drywall: Replace, repair and install new drywall in affected areas. Texture to medium orange peel texture on all surfaces.", qty: 1, price: 2500 },
        { name: "ADU - Paint: Prime and Paint entire space", qty: 1, price: 1500 },
        { name: "ADU - Cabinetry Allowance: Kitchen cabinets with 30 inch matching vanity cabinet. includes all cabinets for kitchen layout as shown with crown trim pieces and touch up kits.", qty: 1, price: 4200 },
        { name: "ADU - Cabinet Install Package Allowance: Assemble and install all cabinets as layout requires, includes all trim package leveled and professionally installed", qty: 1, price: 1500 },
        { name: "ADU - Flooring Allowance: carpet squares for main living area, calculated to include bathroom for pricing. Not sure if carpet in the bathroom is what you are looking for?", qty: 400, price: 6.5 },
        { name: "ADU - Appliance Package Allowance: Refrigerator 800-1200 depending on style Range 800 Hood vent (200) install labor for all appliances (500)", qty: 1, price: 2500 },
        { name: "ADU - Millwork: Bathroom door, trim package for all windows doors and basebaord", qty: 1, price: 1500 },
        
        // Bathroom Finishes Section
        { name: "Bathroom Finishes - Walk in shower: Delta shower surround $700 valve package $300 install $500", qty: 1, price: 1500 },
        { name: "Bathroom Finishes - Toilet: chair height elongated toilet", qty: 1, price: 250 },
        { name: "Bathroom Finishes - Vanity: cabinet is included in cabinetry package (350) will need a countertop and sink and faucet (500)", qty: 1, price: 500 },
        { name: "Bathroom Finishes - Flooring: What flooring would you like for the bathroom?", qty: 1, price: 0 },
        
        // Kalama Tax/Markup
        { name: "Markup/Tax - Kalama (8.2%)", qty: 1, price: 2398.50 }
    ];

    const lines = items.map((item, index) => ({
        Id: String(index + 1),
        LineNum: index + 1,
        Description: item.name,
        Amount: item.qty * item.price,
        DetailType: "SalesItemLineDetail",
        SalesItemLineDetail: {
            ItemRef: targetItemRef,
            Qty: item.qty,
            UnitPrice: item.price
        }
    }));

    const customerMemo = `PAYMENT SCHEDULE:\n- Scheduling Deposit: $10,000.00\n- Drywall Complete: $10,000.00\n- Progress Payment: $11,648.50`;

    const estimatePayload = {
        DocNumber: "EST-00146",
        TxnDate: "2026-05-10", // Matching date from PDF
        TxnStatus: "Accepted",
        CustomerRef: {
            value: qbProjectId,
            name: projectDisplayName
        },
        Line: lines,
        CustomerMemo: {
            value: customerMemo
        },
        PrivateNote: "Seeded directly matching BergAUD.pdf"
    };

    console.log("Pushing Estimate to QuickBooks Online...");
    const createEstRes = await qbFetch("/estimate", tokens, {
        method: "POST",
        body: JSON.stringify(estimatePayload)
    });

    const createdEstimate = createEstRes.Estimate;
    console.log(`\n🎉 Success! Estimate successfully synced directly to QuickBooks Online.`);
    console.log(`Estimate ID: ${createdEstimate.Id}`);
    console.log(`Doc Number: ${createdEstimate.DocNumber}`);
    console.log(`Total Amount: $${createdEstimate.TotalAmt}`);
    console.log(`QuickBooks URL: https://app.qbo.intuit.com/app/estimate?txnId=${createdEstimate.Id}`);
}

main()
    .catch((e) => {
        console.error("❌ Sync Error:", e.message);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
