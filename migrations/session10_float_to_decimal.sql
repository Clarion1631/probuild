-- Session 10: Float → Decimal migration
-- Run via: powershell -ExecutionPolicy Bypass -File "C:\Users\jat00\AppData\Local\Temp\apply_schema.ps1"
-- After running: regenerate Prisma client with: ./node_modules/.bin/prisma generate
-- Then: update schema.prisma — change Float → Decimal for all money fields listed below.
--
-- IMPORTANT: Run this SQL BEFORE updating schema.prisma. If schema says Decimal but DB has float,
-- Prisma queries will fail at runtime.

-- Lead financials
ALTER TABLE "Lead" ALTER COLUMN "targetRevenue" TYPE DECIMAL(14,2) USING "targetRevenue"::DECIMAL(14,2);
ALTER TABLE "Lead" ALTER COLUMN "expectedProfit" TYPE DECIMAL(14,2) USING "expectedProfit"::DECIMAL(14,2);

-- Invoice
ALTER TABLE "Invoice" ALTER COLUMN "totalAmount" TYPE DECIMAL(14,2) USING "totalAmount"::DECIMAL(14,2);
ALTER TABLE "Invoice" ALTER COLUMN "balanceDue" TYPE DECIMAL(14,2) USING "balanceDue"::DECIMAL(14,2);

-- PaymentSchedule
ALTER TABLE "PaymentSchedule" ALTER COLUMN "amount" TYPE DECIMAL(14,2) USING "amount"::DECIMAL(14,2);

-- EstimatePaymentSchedule
ALTER TABLE "EstimatePaymentSchedule" ALTER COLUMN "amount" TYPE DECIMAL(14,2) USING "amount"::DECIMAL(14,2);

-- EstimateItem
ALTER TABLE "EstimateItem" ALTER COLUMN "baseCost" TYPE DECIMAL(14,4) USING "baseCost"::DECIMAL(14,4);
ALTER TABLE "EstimateItem" ALTER COLUMN "unitCost" TYPE DECIMAL(14,4) USING "unitCost"::DECIMAL(14,4);
ALTER TABLE "EstimateItem" ALTER COLUMN "total" TYPE DECIMAL(14,2) USING "total"::DECIMAL(14,2);

-- Expense
ALTER TABLE "Expense" ALTER COLUMN "amount" TYPE DECIMAL(14,2) USING "amount"::DECIMAL(14,2);

-- Budget
ALTER TABLE "Budget" ALTER COLUMN "totalAmount" TYPE DECIMAL(14,2) USING "totalAmount"::DECIMAL(14,2);
ALTER TABLE "Budget" ALTER COLUMN "balanceDue" TYPE DECIMAL(14,2) USING "balanceDue"::DECIMAL(14,2);
ALTER TABLE "Budget" ALTER COLUMN "totalLaborBudget" TYPE DECIMAL(14,2) USING "totalLaborBudget"::DECIMAL(14,2);
ALTER TABLE "Budget" ALTER COLUMN "totalMaterialBudget" TYPE DECIMAL(14,2) USING "totalMaterialBudget"::DECIMAL(14,2);

-- TimeEntry
ALTER TABLE "TimeEntry" ALTER COLUMN "laborCost" TYPE DECIMAL(14,2) USING "laborCost"::DECIMAL(14,2);
ALTER TABLE "TimeEntry" ALTER COLUMN "burdenCost" TYPE DECIMAL(14,2) USING "burdenCost"::DECIMAL(14,2);

-- CompanySettings processing fees
ALTER TABLE "CompanySettings" ALTER COLUMN "cardProcessingRate" TYPE DECIMAL(5,4) USING "cardProcessingRate"::DECIMAL(5,4);
ALTER TABLE "CompanySettings" ALTER COLUMN "cardProcessingFlat" TYPE DECIMAL(5,4) USING "cardProcessingFlat"::DECIMAL(5,4);

-- ChangeOrder
ALTER TABLE "ChangeOrder" ALTER COLUMN "totalAmount" TYPE DECIMAL(14,2) USING "totalAmount"::DECIMAL(14,2);
ALTER TABLE "ChangeOrder" ALTER COLUMN "balanceDue" TYPE DECIMAL(14,2) USING "balanceDue"::DECIMAL(14,2);

-- ChangeOrderItem
ALTER TABLE "ChangeOrderItem" ALTER COLUMN "baseCost" TYPE DECIMAL(14,4) USING "baseCost"::DECIMAL(14,4);
ALTER TABLE "ChangeOrderItem" ALTER COLUMN "unitCost" TYPE DECIMAL(14,4) USING "unitCost"::DECIMAL(14,4);
ALTER TABLE "ChangeOrderItem" ALTER COLUMN "total" TYPE DECIMAL(14,2) USING "total"::DECIMAL(14,2);
ALTER TABLE "ChangeOrderItem" ALTER COLUMN "amount" TYPE DECIMAL(14,2) USING "amount"::DECIMAL(14,2);

-- PurchaseOrder
ALTER TABLE "PurchaseOrder" ALTER COLUMN "totalAmount" TYPE DECIMAL(14,2) USING "totalAmount"::DECIMAL(14,2);

-- PurchaseOrderItem
ALTER TABLE "PurchaseOrderItem" ALTER COLUMN "unitCost" TYPE DECIMAL(14,4) USING "unitCost"::DECIMAL(14,4);
ALTER TABLE "PurchaseOrderItem" ALTER COLUMN "total" TYPE DECIMAL(14,2) USING "total"::DECIMAL(14,2);

-- CatalogItem
ALTER TABLE "CatalogItem" ALTER COLUMN "price" TYPE DECIMAL(14,4) USING "price"::DECIMAL(14,4);

-- Retainer
ALTER TABLE "Retainer" ALTER COLUMN "totalAmount" TYPE DECIMAL(14,2) USING "totalAmount"::DECIMAL(14,2);
ALTER TABLE "Retainer" ALTER COLUMN "balanceDue" TYPE DECIMAL(14,2) USING "balanceDue"::DECIMAL(14,2);
ALTER TABLE "Retainer" ALTER COLUMN "amountPaid" TYPE DECIMAL(14,2) USING "amountPaid"::DECIMAL(14,2);

-- BidScope
ALTER TABLE "BidScope" ALTER COLUMN "totalBudget" TYPE DECIMAL(14,2) USING "totalBudget"::DECIMAL(14,2);

-- BidInvitation
ALTER TABLE "BidInvitation" ALTER COLUMN "budgetAmount" TYPE DECIMAL(14,2) USING "budgetAmount"::DECIMAL(14,2);
ALTER TABLE "BidInvitation" ALTER COLUMN "bidAmount" TYPE DECIMAL(14,2) USING "bidAmount"::DECIMAL(14,2);
