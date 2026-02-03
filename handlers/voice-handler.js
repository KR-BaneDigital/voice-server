const WebSocket = require('ws');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

/**
 * Handle incoming voice webhook from Twilio
 * Returns TwiML to establish WebSocket stream
 */
function handleVoiceWebhook(req, res) {
  try {
    const { From: from, CallSid: callSid, To: to } = req.body;
    
    console.log('[Voice Webhook] Incoming call:', { from, to, callSid });

    // Get host from environment or request
    const host = process.env.VOICE_SERVER_URL || req.get('host');
    const protocol = host.includes('localhost') ? 'ws' : 'wss';

    // Return TwiML with Stream directive (NO <Say> - AI will greet)
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${protocol}://${host}/media-stream">
      <Parameter name="callSid" value="${callSid}" />
      <Parameter name="from" value="${from}" />
      <Parameter name="to" value="${to}" />
    </Stream>
  </Connect>
</Response>`;

    res.type('text/xml').send(twiml);

  } catch (error) {
    console.error('[Voice Webhook] Error:', error);
    
    const errorTwiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Sorry, I encountered an error. Please try again later.</Say>
  <Hangup/>
</Response>`;

    res.status(500).type('text/xml').send(errorTwiml);
  }
}

/**
 * Handle WebSocket voice stream from Twilio
 * Uses Official OpenAI Pattern: Simple Relay (Twilio ↔ OpenAI)
 */
