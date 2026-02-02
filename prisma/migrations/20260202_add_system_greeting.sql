-- Add system_greeting column to ai_agents table
-- This field stores the initial greeting for inbound voice calls

ALTER TABLE ai_agents 
ADD COLUMN system_greeting TEXT;

COMMENT ON COLUMN ai_agents.system_greeting IS 'Initial greeting message for inbound voice calls';

-- Set default greeting for existing agents
UPDATE ai_agents 
SET system_greeting = 'Thank you for calling. How may I assist you today?'
WHERE system_greeting IS NULL;
