-- Baseline of the PRODUCTION database as it actually stood on 2026-08-14.
--
-- This is a squashed baseline, not a change. Production already contains every
-- object below; the migration is marked applied there with
-- `prisma migrate resolve --applied 20260814000000_baseline_production`
-- and must never be executed against production.
--
-- It is generated FROM PRODUCTION (`migrate diff --from-empty
-- --to-schema-datasource`), not from schema.prisma, so that the recorded
-- history is literally true. schema.prisma is currently slightly AHEAD of
-- production (a handful of indexes and foreign keys — see the follow-up
-- issue); that gap is closed by the NEXT migration, not by this one.
--
-- History note: production's _prisma_migrations previously held a single
-- orphaned row, 20260307033916_init, whose SQL was lost from the repository.
-- It was removed as part of applying this baseline.

-- CreateTable
CREATE TABLE "ActivityLog" (
    "id" TEXT NOT NULL,
    "projectId" TEXT,
    "actorType" TEXT NOT NULL,
    "actorName" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "entityName" TEXT,
    "metadata" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leadId" TEXT,
    "actorUserId" TEXT,

    CONSTRAINT "ActivityLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actorId" TEXT,
    "actorEmail" TEXT,
    "snapshot" JSONB,
    "createdAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationEvent" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "stage" TEXT,
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "source" TEXT,
    "vendor" TEXT,
    "projectName" TEXT,
    "docNumber" TEXT,
    "fileName" TEXT,
    "amountCents" INTEGER,
    "taxCents" INTEGER,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "qbPurchaseId" TEXT,
    "driveFileId" TEXT,

    CONSTRAINT "AutomationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationSetting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutomationSetting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "BidInvitation" (
    "id" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "subcontractorId" TEXT,
    "email" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Invited',
    "bidAmount" DECIMAL(65,30),
    "notes" TEXT,
    "sentAt" TIMESTAMP(3),
    "respondedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BidInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BidPackage" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "dueDate" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'Draft',
    "totalBudget" DECIMAL(65,30),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BidPackage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BidScope" (
    "id" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "budgetAmount" DECIMAL(65,30),
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BidScope_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Budget" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "estimateId" TEXT NOT NULL,
    "totalLaborBudget" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "totalMaterialBudget" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Budget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogFinish" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "hex" TEXT NOT NULL,
    "vendor" TEXT,
    "sku" TEXT,
    "priceNote" TEXT,
    "notes" TEXT,
    "sourceUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CatalogFinish_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogItem" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "unitCost" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "unit" TEXT NOT NULL DEFAULT 'each',
    "costCodeId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "imageUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogProduct" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "vendor" TEXT,
    "sku" TEXT,
    "category" TEXT NOT NULL,
    "mesh" TEXT NOT NULL,
    "widthIn" DOUBLE PRECISION NOT NULL,
    "depthIn" DOUBLE PRECISION NOT NULL,
    "heightIn" DOUBLE PRECISION NOT NULL,
    "mount" TEXT NOT NULL DEFAULT 'floor',
    "elevationIn" DOUBLE PRECISION,
    "price" DECIMAL(12,2),
    "finishes" JSONB,
    "sourceUrl" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CatalogProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChangeOrder" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "estimateId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Draft',
    "totalAmount" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "balanceDue" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "termsAndConditions" TEXT,
    "memos" TEXT,
    "clientSignatureUrl" TEXT,
    "companySignatureUrl" TEXT,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "viewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "number" SERIAL NOT NULL,
    "companySignedBy" TEXT,
    "companySignedAt" TIMESTAMP(3),
    "pricingType" TEXT NOT NULL DEFAULT 'FIXED',
    "markupPercent" DOUBLE PRECISION,

    CONSTRAINT "ChangeOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChangeOrderBilling" (
    "id" TEXT NOT NULL,
    "changeOrderId" TEXT NOT NULL,
    "paymentScheduleId" TEXT,
    "label" TEXT NOT NULL,
    "laborCents" INTEGER NOT NULL,
    "expenseCents" INTEGER NOT NULL,
    "markupCents" INTEGER NOT NULL,
    "taxCents" INTEGER NOT NULL,
    "totalCents" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "ChangeOrderBilling_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChangeOrderItem" (
    "id" TEXT NOT NULL,
    "changeOrderId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" TEXT NOT NULL DEFAULT 'Material',
    "quantity" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "baseCost" DECIMAL(65,30),
    "markupPercent" DOUBLE PRECISION NOT NULL DEFAULT 25,
    "unitCost" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "total" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "order" INTEGER NOT NULL DEFAULT 0,
    "costCodeId" TEXT,
    "costTypeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChangeOrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChangeOrderPaymentSchedule" (
    "id" TEXT NOT NULL,
    "changeOrderId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL,
    "dueDate" TIMESTAMP(3),
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "scheduleTaskId" TEXT,

    CONSTRAINT "ChangeOrderPaymentSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatConversation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatDelivery" (
    "id" TEXT NOT NULL,
    "publicationId" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'dispatch_publication',
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "claimToken" TEXT,
    "processingStartedAt" TIMESTAMP(3),
    "providerMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "ChatDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatMessage" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Client" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "initials" TEXT NOT NULL,
    "email" TEXT,
    "companyName" TEXT,
    "primaryPhone" TEXT,
    "additionalEmail" TEXT,
    "additionalPhone" TEXT,
    "addressLine1" TEXT,
    "addressLine2" TEXT,
    "city" TEXT,
    "state" TEXT,
    "zipCode" TEXT,
    "country" TEXT,
    "internalNotes" TEXT,
    "primaryPhoneE164" TEXT,
    "additionalPhoneE164" TEXT,
    "qbCustomerId" TEXT,
    "deletedAt" TIMESTAMP(6),
    "deletedById" TEXT,
    "deleteBatchId" TEXT,
    "taxExemptCertUrl" TEXT,
    "taxExemptCertExpiresAt" TIMESTAMP(3),
    "taxExemptCertNote" TEXT,

    CONSTRAINT "Client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientMessage" (
    "id" TEXT NOT NULL,
    "leadId" TEXT,
    "direction" TEXT NOT NULL,
    "senderName" TEXT NOT NULL,
    "senderEmail" TEXT,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'email',
    "attachments" TEXT,
    "sentViaEmail" BOOLEAN NOT NULL DEFAULT false,
    "sentViaSms" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ccEmails" TEXT,
    "scheduledFor" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'SENT',
    "projectId" TEXT,
    "readAt" TIMESTAMPTZ(6),
    "twilioMessageSid" TEXT,
    "clientId" TEXT,

    CONSTRAINT "LeadMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClippedImport" (
    "id" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "title" TEXT,
    "text" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClippedImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanySettings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "companyName" TEXT NOT NULL DEFAULT 'My Construction Co.',
    "address" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "website" TEXT,
    "logoUrl" TEXT,
    "notificationEmail" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "projectStatuses" TEXT,
    "enableAffirm" BOOLEAN NOT NULL DEFAULT false,
    "enableBankTransfer" BOOLEAN NOT NULL DEFAULT false,
    "enableCard" BOOLEAN NOT NULL DEFAULT true,
    "enableKlarna" BOOLEAN NOT NULL DEFAULT false,
    "stripeEnabled" BOOLEAN NOT NULL DEFAULT false,
    "cardProcessingFlat" DECIMAL(65,30) NOT NULL DEFAULT 0.30,
    "cardProcessingRate" DECIMAL(65,30) NOT NULL DEFAULT 2.9,
    "passProcessingFee" BOOLEAN NOT NULL DEFAULT false,
    "subcontractorTrades" TEXT,
    "workDays" TEXT,
    "workdayStart" TEXT,
    "workdayEnd" TEXT,
    "salesTaxes" TEXT,
    "licenseNumber" TEXT,
    "notificationToggles" TEXT,
    "letterheadMode" TEXT DEFAULT 'built_in',
    "letterheadImageUrl" TEXT,
    "letterheadLogoPosition" TEXT DEFAULT 'left',
    "letterheadFields" TEXT DEFAULT '["name","address","phone","email","license"]',
    "letterheadAccentColor" TEXT DEFAULT '#4F46E5',
    "letterheadDivider" BOOLEAN NOT NULL DEFAULT true,
    "monthlyOverhead" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "googleDriveRefreshToken" TEXT,
    "googleDriveEmail" TEXT,
    "requireContractCountersign" BOOLEAN NOT NULL DEFAULT false,
    "timeZone" TEXT NOT NULL DEFAULT 'America/Los_Angeles',

    CONSTRAINT "CompanySettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Contract" (
    "id" TEXT NOT NULL,
    "projectId" TEXT,
    "leadId" TEXT,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Draft',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "approvalIp" TEXT,
    "approvalUserAgent" TEXT,
    "approvedAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    "sentAt" TIMESTAMP(3),
    "signatureUrl" TEXT,
    "viewedAt" TIMESTAMP(3),
    "nextDueDate" TIMESTAMP(3),
    "recurringDays" INTEGER,
    "number" SERIAL NOT NULL,
    "contractorSignedBy" TEXT,
    "contractorSignedAt" TIMESTAMPTZ(6),
    "contractorSignatureUrl" TEXT,
    "accessToken" TEXT,
    "requiresCountersign" BOOLEAN NOT NULL DEFAULT false,
    "companySignedBy" TEXT,
    "companySignedAt" TIMESTAMP(3),
    "companySignatureUrl" TEXT,
    "signedPdfPath" TEXT,
    "originalPdfPath" TEXT,

    CONSTRAINT "Contract_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContractSigningRecord" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "signedBy" TEXT NOT NULL,
    "signedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "signatureUrl" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContractSigningRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CostCode" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CostCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CostType" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CostType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyLog" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "weather" TEXT,
    "crewOnSite" TEXT,
    "workPerformed" TEXT NOT NULL,
    "materialsDelivered" TEXT,
    "issues" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "sharedToPortal" BOOLEAN NOT NULL DEFAULT false,
    "sharedContentHash" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "chatMessageName" TEXT,
    "nextSteps" TEXT,
    "aiSuggestedTaskId" TEXT,
    "aiSuggestionReason" TEXT,

    CONSTRAINT "DailyLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyLogPhoto" (
    "id" TEXT NOT NULL,
    "dailyLogId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "caption" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sharedToPortal" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "DailyLogPhoto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Decision" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "area" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Open',
    "chosenItemId" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "templateKey" TEXT,
    "createdByClient" BOOLEAN NOT NULL DEFAULT false,
    "decidedAt" TIMESTAMP(3),
    "pmNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),
    "scheduleTaskId" TEXT,
    "leadTimeDays" INTEGER,
    "dueDate" TIMESTAMP(3),
    "orderedAt" TIMESTAMP(3),
    "orderedBy" TEXT,
    "expectedArrivalAt" TIMESTAMP(3),

    CONSTRAINT "Decision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DecisionTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "DecisionTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DecisionTemplateItem" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "area" TEXT,
    "defaultLeadTimeDays" INTEGER,
    "costCodeId" TEXT,
    "stageHint" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "order" INTEGER NOT NULL DEFAULT 0,
    "scheduleHint" TEXT,

    CONSTRAINT "DecisionTemplateItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DepositIngest" (
    "id" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "extracted" TEXT NOT NULL,
    "paymentScheduleId" TEXT,
    "qbPaymentId" TEXT,
    "qbRequestPayload" TEXT,
    "settleStartedAt" TIMESTAMP(3),
    "officeTaskId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "processingStartedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DepositIngest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DispatchPublication" (
    "id" TEXT NOT NULL,
    "clientRequestId" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "publishedById" TEXT,
    "publishedByName" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DispatchPublication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DispatchPublicationChange" (
    "id" TEXT NOT NULL,
    "publicationId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "projectId" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "before" JSONB NOT NULL,
    "after" JSONB NOT NULL,
    "summary" TEXT NOT NULL,

    CONSTRAINT "DispatchPublicationChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentComment" (
    "id" TEXT NOT NULL,
    "documentType" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "visibility" TEXT NOT NULL DEFAULT 'team',
    "authorId" TEXT,
    "authorName" TEXT,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'terms',
    "body" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Estimate" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "projectId" TEXT,
    "leadId" TEXT,
    "code" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Sent',
    "privacy" TEXT NOT NULL DEFAULT 'Shared',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "totalAmount" DECIMAL(65,30) NOT NULL,
    "balanceDue" DECIMAL(65,30) NOT NULL,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "approvalIp" TEXT,
    "approvalUserAgent" TEXT,
    "signatureUrl" TEXT,
    "contractId" TEXT,
    "viewedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "termsAndConditions" TEXT,
    "number" SERIAL NOT NULL,
    "processingFeeMarkup" DECIMAL(65,30),
    "hideProcessingFee" BOOLEAN NOT NULL DEFAULT true,
    "expirationDate" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "memo" TEXT,
    "targetMarginPercent" DOUBLE PRECISION NOT NULL DEFAULT 25,
    "taxExempt" BOOLEAN NOT NULL DEFAULT false,
    "taxRateName" TEXT,
    "taxRatePercent" DECIMAL,
    "statusBeforePayment" TEXT,
    "qbEstimateId" TEXT,
    "qbSyncedAt" TIMESTAMP(6),
    "deletedAt" TIMESTAMP(6),
    "deletedById" TEXT,
    "deleteBatchId" TEXT,
    "overviewEnabled" BOOLEAN NOT NULL DEFAULT false,
    "overviewTitle" TEXT,
    "overviewBody" TEXT,
    "notesEnabled" BOOLEAN NOT NULL DEFAULT false,
    "notesTitle" TEXT,
    "notesBody" TEXT,
    "notesPlacement" TEXT NOT NULL DEFAULT 'after',
    "taxInclusiveMilestones" BOOLEAN NOT NULL DEFAULT true,
    "itemsRevision" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Estimate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EstimateFile" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "estimateId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EstimateFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EstimateItem" (
    "id" TEXT NOT NULL,
    "estimateId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" TEXT NOT NULL DEFAULT 'Material',
    "quantity" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "unitCost" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "total" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "order" INTEGER NOT NULL DEFAULT 0,
    "parentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "costCodeId" TEXT,
    "costTypeId" TEXT,
    "baseCost" DECIMAL(65,30),
    "markupPercent" DOUBLE PRECISION NOT NULL DEFAULT 25,
    "approvalStatus" TEXT,
    "approvalNote" TEXT,
    "purchaseOrderId" TEXT,
    "budgetQuantity" DOUBLE PRECISION,
    "budgetUnit" TEXT,
    "budgetRate" DECIMAL(65,30),
    "deletedAt" TIMESTAMP(6),
    "deleteBatchId" TEXT,

    CONSTRAINT "EstimateItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EstimateItemPurchaseOrder" (
    "id" TEXT NOT NULL,
    "estimateItemId" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EstimateItemPurchaseOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EstimatePaymentSchedule" (
    "id" TEXT NOT NULL,
    "estimateId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "percentage" DOUBLE PRECISION,
    "amount" DECIMAL(65,30) NOT NULL,
    "dueDate" TIMESTAMP(3),
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'Pending',
    "stripeSessionId" TEXT,
    "stripePaymentIntentId" TEXT,
    "paymentMethod" TEXT,
    "paidAt" TIMESTAMPTZ(6),
    "paymentDate" TIMESTAMPTZ(6),
    "referenceNumber" TEXT,
    "notes" TEXT,
    "receiptSentAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(6),
    "deleteBatchId" TEXT,
    "scheduleTaskId" TEXT,

    CONSTRAINT "EstimatePaymentSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EstimateTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'custom',

    CONSTRAINT "EstimateTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EstimateTemplateItem" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" TEXT NOT NULL DEFAULT 'Material',
    "quantity" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "baseCost" DECIMAL(65,30),
    "markupPercent" DOUBLE PRECISION NOT NULL DEFAULT 25,
    "unitCost" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "order" INTEGER NOT NULL DEFAULT 0,
    "parentId" TEXT,
    "costCodeId" TEXT,
    "costTypeId" TEXT,

    CONSTRAINT "EstimateTemplateItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Expense" (
    "id" TEXT NOT NULL,
    "estimateId" TEXT NOT NULL,
    "itemId" TEXT,
    "amount" DECIMAL(65,30) NOT NULL,
    "vendor" TEXT,
    "date" TIMESTAMP(3),
    "description" TEXT,
    "receiptUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "costCodeId" TEXT,
    "costTypeId" TEXT,
    "purchaseOrderId" TEXT,
    "changeOrderId" TEXT,
    "isBillable" BOOLEAN NOT NULL DEFAULT false,
    "invoiceId" TEXT,
    "invoicedAt" TIMESTAMP(3),
    "qbPurchaseId" TEXT,
    "qbSyncToken" TEXT,
    "qbSyncedAt" TIMESTAMPTZ(6),

    CONSTRAINT "Expense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FileFolder" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "projectId" TEXT,
    "leadId" TEXT,
    "parentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "visibility" TEXT NOT NULL DEFAULT 'team',

    CONSTRAINT "FileFolder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HelpRequest" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'help',
    "question" TEXT NOT NULL,
    "response" TEXT,
    "currentPage" TEXT,
    "status" TEXT DEFAULT 'open',
    "slackMessageTs" TEXT,
    "completedAt" TIMESTAMPTZ(6),
    "verifiedAt" TIMESTAMPTZ(6),
    "changeDescription" TEXT,
    "changeLocation" TEXT,
    "externalIssueRef" TEXT,
    "conversationId" TEXT,
    "createdAt" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HelpRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Integration" (
    "id" TEXT NOT NULL,
    "settings" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Integration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Draft',
    "totalAmount" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "balanceDue" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "issueDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    "sentAt" TIMESTAMP(3),
    "viewedAt" TIMESTAMP(3),
    "number" SERIAL NOT NULL,
    "subtotal" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "taxRate" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "taxAmount" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "qbInvoiceId" TEXT,
    "qbSyncedAt" TIMESTAMP(6),
    "estimateId" TEXT,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lead" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "stage" TEXT NOT NULL DEFAULT 'New',
    "source" TEXT,
    "projectType" TEXT,
    "location" TEXT,
    "targetRevenue" DECIMAL(65,30),
    "expectedStartDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "message" TEXT,
    "expectedProfit" DECIMAL(65,30),
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "isUnread" BOOLEAN NOT NULL DEFAULT true,
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "managerId" TEXT,
    "snoozedUntil" TIMESTAMP(3),
    "tags" TEXT,
    "number" SERIAL NOT NULL,
    "deletedAt" TIMESTAMP(6),
    "deletedById" TEXT,
    "deleteBatchId" TEXT,
    "driveFolderId" TEXT,
    "driveFolderUrl" TEXT,

    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadMeeting" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "meetingType" TEXT NOT NULL DEFAULT 'Video Call',
    "duration" INTEGER NOT NULL DEFAULT 60,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "location" TEXT,
    "videoApp" TEXT,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Scheduled',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeadMeeting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadNote" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeadNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadTask" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'To Do',
    "dueDate" TIMESTAMP(3),
    "tags" TEXT,
    "assigneeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeadTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpConfirmation" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "argsHash" TEXT NOT NULL,
    "preview" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "actorLabel" TEXT NOT NULL DEFAULT 'justin-ai',

    CONSTRAINT "McpConfirmation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpKey" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "McpKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "senderType" TEXT NOT NULL,
    "senderName" TEXT NOT NULL,
    "senderEmail" TEXT,
    "body" TEXT NOT NULL,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageThread" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "subcontractorId" TEXT,

    CONSTRAINT "MessageThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MoodBoard" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MoodBoard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MoodBoardItem" (
    "id" TEXT NOT NULL,
    "moodBoardId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "x" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "y" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "width" DOUBLE PRECISION NOT NULL DEFAULT 200,
    "height" DOUBLE PRECISION NOT NULL DEFAULT 200,
    "zIndex" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "addedByClient" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "MoodBoardItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'info',
    "title" TEXT NOT NULL,
    "body" TEXT,
    "projectId" TEXT,
    "timeEntryId" TEXT,
    "expenseId" TEXT,
    "actorId" TEXT,
    "dedupeKey" TEXT,
    "channels" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OfficeBoardColumn" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "isDoneColumn" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OfficeBoardColumn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OfficeTask" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'To Do',
    "position" INTEGER NOT NULL DEFAULT 0,
    "dueDate" TIMESTAMP(3),
    "assigneeId" TEXT,
    "aiPrompt" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "automationGap" TEXT,
    "columnId" TEXT,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "OfficeTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentNotification" (
    "id" TEXT NOT NULL,
    "scheduleId" TEXT NOT NULL,
    "scheduleType" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'milestone_paid',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "claimToken" TEXT,
    "processingStartedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "PaymentNotification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentSchedule" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Pending',
    "dueDate" TIMESTAMP(3),
    "paymentDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" TIMESTAMP(3),
    "paymentMethod" TEXT,
    "stripePaymentIntentId" TEXT,
    "stripeSessionId" TEXT,
    "referenceNumber" TEXT,
    "notes" TEXT,
    "receiptSentAt" TIMESTAMP(3),
    "qbInvoiceId" TEXT,
    "qbInvoiceLink" TEXT,
    "qbPaymentId" TEXT,
    "qbSyncedAt" TIMESTAMP(3),
    "sourceScheduleId" TEXT,
    "qbInvoiceSentAt" TIMESTAMP(3),
    "qbSyncError" TEXT,
    "lastReminderAt" TIMESTAMPTZ(6),
    "scheduleTaskId" TEXT,
    "pretaxAmount" DECIMAL(65,30),
    "taxAmount" DECIMAL(65,30),
    "sourceChangeOrderId" TEXT,
    "sourceCoScheduleId" TEXT,

    CONSTRAINT "PaymentSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Permit" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "permitNumber" TEXT NOT NULL,
    "type" TEXT,
    "status" TEXT NOT NULL DEFAULT 'applied',
    "issuingAuthority" TEXT,
    "issueDate" TIMESTAMP(3),
    "expirationDate" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Permit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PortalVisibility" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "showSchedule" BOOLEAN NOT NULL DEFAULT true,
    "showFiles" BOOLEAN NOT NULL DEFAULT true,
    "showDailyLogs" BOOLEAN NOT NULL DEFAULT false,
    "showEstimates" BOOLEAN NOT NULL DEFAULT true,
    "showInvoices" BOOLEAN NOT NULL DEFAULT true,
    "showContracts" BOOLEAN NOT NULL DEFAULT true,
    "showMessages" BOOLEAN NOT NULL DEFAULT true,
    "showChangeOrders" BOOLEAN NOT NULL DEFAULT true,
    "isPortalEnabled" BOOLEAN NOT NULL DEFAULT true,
    "lastShareEmailId" TEXT,
    "lastShareEmailStatus" TEXT,
    "lastSharedAt" TIMESTAMP(3),
    "showSelections" BOOLEAN NOT NULL DEFAULT true,
    "showMoodBoards" BOOLEAN NOT NULL DEFAULT true,
    "showPermits" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "PortalVisibility_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductLibraryItem" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "imageUrl" TEXT,
    "price" DECIMAL(12,2),
    "vendor" TEXT,
    "vendorUrl" TEXT,
    "category" TEXT,
    "source" TEXT NOT NULL DEFAULT 'clip',
    "clippedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductLibraryItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProgressBilling" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Draft',
    "subtotal" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "taxExempt" BOOLEAN NOT NULL DEFAULT false,
    "taxRate" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "taxAmount" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "total" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "qbInvoiceId" TEXT,
    "qbInvoiceLink" TEXT,
    "qbInvoiceSentAt" TIMESTAMP(3),
    "qbPaymentId" TEXT,
    "qbSyncedAt" TIMESTAMP(3),
    "qbSyncError" TEXT,
    "sentAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProgressBilling_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProgressBillingLine" (
    "id" TEXT NOT NULL,
    "billingId" TEXT NOT NULL,
    "scheduleId" TEXT,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL,
    "splitAmount" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ProgressBillingLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "viewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "location" TEXT,
    "status" TEXT NOT NULL DEFAULT 'In Progress',
    "type" TEXT,
    "code" TEXT,
    "tags" TEXT,
    "managerId" TEXT,
    "leadId" TEXT,
    "color" TEXT DEFAULT '#3b82f6',
    "number" SERIAL NOT NULL,
    "locationLat" DOUBLE PRECISION,
    "locationLng" DOUBLE PRECISION,
    "geofenceRadiusMeters" INTEGER DEFAULT 100,
    "qbProjectId" TEXT,
    "qbSyncedAt" TIMESTAMP(6),
    "deletedAt" TIMESTAMP(6),
    "deletedById" TEXT,
    "deleteBatchId" TEXT,
    "paymentRemindersEnabled" BOOLEAN NOT NULL DEFAULT false,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "portalStageOverride" TEXT,
    "googleChatSpaceId" TEXT,
    "clientNextSteps" TEXT,
    "clientNextStepsAt" TIMESTAMP(3),
    "chatWebhookUrl" TEXT,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectAccess" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectAccess_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectFile" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "size" INTEGER NOT NULL DEFAULT 0,
    "mimeType" TEXT NOT NULL DEFAULT 'application/octet-stream',
    "projectId" TEXT,
    "leadId" TEXT,
    "folderId" TEXT,
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "visibility" TEXT,
    "uploadedByClient" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ProjectFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectProductFavorite" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "addedById" TEXT,
    "addedByClient" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectProductFavorite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrder" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Draft',
    "totalAmount" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "memos" TEXT,
    "terms" TEXT,
    "sentAt" TIMESTAMP(3),
    "viewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "approvedAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    "number" SERIAL NOT NULL,

    CONSTRAINT "PurchaseOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrderFile" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PurchaseOrderFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrderItem" (
    "id" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "unitCost" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "total" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "order" INTEGER NOT NULL DEFAULT 0,
    "costCodeId" TEXT,
    "costTypeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PurchaseOrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrderMessage" (
    "id" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "gmailMessageId" TEXT,
    "body" TEXT NOT NULL,
    "senderEmail" TEXT NOT NULL,
    "senderName" TEXT,
    "senderType" TEXT NOT NULL DEFAULT 'VENDOR',
    "isAttachment" BOOLEAN NOT NULL DEFAULT false,
    "attachmentUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PurchaseOrderMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QboPurchaseClassification" (
    "qbPurchaseId" TEXT NOT NULL,
    "classification" TEXT NOT NULL,
    "reason" TEXT,
    "qbSyncToken" TEXT,
    "classifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QboPurchaseClassification_pkey" PRIMARY KEY ("qbPurchaseId")
);

-- CreateTable
CREATE TABLE "Retainer" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Draft',
    "totalAmount" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "balanceDue" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "amountPaid" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "issueDate" TIMESTAMP(3),
    "dueDate" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "viewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Retainer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewAlertBatch" (
    "id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "claimToken" TEXT,
    "claimedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextAttemptAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "chatMessageName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewAlertBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewAlertEpisode" (
    "id" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "reasonCodes" TEXT NOT NULL,
    "reasonHash" TEXT NOT NULL,
    "displayDetails" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "claimToken" TEXT,
    "claimedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextAttemptAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "chatMessageName" TEXT,
    "batchId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewAlertEpisode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewIssue" (
    "id" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetKey" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "reasonCodes" TEXT NOT NULL,
    "reasonHash" TEXT NOT NULL,
    "displayDetails" TEXT,
    "acknowledgedCodes" TEXT NOT NULL DEFAULT '[]',
    "acknowledgedAt" TIMESTAMP(3),
    "firstObservedAt" TIMESTAMP(3) NOT NULL,
    "clearedAt" TIMESTAMP(3),
    "currentGeneration" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "absentSince" TIMESTAMP(3),

    CONSTRAINT "ReviewIssue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RolloutGate" (
    "key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "claimToken" TEXT,
    "claimedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RolloutGate_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "RoomAsset" (
    "id" TEXT NOT NULL,
    "roomDesignId" TEXT NOT NULL,
    "assetType" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "positionX" DOUBLE PRECISION NOT NULL,
    "positionY" DOUBLE PRECISION NOT NULL,
    "positionZ" DOUBLE PRECISION NOT NULL,
    "rotationY" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "scaleX" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "scaleY" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "scaleZ" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoomAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoomDesign" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "roomType" TEXT NOT NULL,
    "projectId" TEXT,
    "leadId" TEXT,
    "layoutJson" JSONB NOT NULL,
    "shareToken" TEXT,
    "shareEnabled" BOOLEAN NOT NULL DEFAULT false,
    "thumbnail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "scanUsdzUrl" TEXT,

    CONSTRAINT "RoomDesign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoomRender" (
    "id" TEXT NOT NULL,
    "roomDesignId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "style" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoomRender_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduleTask" (
    "id" TEXT NOT NULL,
    "projectId" TEXT,
    "name" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#4c9a2a',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "assignee" TEXT,
    "parentId" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'Not Started',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "estimatedHours" DOUBLE PRECISION,
    "type" TEXT NOT NULL DEFAULT 'task',
    "estimateItemId" TEXT,
    "leadId" TEXT,
    "generatedFromEstimateId" TEXT,
    "generatedFromChangeOrderId" TEXT,
    "doneWhen" TEXT,
    "blockedReason" TEXT,
    "scheduledTime" TEXT,
    "confirmationStatus" TEXT,
    "clientStage" TEXT,
    "progressSource" TEXT,

    CONSTRAINT "ScheduleTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SelectionBoard" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Draft',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SelectionBoard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SelectionCategory" (
    "id" TEXT NOT NULL,
    "boardId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SelectionCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SelectionItemComment" (
    "id" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "authorType" TEXT NOT NULL,
    "authorUserId" TEXT,
    "authorClientId" TEXT,
    "authorName" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "attachments" TEXT,
    "readByTeamAt" TIMESTAMP(3),
    "readByClientAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SelectionItemComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SelectionOption" (
    "id" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "imageUrl" TEXT,
    "price" DECIMAL(65,30),
    "vendorUrl" TEXT,
    "selected" BOOLEAN NOT NULL DEFAULT false,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SelectionOption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SelectionProposal" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "imageUrl" TEXT,
    "price" DECIMAL(12,2),
    "vendorUrl" TEXT,
    "clientNote" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Idea',
    "pmNote" TEXT,
    "productId" TEXT,
    "boardId" TEXT,
    "categoryId" TEXT,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decisionId" TEXT,
    "deletedAt" TIMESTAMP(3),
    "suggestedDecisionId" TEXT,
    "suggestedAt" TIMESTAMP(3),

    CONSTRAINT "SelectionProposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StripeEvent" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StripeEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubTaskAssignment" (
    "id" TEXT NOT NULL,
    "subcontractorId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubTaskAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subcontractor" (
    "id" TEXT NOT NULL,
    "companyName" TEXT NOT NULL,
    "contactName" TEXT,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "trade" TEXT,
    "licenseNumber" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "coiFileUrl" TEXT,
    "coiExpiresAt" TIMESTAMP(3),
    "coiUploaded" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "addressLine1" TEXT,
    "addressLine2" TEXT,
    "city" TEXT,
    "country" TEXT,
    "firstName" TEXT,
    "internalNotes" TEXT,
    "lastName" TEXT,
    "state" TEXT,
    "website" TEXT,
    "zip" TEXT,

    CONSTRAINT "Subcontractor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubcontractorProjectAccess" (
    "id" TEXT NOT NULL,
    "subcontractorId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "viewedAt" TIMESTAMP(3),

    CONSTRAINT "SubcontractorProjectAccess_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Takeoff" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Draft',
    "projectId" TEXT,
    "leadId" TEXT,
    "aiEstimateData" TEXT,
    "estimateId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Takeoff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TakeoffFile" (
    "id" TEXT NOT NULL,
    "takeoffId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL DEFAULT 'application/octet-stream',
    "size" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TakeoffFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskAssignment" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'assigned',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskComment" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "userId" TEXT,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "subcontractorName" TEXT,

    CONSTRAINT "TaskComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskCommentPhoto" (
    "id" TEXT NOT NULL,
    "commentId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskCommentPhoto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskDependency" (
    "id" TEXT NOT NULL,
    "predecessorId" TEXT NOT NULL,
    "dependentId" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'FS',

    CONSTRAINT "TaskDependency_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskMaterial" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "quantity" DECIMAL(65,30),
    "unit" TEXT,
    "location" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "sourceKind" TEXT NOT NULL DEFAULT 'manual',
    "sourceEstimateItemId" TEXT,
    "resolutionNote" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "statusChangedById" TEXT,
    "statusChangedAt" TIMESTAMP(3),

    CONSTRAINT "TaskMaterial_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskPunchItem" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "assignee" TEXT,
    "photoUrl" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdById" TEXT,

    CONSTRAINT "TaskPunchItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamMessage" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "authorId" TEXT,
    "authorName" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeamMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimeEntry" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3),
    "durationHours" DOUBLE PRECISION,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "laborCost" DECIMAL(65,30),
    "burdenCost" DECIMAL(65,30),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "editedByManagerId" TEXT,
    "editedAt" TIMESTAMP(3),
    "costCodeId" TEXT,
    "costTypeId" TEXT,
    "scheduleTaskId" TEXT,
    "estimateItemId" TEXT,
    "isEdited" BOOLEAN NOT NULL DEFAULT false,
    "originalStartTime" TIMESTAMP(3),
    "originalEndTime" TIMESTAMP(3),
    "editNotes" TEXT,
    "offsiteMs" INTEGER NOT NULL DEFAULT 0,
    "isOffsite" BOOLEAN NOT NULL DEFAULT false,
    "lastLocationCheck" TIMESTAMP(3),
    "invoicedAt" TIMESTAMP(3),
    "mealSkipped" BOOLEAN NOT NULL DEFAULT false,
    "mealDeductionHours" DOUBLE PRECISION,
    "needsReview" BOOLEAN NOT NULL DEFAULT false,
    "reviewReason" TEXT,
    "qbTimeActivityId" TEXT,
    "qbSyncedAt" TIMESTAMP(6),
    "changeOrderId" TEXT,
    "isBillable" BOOLEAN NOT NULL DEFAULT false,
    "invoiceId" TEXT,
    "notes" TEXT,
    "suggestedScheduleTaskId" TEXT,
    "suggestedCostCodeId" TEXT,
    "suggestedTaskName" TEXT,
    "suggestionSource" TEXT,
    "suggestionOverridden" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "TimeEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "role" TEXT NOT NULL DEFAULT 'FIELD_CREW',
    "hourlyRate" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "burdenRate" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "pinCode" TEXT,
    "invitedAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "fieldUpdatesSeenAt" TIMESTAMP(3),

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserPermission" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "manageTeamMembers" BOOLEAN NOT NULL DEFAULT false,
    "manageSubs" BOOLEAN NOT NULL DEFAULT false,
    "manageVendors" BOOLEAN NOT NULL DEFAULT false,
    "companySettings" BOOLEAN NOT NULL DEFAULT false,
    "costCodesCategories" BOOLEAN NOT NULL DEFAULT true,
    "schedules" BOOLEAN NOT NULL DEFAULT true,
    "estimates" BOOLEAN NOT NULL DEFAULT false,
    "invoices" BOOLEAN NOT NULL DEFAULT false,
    "contracts" BOOLEAN NOT NULL DEFAULT false,
    "roomDesigner" BOOLEAN NOT NULL DEFAULT true,
    "changeOrders" BOOLEAN NOT NULL DEFAULT false,
    "financialReports" BOOLEAN NOT NULL DEFAULT false,
    "timeClock" BOOLEAN NOT NULL DEFAULT true,
    "dailyLogs" BOOLEAN NOT NULL DEFAULT true,
    "files" BOOLEAN NOT NULL DEFAULT true,
    "takeoffs" BOOLEAN NOT NULL DEFAULT false,
    "createLead" BOOLEAN NOT NULL DEFAULT false,
    "clientCommunication" BOOLEAN NOT NULL DEFAULT false,
    "leadAccess" BOOLEAN NOT NULL DEFAULT false,
    "autoGrantNewProjects" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "UserPermission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vendor" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "accountNumber" TEXT,
    "address1" TEXT,
    "address2" TEXT,
    "chargesTax" BOOLEAN NOT NULL DEFAULT false,
    "city" TEXT,
    "country" TEXT,
    "description" TEXT,
    "ein" TEXT,
    "fax" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "paymentTerms" TEXT,
    "state" TEXT,
    "website" TEXT,
    "zipCode" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',

    CONSTRAINT "Vendor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorFile" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "size" INTEGER,
    "type" TEXT,
    "vendorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VendorFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorTag" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VendorTag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_CrewAssignments" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "_VendorToVendorTag" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL
);

-- CreateIndex
CREATE INDEX "ActivityLog_actorUserId_createdAt_idx" ON "ActivityLog"("actorUserId" ASC, "createdAt" ASC);

-- CreateIndex
CREATE INDEX "ActivityLog_entityType_entityId_idx" ON "ActivityLog"("entityType" ASC, "entityId" ASC);

-- CreateIndex
CREATE INDEX "ActivityLog_leadId_createdAt_idx" ON "ActivityLog"("leadId" ASC, "createdAt" ASC);

-- CreateIndex
CREATE INDEX "ActivityLog_projectId_createdAt_idx" ON "ActivityLog"("projectId" ASC, "createdAt" ASC);

-- CreateIndex
CREATE INDEX "AuditLog_action_idx" ON "AuditLog"("action" ASC);

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt" ASC);

-- CreateIndex
CREATE INDEX "AuditLog_entity_entityId_idx" ON "AuditLog"("entity" ASC, "entityId" ASC);

-- CreateIndex
CREATE INDEX "AutomationEvent_createdAt_idx" ON "AutomationEvent"("createdAt" ASC);

-- CreateIndex
CREATE INDEX "AutomationEvent_docNumber_createdAt_idx" ON "AutomationEvent"("docNumber" ASC, "createdAt" ASC);

-- CreateIndex
CREATE INDEX "AutomationEvent_kind_createdAt_idx" ON "AutomationEvent"("kind" ASC, "createdAt" ASC);

-- CreateIndex
CREATE INDEX "BidPackage_projectId_idx" ON "BidPackage"("projectId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "Budget_estimateId_key" ON "Budget"("estimateId" ASC);

-- CreateIndex
CREATE INDEX "CatalogFinish_kind_idx" ON "CatalogFinish"("kind" ASC);

-- CreateIndex
CREATE INDEX "CatalogProduct_category_idx" ON "CatalogProduct"("category" ASC);

-- CreateIndex
CREATE INDEX "ChangeOrder_projectId_idx" ON "ChangeOrder"("projectId" ASC);

-- CreateIndex
CREATE INDEX "ChangeOrderBilling_changeOrderId_idx" ON "ChangeOrderBilling"("changeOrderId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "ChangeOrderBilling_paymentScheduleId_key" ON "ChangeOrderBilling"("paymentScheduleId" ASC);

-- CreateIndex
CREATE INDEX "ChangeOrderPaymentSchedule_scheduleTaskId_idx" ON "ChangeOrderPaymentSchedule"("scheduleTaskId" ASC);

-- CreateIndex
CREATE INDEX "ChatConversation_userId_archivedAt_idx" ON "ChatConversation"("userId" ASC, "archivedAt" ASC);

-- CreateIndex
CREATE INDEX "ChatConversation_userId_idx" ON "ChatConversation"("userId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "ChatDelivery_pub_dest_kind_key" ON "ChatDelivery"("publicationId" ASC, "destination" ASC, "kind" ASC);

-- CreateIndex
CREATE INDEX "ChatDelivery_publicationId_idx" ON "ChatDelivery"("publicationId" ASC);

-- CreateIndex
CREATE INDEX "ChatDelivery_status_createdAt_idx" ON "ChatDelivery"("status" ASC, "createdAt" ASC);

-- CreateIndex
CREATE INDEX "ChatDelivery_status_processingStartedAt_idx" ON "ChatDelivery"("status" ASC, "processingStartedAt" ASC);

-- CreateIndex
CREATE INDEX "ChatMessage_conversationId_idx" ON "ChatMessage"("conversationId" ASC);

-- CreateIndex
CREATE INDEX "Client_additionalPhoneE164_idx" ON "Client"("additionalPhoneE164" ASC);

-- CreateIndex
CREATE INDEX "Client_deletedAt_idx" ON "Client"("deletedAt" ASC);

-- CreateIndex
CREATE INDEX "Client_primaryPhoneE164_idx" ON "Client"("primaryPhoneE164" ASC);

-- CreateIndex
CREATE INDEX "ClientMessage_clientId_idx" ON "ClientMessage"("clientId" ASC);

-- CreateIndex
CREATE INDEX "ClientMessage_projectId_idx" ON "ClientMessage"("projectId" ASC);

-- CreateIndex
CREATE INDEX "ClientMessage_readAt_idx" ON "ClientMessage"("readAt" ASC);

-- CreateIndex
CREATE INDEX "ClippedImport_status_createdAt_idx" ON "ClippedImport"("status" ASC, "createdAt" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "Contract_accessToken_key" ON "Contract"("accessToken" ASC);

-- CreateIndex
CREATE INDEX "Contract_leadId_idx" ON "Contract"("leadId" ASC);

-- CreateIndex
CREATE INDEX "Contract_projectId_idx" ON "Contract"("projectId" ASC);

-- CreateIndex
CREATE INDEX "ContractSigningRecord_contractId_idx" ON "ContractSigningRecord"("contractId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "CostCode_code_key" ON "CostCode"("code" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "CostType_name_key" ON "CostType"("name" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "DailyLog_chatMessageName_key" ON "DailyLog"("chatMessageName" ASC);

-- CreateIndex
CREATE INDEX "DailyLog_projectId_idx" ON "DailyLog"("projectId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "DailyLogPhoto_dailyLogId_url_key" ON "DailyLogPhoto"("dailyLogId" ASC, "url" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "Decision_chosenItemId_key" ON "Decision"("chosenItemId" ASC);

-- CreateIndex
CREATE INDEX "Decision_projectId_status_idx" ON "Decision"("projectId" ASC, "status" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "Decision_projectId_templateKey_key" ON "Decision"("projectId" ASC, "templateKey" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "DecisionTemplate_name_key" ON "DecisionTemplate"("name" ASC);

-- CreateIndex
CREATE INDEX "DecisionTemplateItem_templateId_idx" ON "DecisionTemplateItem"("templateId" ASC);

-- CreateIndex
CREATE INDEX "DecisionTemplateItem_templateId_order_idx" ON "DecisionTemplateItem"("templateId" ASC, "order" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "DepositIngest_fileId_key" ON "DepositIngest"("fileId" ASC);

-- CreateIndex
CREATE INDEX "DepositIngest_paymentScheduleId_idx" ON "DepositIngest"("paymentScheduleId" ASC);

-- CreateIndex
CREATE INDEX "DepositIngest_status_idx" ON "DepositIngest"("status" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "DispatchPublication_clientRequestId_key" ON "DispatchPublication"("clientRequestId" ASC);

-- CreateIndex
CREATE INDEX "DispatchPublication_publishedAt_idx" ON "DispatchPublication"("publishedAt" ASC);

-- CreateIndex
CREATE INDEX "DispatchPublication_publishedById_idx" ON "DispatchPublication"("publishedById" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "DispatchChange_pub_position_key" ON "DispatchPublicationChange"("publicationId" ASC, "position" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "DispatchChange_pub_target_kind_key" ON "DispatchPublicationChange"("publicationId" ASC, "kind" ASC, "targetType" ASC, "targetId" ASC);

-- CreateIndex
CREATE INDEX "DispatchPublicationChange_projectId_idx" ON "DispatchPublicationChange"("projectId" ASC);

-- CreateIndex
CREATE INDEX "DispatchPublicationChange_publicationId_idx" ON "DispatchPublicationChange"("publicationId" ASC);

-- CreateIndex
CREATE INDEX "DispatchPublicationChange_targetType_targetId_idx" ON "DispatchPublicationChange"("targetType" ASC, "targetId" ASC);

-- CreateIndex
CREATE INDEX "DocumentComment_documentType_documentId_idx" ON "DocumentComment"("documentType" ASC, "documentId" ASC);

-- CreateIndex
CREATE INDEX "Estimate_createdAt_idx" ON "Estimate"("createdAt" ASC);

-- CreateIndex
CREATE INDEX "Estimate_deletedAt_idx" ON "Estimate"("deletedAt" ASC);

-- CreateIndex
CREATE INDEX "Estimate_leadId_idx" ON "Estimate"("leadId" ASC);

-- CreateIndex
CREATE INDEX "Estimate_projectId_idx" ON "Estimate"("projectId" ASC);

-- CreateIndex
CREATE INDEX "Estimate_status_idx" ON "Estimate"("status" ASC);

-- CreateIndex
CREATE INDEX "EstimateItem_deletedAt_idx" ON "EstimateItem"("deletedAt" ASC);

-- CreateIndex
CREATE INDEX "EstimateItem_estimateId_idx" ON "EstimateItem"("estimateId" ASC);

-- CreateIndex
CREATE INDEX "EstimateItem_purchaseOrderId_idx" ON "EstimateItem"("purchaseOrderId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "EstimateItemPurchaseOrder_estimateItemId_purchaseOrderId_key" ON "EstimateItemPurchaseOrder"("estimateItemId" ASC, "purchaseOrderId" ASC);

-- CreateIndex
CREATE INDEX "EstimateItemPurchaseOrder_purchaseOrderId_idx" ON "EstimateItemPurchaseOrder"("purchaseOrderId" ASC);

-- CreateIndex
CREATE INDEX "EstimatePaymentSchedule_deletedAt_idx" ON "EstimatePaymentSchedule"("deletedAt" ASC);

-- CreateIndex
CREATE INDEX "EstimatePaymentSchedule_scheduleTaskId_idx" ON "EstimatePaymentSchedule"("scheduleTaskId" ASC);

-- CreateIndex
CREATE INDEX "Expense_changeOrderId_idx" ON "Expense"("changeOrderId" ASC);

-- CreateIndex
CREATE INDEX "Expense_estimateId_idx" ON "Expense"("estimateId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "Expense_qbPurchaseId_key" ON "Expense"("qbPurchaseId" ASC);

-- CreateIndex
CREATE INDEX "FileFolder_leadId_idx" ON "FileFolder"("leadId" ASC);

-- CreateIndex
CREATE INDEX "FileFolder_parentId_idx" ON "FileFolder"("parentId" ASC);

-- CreateIndex
CREATE INDEX "FileFolder_projectId_idx" ON "FileFolder"("projectId" ASC);

-- CreateIndex
CREATE INDEX "HelpRequest_conversationId_idx" ON "HelpRequest"("conversationId" ASC);

-- CreateIndex
CREATE INDEX "HelpRequest_externalIssueRef_idx" ON "HelpRequest"("externalIssueRef" ASC);

-- CreateIndex
CREATE INDEX "Invoice_createdAt_idx" ON "Invoice"("createdAt" ASC);

-- CreateIndex
CREATE INDEX "Invoice_estimateId_idx" ON "Invoice"("estimateId" ASC);

-- CreateIndex
CREATE INDEX "Invoice_projectId_idx" ON "Invoice"("projectId" ASC);

-- CreateIndex
CREATE INDEX "Lead_clientId_idx" ON "Lead"("clientId" ASC);

-- CreateIndex
CREATE INDEX "Lead_createdAt_idx" ON "Lead"("createdAt" ASC);

-- CreateIndex
CREATE INDEX "Lead_deletedAt_idx" ON "Lead"("deletedAt" ASC);

-- CreateIndex
CREATE INDEX "Lead_stage_idx" ON "Lead"("stage" ASC);

-- CreateIndex
CREATE INDEX "McpConfirmation_expiresAt_idx" ON "McpConfirmation"("expiresAt" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "McpConfirmation_token_key" ON "McpConfirmation"("token" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "McpKey_keyHash_key" ON "McpKey"("keyHash" ASC);

-- CreateIndex
CREATE INDEX "McpKey_userId_idx" ON "McpKey"("userId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "MessageThread_projectId_subcontractorId_key" ON "MessageThread"("projectId" ASC, "subcontractorId" ASC);

-- CreateIndex
CREATE INDEX "MoodBoard_projectId_idx" ON "MoodBoard"("projectId" ASC);

-- CreateIndex
CREATE INDEX "Notification_createdAt_idx" ON "Notification"("createdAt" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "Notification_dedupeKey_key" ON "Notification"("dedupeKey" ASC);

-- CreateIndex
CREATE INDEX "Notification_projectId_idx" ON "Notification"("projectId" ASC);

-- CreateIndex
CREATE INDEX "Notification_readAt_idx" ON "Notification"("readAt" ASC);

-- CreateIndex
CREATE INDEX "OfficeTask_assigneeId_idx" ON "OfficeTask"("assigneeId" ASC);

-- CreateIndex
CREATE INDEX "OfficeTask_columnId_idx" ON "OfficeTask"("columnId" ASC);

-- CreateIndex
CREATE INDEX "OfficeTask_status_position_idx" ON "OfficeTask"("status" ASC, "position" ASC);

-- CreateIndex
CREATE INDEX "PaymentNotification_scheduleId_idx" ON "PaymentNotification"("scheduleId" ASC);

-- CreateIndex
CREATE INDEX "PaymentNotification_status_idx" ON "PaymentNotification"("status" ASC);

-- CreateIndex
CREATE INDEX "PaymentSchedule_invoiceId_idx" ON "PaymentSchedule"("invoiceId" ASC);

-- CreateIndex
CREATE INDEX "PaymentSchedule_qbInvoiceId_idx" ON "PaymentSchedule"("qbInvoiceId" ASC);

-- CreateIndex
CREATE INDEX "PaymentSchedule_scheduleTaskId_idx" ON "PaymentSchedule"("scheduleTaskId" ASC);

-- CreateIndex
CREATE INDEX "PaymentSchedule_sourceChangeOrderId_idx" ON "PaymentSchedule"("sourceChangeOrderId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "PaymentSchedule_sourceCoScheduleId_key" ON "PaymentSchedule"("sourceCoScheduleId" ASC);

-- CreateIndex
CREATE INDEX "PaymentSchedule_sourceScheduleId_idx" ON "PaymentSchedule"("sourceScheduleId" ASC);

-- CreateIndex
CREATE INDEX "PaymentSchedule_stripePaymentIntentId_idx" ON "PaymentSchedule"("stripePaymentIntentId" ASC);

-- CreateIndex
CREATE INDEX "Permit_projectId_idx" ON "Permit"("projectId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "PortalVisibility_projectId_key" ON "PortalVisibility"("projectId" ASC);

-- CreateIndex
CREATE INDEX "ProductLibraryItem_category_idx" ON "ProductLibraryItem"("category" ASC);

-- CreateIndex
CREATE INDEX "ProductLibraryItem_createdAt_idx" ON "ProductLibraryItem"("createdAt" ASC);

-- CreateIndex
CREATE INDEX "ProgressBilling_invoiceId_idx" ON "ProgressBilling"("invoiceId" ASC);

-- CreateIndex
CREATE INDEX "ProgressBilling_status_idx" ON "ProgressBilling"("status" ASC);

-- CreateIndex
CREATE INDEX "ProgressBillingLine_billingId_idx" ON "ProgressBillingLine"("billingId" ASC);

-- CreateIndex
CREATE INDEX "ProgressBillingLine_scheduleId_idx" ON "ProgressBillingLine"("scheduleId" ASC);

-- CreateIndex
CREATE INDEX "Project_clientId_idx" ON "Project"("clientId" ASC);

-- CreateIndex
CREATE INDEX "Project_createdAt_idx" ON "Project"("createdAt" ASC);

-- CreateIndex
CREATE INDEX "Project_deletedAt_idx" ON "Project"("deletedAt" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "Project_googleChatSpaceId_key" ON "Project"("googleChatSpaceId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "Project_leadId_key" ON "Project"("leadId" ASC);

-- CreateIndex
CREATE INDEX "Project_startDate_idx" ON "Project"("startDate" ASC);

-- CreateIndex
CREATE INDEX "Project_status_idx" ON "Project"("status" ASC);

-- CreateIndex
CREATE INDEX "Project_viewedAt_idx" ON "Project"("viewedAt" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "ProjectAccess_userId_projectId_key" ON "ProjectAccess"("userId" ASC, "projectId" ASC);

-- CreateIndex
CREATE INDEX "ProjectFile_folderId_idx" ON "ProjectFile"("folderId" ASC);

-- CreateIndex
CREATE INDEX "ProjectFile_leadId_idx" ON "ProjectFile"("leadId" ASC);

-- CreateIndex
CREATE INDEX "ProjectFile_projectId_idx" ON "ProjectFile"("projectId" ASC);

-- CreateIndex
CREATE INDEX "ProjectFile_projectId_visibility_idx" ON "ProjectFile"("projectId" ASC, "visibility" ASC);

-- CreateIndex
CREATE INDEX "ProjectProductFavorite_projectId_idx" ON "ProjectProductFavorite"("projectId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "ProjectProductFavorite_projectId_productId_key" ON "ProjectProductFavorite"("projectId" ASC, "productId" ASC);

-- CreateIndex
CREATE INDEX "PurchaseOrder_projectId_idx" ON "PurchaseOrder"("projectId" ASC);

-- CreateIndex
CREATE INDEX "PurchaseOrder_vendorId_idx" ON "PurchaseOrder"("vendorId" ASC);

-- CreateIndex
CREATE INDEX "PurchaseOrderItem_purchaseOrderId_idx" ON "PurchaseOrderItem"("purchaseOrderId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrderMessage_gmailMessageId_key" ON "PurchaseOrderMessage"("gmailMessageId" ASC);

-- CreateIndex
CREATE INDEX "QboPurchaseClassification_classification_idx" ON "QboPurchaseClassification"("classification" ASC);

-- CreateIndex
CREATE INDEX "Retainer_clientId_idx" ON "Retainer"("clientId" ASC);

-- CreateIndex
CREATE INDEX "Retainer_projectId_idx" ON "Retainer"("projectId" ASC);

-- CreateIndex
CREATE INDEX "ReviewAlertEpisode_batchId_idx" ON "ReviewAlertEpisode"("batchId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "ReviewAlertEpisode_issueId_generation_key" ON "ReviewAlertEpisode"("issueId" ASC, "generation" ASC);

-- CreateIndex
CREATE INDEX "ReviewIssue_clearedAt_idx" ON "ReviewIssue"("clearedAt" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "ReviewIssue_targetType_targetKey_key" ON "ReviewIssue"("targetType" ASC, "targetKey" ASC);

-- CreateIndex
CREATE INDEX "RolloutGate_status_idx" ON "RolloutGate"("status" ASC);

-- CreateIndex
CREATE INDEX "RoomAsset_roomDesignId_idx" ON "RoomAsset"("roomDesignId" ASC);

-- CreateIndex
CREATE INDEX "RoomDesign_leadId_updatedAt_idx" ON "RoomDesign"("leadId" ASC, "updatedAt" ASC);

-- CreateIndex
CREATE INDEX "RoomDesign_projectId_updatedAt_idx" ON "RoomDesign"("projectId" ASC, "updatedAt" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "RoomDesign_shareToken_key" ON "RoomDesign"("shareToken" ASC);

-- CreateIndex
CREATE INDEX "RoomRender_roomDesignId_createdAt_idx" ON "RoomRender"("roomDesignId" ASC, "createdAt" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "ScheduleTask_estimateItemId_key" ON "ScheduleTask"("estimateItemId" ASC);

-- CreateIndex
CREATE INDEX "ScheduleTask_generatedFromChangeOrderId_idx" ON "ScheduleTask"("generatedFromChangeOrderId" ASC);

-- CreateIndex
CREATE INDEX "ScheduleTask_generatedFromEstimateId_idx" ON "ScheduleTask"("generatedFromEstimateId" ASC);

-- CreateIndex
CREATE INDEX "ScheduleTask_leadId_idx" ON "ScheduleTask"("leadId" ASC);

-- CreateIndex
CREATE INDEX "ScheduleTask_projectId_idx" ON "ScheduleTask"("projectId" ASC);

-- CreateIndex
CREATE INDEX "SelectionBoard_projectId_idx" ON "SelectionBoard"("projectId" ASC);

-- CreateIndex
CREATE INDEX "SelectionItemComment_authorType_readByClientAt_idx" ON "SelectionItemComment"("authorType" ASC, "readByClientAt" ASC);

-- CreateIndex
CREATE INDEX "SelectionItemComment_authorType_readByTeamAt_idx" ON "SelectionItemComment"("authorType" ASC, "readByTeamAt" ASC);

-- CreateIndex
CREATE INDEX "SelectionItemComment_proposalId_createdAt_idx" ON "SelectionItemComment"("proposalId" ASC, "createdAt" ASC);

-- CreateIndex
CREATE INDEX "SelectionProposal_decisionId_idx" ON "SelectionProposal"("decisionId" ASC);

-- CreateIndex
CREATE INDEX "SelectionProposal_projectId_deletedAt_idx" ON "SelectionProposal"("projectId" ASC, "deletedAt" ASC);

-- CreateIndex
CREATE INDEX "SelectionProposal_projectId_status_idx" ON "SelectionProposal"("projectId" ASC, "status" ASC);

-- CreateIndex
CREATE INDEX "StripeEvent_status_idx" ON "StripeEvent"("status" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "SubTaskAssignment_subcontractorId_taskId_key" ON "SubTaskAssignment"("subcontractorId" ASC, "taskId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "Subcontractor_email_key" ON "Subcontractor"("email" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "SubcontractorProjectAccess_subcontractorId_projectId_key" ON "SubcontractorProjectAccess"("subcontractorId" ASC, "projectId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "Takeoff_estimateId_key" ON "Takeoff"("estimateId" ASC);

-- CreateIndex
CREATE INDEX "Takeoff_leadId_idx" ON "Takeoff"("leadId" ASC);

-- CreateIndex
CREATE INDEX "Takeoff_projectId_idx" ON "Takeoff"("projectId" ASC);

-- CreateIndex
CREATE INDEX "TakeoffFile_takeoffId_idx" ON "TakeoffFile"("takeoffId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "TaskAssignment_taskId_userId_key" ON "TaskAssignment"("taskId" ASC, "userId" ASC);

-- CreateIndex
CREATE INDEX "TaskCommentPhoto_commentId_idx" ON "TaskCommentPhoto"("commentId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "TaskDependency_predecessorId_dependentId_key" ON "TaskDependency"("predecessorId" ASC, "dependentId" ASC);

-- CreateIndex
CREATE INDEX "TaskMaterial_createdById_idx" ON "TaskMaterial"("createdById" ASC);

-- CreateIndex
CREATE INDEX "TaskMaterial_statusChangedById_idx" ON "TaskMaterial"("statusChangedById" ASC);

-- CreateIndex
CREATE INDEX "TaskMaterial_taskId_sourceEstimateItemId_idx" ON "TaskMaterial"("taskId" ASC, "sourceEstimateItemId" ASC);

-- CreateIndex
CREATE INDEX "TaskMaterial_taskId_status_idx" ON "TaskMaterial"("taskId" ASC, "status" ASC);

-- CreateIndex
CREATE INDEX "TaskPunchItem_createdById_idx" ON "TaskPunchItem"("createdById" ASC);

-- CreateIndex
CREATE INDEX "TeamMessage_projectId_createdAt_idx" ON "TeamMessage"("projectId" ASC, "createdAt" ASC);

-- CreateIndex
CREATE INDEX "TimeEntry_changeOrderId_idx" ON "TimeEntry"("changeOrderId" ASC);

-- CreateIndex
CREATE INDEX "TimeEntry_costCodeId_idx" ON "TimeEntry"("costCodeId" ASC);

-- CreateIndex
CREATE INDEX "TimeEntry_costTypeId_idx" ON "TimeEntry"("costTypeId" ASC);

-- CreateIndex
CREATE INDEX "TimeEntry_estimateItemId_idx" ON "TimeEntry"("estimateItemId" ASC);

-- CreateIndex
CREATE INDEX "TimeEntry_projectId_idx" ON "TimeEntry"("projectId" ASC);

-- CreateIndex
CREATE INDEX "TimeEntry_scheduleTaskId_idx" ON "TimeEntry"("scheduleTaskId" ASC);

-- CreateIndex
CREATE INDEX "TimeEntry_userId_idx" ON "TimeEntry"("userId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "UserPermission_userId_key" ON "UserPermission"("userId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "VendorTag_name_key" ON "VendorTag"("name" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "_CrewAssignments_AB_unique" ON "_CrewAssignments"("A" ASC, "B" ASC);

-- CreateIndex
CREATE INDEX "_CrewAssignments_B_index" ON "_CrewAssignments"("B" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "_VendorToVendorTag_AB_unique" ON "_VendorToVendorTag"("A" ASC, "B" ASC);

-- CreateIndex
CREATE INDEX "_VendorToVendorTag_B_index" ON "_VendorToVendorTag"("B" ASC);

-- AddForeignKey
ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BidInvitation" ADD CONSTRAINT "BidInvitation_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "BidPackage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BidPackage" ADD CONSTRAINT "BidPackage_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BidScope" ADD CONSTRAINT "BidScope_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "BidPackage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Budget" ADD CONSTRAINT "Budget_estimateId_fkey" FOREIGN KEY ("estimateId") REFERENCES "Estimate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Budget" ADD CONSTRAINT "Budget_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogItem" ADD CONSTRAINT "CatalogItem_costCodeId_fkey" FOREIGN KEY ("costCodeId") REFERENCES "CostCode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChangeOrder" ADD CONSTRAINT "ChangeOrder_estimateId_fkey" FOREIGN KEY ("estimateId") REFERENCES "Estimate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChangeOrder" ADD CONSTRAINT "ChangeOrder_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChangeOrderBilling" ADD CONSTRAINT "ChangeOrderBilling_changeOrderId_fkey" FOREIGN KEY ("changeOrderId") REFERENCES "ChangeOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChangeOrderBilling" ADD CONSTRAINT "ChangeOrderBilling_paymentScheduleId_fkey" FOREIGN KEY ("paymentScheduleId") REFERENCES "PaymentSchedule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChangeOrderItem" ADD CONSTRAINT "ChangeOrderItem_changeOrderId_fkey" FOREIGN KEY ("changeOrderId") REFERENCES "ChangeOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChangeOrderItem" ADD CONSTRAINT "ChangeOrderItem_costCodeId_fkey" FOREIGN KEY ("costCodeId") REFERENCES "CostCode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChangeOrderItem" ADD CONSTRAINT "ChangeOrderItem_costTypeId_fkey" FOREIGN KEY ("costTypeId") REFERENCES "CostType"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChangeOrderPaymentSchedule" ADD CONSTRAINT "ChangeOrderPaymentSchedule_changeOrderId_fkey" FOREIGN KEY ("changeOrderId") REFERENCES "ChangeOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChangeOrderPaymentSchedule" ADD CONSTRAINT "ChangeOrderPaymentSchedule_scheduleTaskId_fkey" FOREIGN KEY ("scheduleTaskId") REFERENCES "ScheduleTask"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatDelivery" ADD CONSTRAINT "ChatDelivery_publicationId_fkey" FOREIGN KEY ("publicationId") REFERENCES "DispatchPublication"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "ChatConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientMessage" ADD CONSTRAINT "ClientMessage_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientMessage" ADD CONSTRAINT "ClientMessage_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ClientMessage" ADD CONSTRAINT "LeadMessage_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClippedImport" ADD CONSTRAINT "ClippedImport_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contract" ADD CONSTRAINT "Contract_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contract" ADD CONSTRAINT "Contract_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractSigningRecord" ADD CONSTRAINT "ContractSigningRecord_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Contract"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyLog" ADD CONSTRAINT "DailyLog_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyLog" ADD CONSTRAINT "DailyLog_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyLogPhoto" ADD CONSTRAINT "DailyLogPhoto_dailyLogId_fkey" FOREIGN KEY ("dailyLogId") REFERENCES "DailyLog"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Decision" ADD CONSTRAINT "Decision_chosenItemId_fkey" FOREIGN KEY ("chosenItemId") REFERENCES "SelectionProposal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Decision" ADD CONSTRAINT "Decision_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DecisionTemplateItem" ADD CONSTRAINT "DecisionTemplateItem_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "DecisionTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DispatchPublication" ADD CONSTRAINT "DispatchPublication_publishedById_fkey" FOREIGN KEY ("publishedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DispatchPublicationChange" ADD CONSTRAINT "DispatchPublicationChange_publicationId_fkey" FOREIGN KEY ("publicationId") REFERENCES "DispatchPublication"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentComment" ADD CONSTRAINT "DocumentComment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Estimate" ADD CONSTRAINT "Estimate_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Contract"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Estimate" ADD CONSTRAINT "Estimate_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Estimate" ADD CONSTRAINT "Estimate_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EstimateFile" ADD CONSTRAINT "EstimateFile_estimateId_fkey" FOREIGN KEY ("estimateId") REFERENCES "Estimate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EstimateItem" ADD CONSTRAINT "EstimateItem_costCodeId_fkey" FOREIGN KEY ("costCodeId") REFERENCES "CostCode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EstimateItem" ADD CONSTRAINT "EstimateItem_costTypeId_fkey" FOREIGN KEY ("costTypeId") REFERENCES "CostType"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EstimateItem" ADD CONSTRAINT "EstimateItem_estimateId_fkey" FOREIGN KEY ("estimateId") REFERENCES "Estimate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EstimateItem" ADD CONSTRAINT "EstimateItem_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "EstimateItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EstimateItem" ADD CONSTRAINT "EstimateItem_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EstimateItemPurchaseOrder" ADD CONSTRAINT "EstimateItemPurchaseOrder_estimateItemId_fkey" FOREIGN KEY ("estimateItemId") REFERENCES "EstimateItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EstimateItemPurchaseOrder" ADD CONSTRAINT "EstimateItemPurchaseOrder_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EstimatePaymentSchedule" ADD CONSTRAINT "EstimatePaymentSchedule_estimateId_fkey" FOREIGN KEY ("estimateId") REFERENCES "Estimate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EstimatePaymentSchedule" ADD CONSTRAINT "EstimatePaymentSchedule_scheduleTaskId_fkey" FOREIGN KEY ("scheduleTaskId") REFERENCES "ScheduleTask"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EstimateTemplateItem" ADD CONSTRAINT "EstimateTemplateItem_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "EstimateTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_changeOrderId_fkey" FOREIGN KEY ("changeOrderId") REFERENCES "ChangeOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_costCodeId_fkey" FOREIGN KEY ("costCodeId") REFERENCES "CostCode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_costTypeId_fkey" FOREIGN KEY ("costTypeId") REFERENCES "CostType"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_estimateId_fkey" FOREIGN KEY ("estimateId") REFERENCES "Estimate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "EstimateItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FileFolder" ADD CONSTRAINT "FileFolder_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FileFolder" ADD CONSTRAINT "FileFolder_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "FileFolder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FileFolder" ADD CONSTRAINT "FileFolder_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_estimateId_fkey" FOREIGN KEY ("estimateId") REFERENCES "Estimate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_managerId_fkey" FOREIGN KEY ("managerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadMeeting" ADD CONSTRAINT "LeadMeeting_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadNote" ADD CONSTRAINT "LeadNote_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadTask" ADD CONSTRAINT "LeadTask_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadTask" ADD CONSTRAINT "LeadTask_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpKey" ADD CONSTRAINT "McpKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "MessageThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageThread" ADD CONSTRAINT "MessageThread_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageThread" ADD CONSTRAINT "MessageThread_subcontractorId_fkey" FOREIGN KEY ("subcontractorId") REFERENCES "Subcontractor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MoodBoard" ADD CONSTRAINT "MoodBoard_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MoodBoardItem" ADD CONSTRAINT "MoodBoardItem_moodBoardId_fkey" FOREIGN KEY ("moodBoardId") REFERENCES "MoodBoard"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfficeTask" ADD CONSTRAINT "OfficeTask_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "OfficeTask" ADD CONSTRAINT "OfficeTask_columnId_fkey" FOREIGN KEY ("columnId") REFERENCES "OfficeBoardColumn"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "OfficeTask" ADD CONSTRAINT "OfficeTask_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "PaymentSchedule" ADD CONSTRAINT "PaymentSchedule_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentSchedule" ADD CONSTRAINT "PaymentSchedule_scheduleTaskId_fkey" FOREIGN KEY ("scheduleTaskId") REFERENCES "ScheduleTask"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentSchedule" ADD CONSTRAINT "PaymentSchedule_sourceCoScheduleId_fkey" FOREIGN KEY ("sourceCoScheduleId") REFERENCES "ChangeOrderPaymentSchedule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Permit" ADD CONSTRAINT "Permit_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortalVisibility" ADD CONSTRAINT "PortalVisibility_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductLibraryItem" ADD CONSTRAINT "ProductLibraryItem_clippedById_fkey" FOREIGN KEY ("clippedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgressBilling" ADD CONSTRAINT "ProgressBilling_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgressBillingLine" ADD CONSTRAINT "ProgressBillingLine_billingId_fkey" FOREIGN KEY ("billingId") REFERENCES "ProgressBilling"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectAccess" ADD CONSTRAINT "ProjectAccess_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectAccess" ADD CONSTRAINT "ProjectAccess_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectFile" ADD CONSTRAINT "ProjectFile_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "FileFolder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectFile" ADD CONSTRAINT "ProjectFile_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectFile" ADD CONSTRAINT "ProjectFile_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectFile" ADD CONSTRAINT "ProjectFile_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectProductFavorite" ADD CONSTRAINT "ProjectProductFavorite_addedById_fkey" FOREIGN KEY ("addedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectProductFavorite" ADD CONSTRAINT "ProjectProductFavorite_productId_fkey" FOREIGN KEY ("productId") REFERENCES "ProductLibraryItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectProductFavorite" ADD CONSTRAINT "ProjectProductFavorite_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderFile" ADD CONSTRAINT "PurchaseOrderFile_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderItem" ADD CONSTRAINT "PurchaseOrderItem_costCodeId_fkey" FOREIGN KEY ("costCodeId") REFERENCES "CostCode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderItem" ADD CONSTRAINT "PurchaseOrderItem_costTypeId_fkey" FOREIGN KEY ("costTypeId") REFERENCES "CostType"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderItem" ADD CONSTRAINT "PurchaseOrderItem_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderMessage" ADD CONSTRAINT "PurchaseOrderMessage_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Retainer" ADD CONSTRAINT "Retainer_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Retainer" ADD CONSTRAINT "Retainer_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewAlertEpisode" ADD CONSTRAINT "ReviewAlertEpisode_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "ReviewAlertBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewAlertEpisode" ADD CONSTRAINT "ReviewAlertEpisode_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "ReviewIssue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomAsset" ADD CONSTRAINT "RoomAsset_roomDesignId_fkey" FOREIGN KEY ("roomDesignId") REFERENCES "RoomDesign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomDesign" ADD CONSTRAINT "RoomDesign_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomDesign" ADD CONSTRAINT "RoomDesign_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomRender" ADD CONSTRAINT "RoomRender_roomDesignId_fkey" FOREIGN KEY ("roomDesignId") REFERENCES "RoomDesign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleTask" ADD CONSTRAINT "ScheduleTask_estimateItemId_fkey" FOREIGN KEY ("estimateItemId") REFERENCES "EstimateItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleTask" ADD CONSTRAINT "ScheduleTask_generatedFromChangeOrderId_fkey" FOREIGN KEY ("generatedFromChangeOrderId") REFERENCES "ChangeOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleTask" ADD CONSTRAINT "ScheduleTask_generatedFromEstimateId_fkey" FOREIGN KEY ("generatedFromEstimateId") REFERENCES "Estimate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleTask" ADD CONSTRAINT "ScheduleTask_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleTask" ADD CONSTRAINT "ScheduleTask_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "ScheduleTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleTask" ADD CONSTRAINT "ScheduleTask_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SelectionBoard" ADD CONSTRAINT "SelectionBoard_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SelectionCategory" ADD CONSTRAINT "SelectionCategory_boardId_fkey" FOREIGN KEY ("boardId") REFERENCES "SelectionBoard"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SelectionItemComment" ADD CONSTRAINT "SelectionItemComment_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "SelectionProposal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SelectionOption" ADD CONSTRAINT "SelectionOption_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "SelectionCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SelectionProposal" ADD CONSTRAINT "SelectionProposal_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SelectionProposal" ADD CONSTRAINT "SelectionProposal_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "Decision"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SelectionProposal" ADD CONSTRAINT "SelectionProposal_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubTaskAssignment" ADD CONSTRAINT "SubTaskAssignment_subcontractorId_fkey" FOREIGN KEY ("subcontractorId") REFERENCES "Subcontractor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubTaskAssignment" ADD CONSTRAINT "SubTaskAssignment_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "ScheduleTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubcontractorProjectAccess" ADD CONSTRAINT "SubcontractorProjectAccess_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubcontractorProjectAccess" ADD CONSTRAINT "SubcontractorProjectAccess_subcontractorId_fkey" FOREIGN KEY ("subcontractorId") REFERENCES "Subcontractor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Takeoff" ADD CONSTRAINT "Takeoff_estimateId_fkey" FOREIGN KEY ("estimateId") REFERENCES "Estimate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Takeoff" ADD CONSTRAINT "Takeoff_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Takeoff" ADD CONSTRAINT "Takeoff_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TakeoffFile" ADD CONSTRAINT "TakeoffFile_takeoffId_fkey" FOREIGN KEY ("takeoffId") REFERENCES "Takeoff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskAssignment" ADD CONSTRAINT "TaskAssignment_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "ScheduleTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskAssignment" ADD CONSTRAINT "TaskAssignment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskComment" ADD CONSTRAINT "TaskComment_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "ScheduleTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskComment" ADD CONSTRAINT "TaskComment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskCommentPhoto" ADD CONSTRAINT "TaskCommentPhoto_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "TaskComment"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "TaskDependency" ADD CONSTRAINT "TaskDependency_dependentId_fkey" FOREIGN KEY ("dependentId") REFERENCES "ScheduleTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskDependency" ADD CONSTRAINT "TaskDependency_predecessorId_fkey" FOREIGN KEY ("predecessorId") REFERENCES "ScheduleTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskMaterial" ADD CONSTRAINT "TaskMaterial_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskMaterial" ADD CONSTRAINT "TaskMaterial_statusChangedById_fkey" FOREIGN KEY ("statusChangedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskMaterial" ADD CONSTRAINT "TaskMaterial_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "ScheduleTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskPunchItem" ADD CONSTRAINT "TaskPunchItem_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskPunchItem" ADD CONSTRAINT "TaskPunchItem_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "ScheduleTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamMessage" ADD CONSTRAINT "TeamMessage_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamMessage" ADD CONSTRAINT "TeamMessage_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_changeOrderId_fkey" FOREIGN KEY ("changeOrderId") REFERENCES "ChangeOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_costCodeId_fkey" FOREIGN KEY ("costCodeId") REFERENCES "CostCode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_costTypeId_fkey" FOREIGN KEY ("costTypeId") REFERENCES "CostType"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_estimateItemId_fkey" FOREIGN KEY ("estimateItemId") REFERENCES "EstimateItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_scheduleTaskId_fkey" FOREIGN KEY ("scheduleTaskId") REFERENCES "ScheduleTask"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserPermission" ADD CONSTRAINT "UserPermission_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorFile" ADD CONSTRAINT "VendorFile_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_CrewAssignments" ADD CONSTRAINT "_CrewAssignments_A_fkey" FOREIGN KEY ("A") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_CrewAssignments" ADD CONSTRAINT "_CrewAssignments_B_fkey" FOREIGN KEY ("B") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_VendorToVendorTag" ADD CONSTRAINT "_VendorToVendorTag_A_fkey" FOREIGN KEY ("A") REFERENCES "Vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_VendorToVendorTag" ADD CONSTRAINT "_VendorToVendorTag_B_fkey" FOREIGN KEY ("B") REFERENCES "VendorTag"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Partial indexes.
--
-- Prisma's migrate/introspection engine has no representation for a partial
-- index, so `migrate diff --from-empty --to-schema-datasource` silently OMITS
-- all seven of these rather than emitting them. Three of them are UNIQUE and
-- enforce real invariants (Twilio webhook dedup, deposit-reservation
-- uniqueness, one client thread per project) — a database built without them
-- accepts duplicates that production rejects, which is precisely the
-- CI-does-not-match-prod failure this baseline exists to prevent.
--
-- They are therefore appended by hand, verbatim from production's
-- pg_indexes.indexdef. If you ever regenerate this file from the diff engine,
-- you MUST re-append this block. scripts/check-partial-indexes.mjs asserts the
-- set below still matches production, so drift here fails CI rather than
-- rotting silently.
-- ---------------------------------------------------------------------------

-- CreateIndex
CREATE UNIQUE INDEX "ClientMessage_twilioMessageSid_key" ON "ClientMessage" USING btree ("twilioMessageSid") WHERE ("twilioMessageSid" IS NOT NULL);

-- CreateIndex
CREATE UNIQUE INDEX "DepositIngest_paymentScheduleId_reservation_key" ON "DepositIngest" USING btree ("paymentScheduleId") WHERE ((status = ANY (ARRAY['processing'::text, 'qbo_unknown'::text, 'qbo_created'::text, 'applied'::text, 'reconcile'::text, 'failed'::text])) AND ("paymentScheduleId" IS NOT NULL));

-- CreateIndex
CREATE UNIQUE INDEX "MessageThread_projectId_client_unique" ON "MessageThread" USING btree ("projectId") WHERE ("subcontractorId" IS NULL);

-- CreateIndex
CREATE INDEX "ReviewAlertBatch_claimed_lease_idx" ON "ReviewAlertBatch" USING btree ("claimedAt", "createdAt") WHERE (status = 'CLAIMED'::text);

-- CreateIndex
CREATE INDEX "ReviewAlertBatch_pending_retry_idx" ON "ReviewAlertBatch" USING btree ("nextAttemptAt", "createdAt") WHERE (status = 'PENDING'::text);

-- CreateIndex
CREATE INDEX "ReviewAlertEpisode_claimed_lease_idx" ON "ReviewAlertEpisode" USING btree ("claimedAt", "createdAt") WHERE (status = 'CLAIMED'::text);

-- CreateIndex
CREATE INDEX "ReviewAlertEpisode_pending_retry_idx" ON "ReviewAlertEpisode" USING btree ("nextAttemptAt", "createdAt") WHERE (status = 'PENDING'::text);
