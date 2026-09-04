-- Drop three redundant single-column indexes. Each is fully covered by a wider
-- B-tree index on the same table that LEADS with the same column, so every
-- lookup the narrow index served is still served; what goes away is the write
-- overhead of maintaining a second copy of the same leading key.
--
--   DecisionTemplateItem_templateId_idx          covered by (templateId, order)
--   ChatDelivery_publicationId_idx               covered by the unique
--                                                (publicationId, destination, kind)
--   DispatchPublicationChange_publicationId_idx  covered by the unique
--                                                (publicationId, position)
--
-- PR #370 adopted these into schema.prisma because prod genuinely had them;
-- Codex flagged them as redundant in that review. This is the deliberate
-- cleanup, with schema.prisma updated in the same change.
--
-- IF EXISTS keeps it idempotent. Its twin is scripts/apply-drop-redundant-indexes.mjs
-- (identical DDL on purpose: prod is written by the script, CI's throwaway
-- database is built from this file).

-- DropIndex
DROP INDEX IF EXISTS "DecisionTemplateItem_templateId_idx";

-- DropIndex
DROP INDEX IF EXISTS "ChatDelivery_publicationId_idx";

-- DropIndex
DROP INDEX IF EXISTS "DispatchPublicationChange_publicationId_idx";