async function handleVoiceStream(twilioWs, initialCallSid) {
  console.log('[Voice Stream] Client connected');

  let openaiWs = null;
  let callSid = initialCallSid;
  let streamSid = null;
  let conversationId = null;
  let agentId = null;

  twilioWs.on('message', async (message) => {
    try {
      const data = JSON.parse(message.toString());

      switch (data.event) {
        case 'start':
          // Extract call parameters
          callSid = data.start.callSid;
          streamSid = data.start.streamSid;
          const fromPhone = data.start.customParameters?.from || data.start.customParameters?.From;
          const toPhone = data.start.customParameters?.to || data.start.customParameters?.To;
          
          console.log('[Voice Stream] Call started:', { callSid, fromPhone, toPhone });

          // ========================================
          // 1. LOOKUP AGENT FROM DATABASE
          // ========================================
          const agent = await prisma.aiAgent.findFirst({
            where: {
              phoneNumber: {
                phoneNumber: toPhone
              },
              status: 'active'
            },
            include: {
              knowledgeBases: {
                include: {
                  knowledgeBase: {
                    include: {
                      documents: {
                        where: {
                          status: 'active'
                        }
                      }
                    }
                  }
                }
              }
            }
          });

          if (!agent) {
            console.error('[Voice Stream] No active agent found for phone:', toPhone);
            twilioWs.close();
            return;
          }

          agentId = agent.id;
          console.log('[Voice Stream] Agent found:', {
            agentId,
            name: agent.name,
            voiceModel: agent.voiceModel,
            language: agent.language,
            hasGreeting: !!agent.systemGreeting
          });

          // ========================================
          // 2. BUILD KNOWLEDGE BASE CONTEXT
          // ========================================
          const knowledgeDocs = agent.knowledgeBases
            .flatMap(kb => kb.knowledgeBase.documents)
            .map(doc => `${doc.name}:\n${doc.content}`)
            .join('\n\n---\n\n');

          console.log('[Voice Stream] Loaded knowledge docs:', {
            knowledgeBaseCount: agent.knowledgeBases.length,
            documentCount: agent.knowledgeBases.flatMap(kb => kb.knowledgeBase.documents).length
          });

          // ========================================
          // 3. BUILD SYSTEM INSTRUCTIONS
          // ========================================
          const instructions = `You must respond only in English. Never switch languages under any circumstances.

${agent.systemPrompt || 'You are a helpful AI assistant.'}

${knowledgeDocs ? `KNOWLEDGE BASE:
${knowledgeDocs}

Use this knowledge base to accurately answer questions. If you don't know something, say so.` : ''}`;

          // ========================================
          // 4. CREATE CONVERSATION RECORD
          // ========================================
          const conversation = await prisma.conversation.create({
            data: {
              aiAgentId: agent.id,
              agencyId: agent.agencyId,
              channel: 'voice',
              status: 'active'
            }
          });
          conversationId = conversation.id;
          console.log('[Voice Stream] Conversation created:', conversationId);

          // ========================================
          // 5. CONNECT TO OPENAI REALTIME API
          // ========================================
          openaiWs = new WebSocket(
            'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview',
            {
              headers: {
                'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
                'OpenAI-Beta': 'realtime=v1'
              }
            }
          );

          openaiWs.on('open', () => {
            console.log('[OpenAI] Connected - configuring session');
            
            // Configure session with knowledge and voice
            openaiWs.send(JSON.stringify({
              type: 'session.update',
              session: {
                voice: agent.voiceModel || 'alloy',
                instructions: instructions,
                input_audio_format: 'g711_ulaw',
                output_audio_format: 'g711_ulaw',
                input_audio_transcription: {
                  model: 'whisper-1'
                },
                turn_detection: {
                  type: 'server_vad',
                  threshold: 0.5,
                  prefix_padding_ms: 300,
                  silence_duration_ms: 500
                }
              }
            }));
            
            // If systemGreeting exists, trigger AI to speak the greeting first
            if (agent.systemGreeting) {
              console.log('[OpenAI] Triggering system greeting:', agent.systemGreeting);

              // Add a hidden user message that prompts the AI to greet
              openaiWs.send(JSON.stringify({
                type: 'conversation.item.create',
                item: {
                  type: 'message',
                  role: 'user',
                  content: [{
                    type: 'input_text',
                    text: `[SYSTEM: The caller just connected. Greet them by saying exactly: "${agent.systemGreeting}"]`
                  }]
                }
              }));

              // Trigger the AI to respond (with the greeting)
              openaiWs.send(JSON.stringify({
                type: 'response.create'
              }));

              console.log('[OpenAI] Session configured - greeting triggered');
            } else {
              console.log('[OpenAI] Session configured - no greeting (waiting for user)');
            }
          });

          // ========================================
          // 6. RELAY OPENAI → TWILIO (Audio + Transcripts)
          // ========================================
          openaiWs.on('message', async (msg) => {
            try {
              const response = JSON.parse(msg.toString());

              // 🔍 LOG EVERY MESSAGE FROM OPENAI
              console.log('[OpenAI] Message received:', {
                type: response.type,
                keys: Object.keys(response),
                hasAudio: !!response.delta,
                hasTranscript: !!response.transcript
              });
              
              // 🔍 LOG FULL response.done TO SEE WHY NO AUDIO
              if (response.type === 'response.done') {
                console.log('[OpenAI] FULL response.done:', JSON.stringify(response, null, 2));
              }

              // Stream audio to Twilio
              if (response.type === 'response.audio.delta' && response.delta) {
                if (streamSid && twilioWs.readyState === 1) {
                  twilioWs.send(JSON.stringify({
                    event: 'media',
                    streamSid: streamSid,
                    media: {
                      payload: response.delta
                    }
                  }));
                }
              }

              // Save user message to database
              if (response.type === 'conversation.item.input_audio_transcription.completed') {
                console.log('[Voice Stream] User said:', response.transcript);
                
                await prisma.conversationMessage.create({
                  data: {
                    conversationId: conversationId,
                    role: 'user',
                    content: response.transcript
                  }
                });
              }

              // Save AI message to database
              if (response.type === 'response.done') {
                const transcript = response.response?.output?.[0]?.content
                  ?.find(c => c.transcript)?.transcript;

                if (transcript) {
                  console.log('[Voice Stream] AI said:', transcript);
                  
                  await prisma.conversationMessage.create({
                    data: {
                      conversationId: conversationId,
                      role: 'assistant',
                      content: transcript
                    }
                  });
                }
              }
            } catch (err) {
              console.error('[Voice Stream] Error handling OpenAI message:', err);
            }
          });

          openaiWs.on('error', (error) => {
            console.error('[OpenAI] WebSocket Error:', error);
          });

          openaiWs.on('close', () => {
            console.log('[OpenAI] Disconnected');
          });

          break;

        case 'media':
          // ========================================
          // 7. RELAY TWILIO → OPENAI (Audio from user)
          // ========================================
          if (openaiWs && openaiWs.readyState === 1 && data.media?.payload) {
            openaiWs.send(JSON.stringify({
              type: 'input_audio_buffer.append',
              audio: data.media.payload
            }));
          }
          break;

        case 'stop':
          console.log('[Voice Stream] Call ended');
          
          // Mark conversation as completed
          if (conversationId) {
            await prisma.conversation.update({
              where: { id: conversationId },
              data: {
                status: 'completed',
                endedAt: new Date()
              }
            });
          }

          // Close OpenAI connection
          if (openaiWs) {
            openaiWs.close();
          }
          break;
      }

    } catch (error) {
      console.error('[Voice Stream] Error:', error);
    }
  });

  twilioWs.on('close', async () => {
    console.log('[Voice Stream] Client disconnected');
    
    // Mark conversation as completed
    if (conversationId) {
      await prisma.conversation.update({
        where: { id: conversationId },
        data: {
          status: 'completed',
          endedAt: new Date()
        }
      }).catch(err => console.error('[Voice Stream] Error updating conversation:', err));
    }
    
    // Close OpenAI connection
    if (openaiWs) {
      openaiWs.close();
    }
  });

  twilioWs.on('error', (error) => {
    console.error('[Voice Stream] WebSocket error:', error);
  });
}

module.exports = {
  handleVoiceWebhook,
  handleVoiceStream
};
