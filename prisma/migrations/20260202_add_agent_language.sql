-- Add language field to ai_agents table
-- Default to 'en' (English) for all existing and new agents

ALTER TABLE "ai_agents" 
ADD COLUMN "language" VARCHAR(5) NOT NULL DEFAULT 'en';

COMMENT ON COLUMN "ai_agents"."language" IS 'Language code for AI responses (en, es, fr, de, it, pt, etc.)';
