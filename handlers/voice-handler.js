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

            // Define tools for function calling
            const tools = [
              {
                type: 'function',
                name: 'check_availability',
                description: 'Check available appointment slots for scheduling',
                parameters: {
                  type: 'object',
                  properties: {
                    date: {
                      type: 'string',
                      description: 'Date to check (YYYY-MM-DD or "tomorrow", "next monday")'
                    },
                    duration: {
                      type: 'number',
                      description: 'Meeting duration in minutes (default 30)'
                    }
                  },
                  required: ['date']
                }
              },
              {
                type: 'function',
                name: 'book_appointment',
                description: 'Book an appointment at a specific date and time',
                parameters: {
                  type: 'object',
                  properties: {
                    dateTime: {
                      type: 'string',
                      description: 'ISO 8601 datetime for the appointment'
                    },
                    duration: {
                      type: 'number',
                      description: 'Duration in minutes (default 30)'
                    },
                    title: {
                      type: 'string',
                      description: 'Appointment title/reason'
                    },
                    notes: {
                      type: 'string',
                      description: 'Additional notes'
                    }
                  },
                  required: ['dateTime']
                }
              },
              {
                type: 'function',
                name: 'get_next_available_slot',
                description: 'Find the next available appointment slot. Use when user wants to book but has not specified a date.',
                parameters: {
                  type: 'object',
                  properties: {
                    duration: {
                      type: 'number',
                      description: 'Meeting duration in minutes (default 30)'
                    },
                    daysToSearch: {
                      type: 'number',
                      description: 'Days to search ahead (default 7, max 30)'
                    }
                  },
                  required: []
                }
              }
            ];

            // Configure session with knowledge, voice, and tools
            openaiWs.send(JSON.stringify({
              type: 'session.update',
              session: {
                voice: agent.voiceModel || 'alloy',
                instructions: instructions,
                tools: tools,
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

              // Handle function calls from AI
              if (response.type === 'response.function_call_arguments.done') {
                console.log('[Voice] Function call:', response.name, response.arguments);

                await executeFunctionCall({
                  openaiWs,
                  agencyId: agent.agencyId,
                  conversationId,
                  functionName: response.name,
                  callId: response.call_id,
                  arguments: JSON.parse(response.arguments)
                });
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

// ============================================================================
// FUNCTION CALLING - Helper Functions
// ============================================================================

/**
 * Parse natural language dates like "tomorrow", "next monday", etc.
 */
function parseNaturalDate(dateStr) {
  const today = new Date();
  const lowered = dateStr.toLowerCase().trim();

  if (lowered === 'today') {
    return today;
  }

  if (lowered === 'tomorrow') {
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);
    return tomorrow;
  }

  // Handle "next monday", "next tuesday", etc.
  const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const nextMatch = lowered.match(/next\s+(\w+)/);
  if (nextMatch) {
    const targetDay = dayNames.indexOf(nextMatch[1]);
    if (targetDay !== -1) {
      const result = new Date(today);
      const currentDay = today.getDay();
      let daysUntil = targetDay - currentDay;
      if (daysUntil <= 0) daysUntil += 7;
      result.setDate(today.getDate() + daysUntil);
      return result;
    }
  }

  // Try to parse as ISO date (YYYY-MM-DD)
  const parsed = new Date(dateStr);
  if (!isNaN(parsed.getTime())) {
    return parsed;
  }

  // Default to today if we can't parse
  return today;
}

/**
 * Get start of day for a date
 */
function startOfDay(date) {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  return result;
}

/**
 * Get end of day for a date
 */
function endOfDay(date) {
  const result = new Date(date);
  result.setHours(23, 59, 59, 999);
  return result;
}

/**
 * Generate available time slots for a given day
 */
function generateAvailableSlots(targetDate, existingEvents, durationMinutes = 30) {
  const slots = [];
  const startHour = 9; // 9 AM
  const endHour = 17; // 5 PM

  // Generate all possible slots
  for (let hour = startHour; hour < endHour; hour++) {
    for (let minute = 0; minute < 60; minute += 30) {
      const slotStart = new Date(targetDate);
      slotStart.setHours(hour, minute, 0, 0);

      const slotEnd = new Date(slotStart.getTime() + durationMinutes * 60000);

      // Check if slot conflicts with existing events
      const hasConflict = existingEvents.some(event => {
        const eventStart = new Date(event.startTime);
        const eventEnd = new Date(event.endTime);
        return (slotStart < eventEnd && slotEnd > eventStart);
      });

      if (!hasConflict) {
        slots.push(slotStart);
      }
    }
  }

  return slots;
}

/**
 * Check availability for appointments
 */
async function checkAvailability(agencyId, args) {
  console.log('[checkAvailability] START:', { agencyId, args });

  // Validate agencyId
  if (!agencyId) {
    console.error('[checkAvailability] Missing agencyId');
    return {
      success: false,
      message: 'Unable to check availability. Please try again.'
    };
  }

  const { date, duration = 30 } = args;

  // Validate date parameter
  if (!date) {
    console.error('[checkAvailability] Missing date parameter');
    return {
      success: false,
      message: 'Please specify a date to check availability.'
    };
  }

  // Parse date (handle "tomorrow", "next monday", etc.)
  const targetDate = parseNaturalDate(date);
  const dayStart = startOfDay(targetDate);
  const dayEnd = endOfDay(targetDate);

  console.log('[checkAvailability] Query range:', {
    targetDate: targetDate.toISOString(),
    dayStart: dayStart.toISOString(),
    dayEnd: dayEnd.toISOString()
  });

  // Get existing events that overlap with that day
  const events = await prisma.calendarEvent.findMany({
    where: {
      agencyId,
      AND: [
        { startTime: { lt: dayEnd } },
        { endTime: { gt: dayStart } }
      ],
      status: { not: 'cancelled' }
    }
  });

  console.log('[checkAvailability] Events found:', events.length, events.map(e => ({
    id: e.id,
    title: e.title,
    start: e.startTime,
    end: e.endTime
  })));

  // Generate available slots (9am-5pm, 30-min intervals)
  const slots = generateAvailableSlots(targetDate, events, duration);

  console.log('[checkAvailability] Available slots:', slots.length);

  return {
    success: true,
    date: targetDate.toISOString().split('T')[0],
    availableSlots: slots.map(s => s.toLocaleTimeString('en-US', {
      hour: 'numeric', minute: '2-digit'
    })),
    message: slots.length > 0
      ? `Available times on ${targetDate.toDateString()}: ${slots.length} slots`
      : 'No availability on that date'
  };
}

/**
 * Book an appointment
 */
async function bookAppointment(agencyId, conversationId, args) {
  const { dateTime, duration = 30, title = 'Phone Appointment', notes } = args;

  const startTime = new Date(dateTime);
  const endTime = new Date(startTime.getTime() + duration * 60000);

  // Create calendar event
  const event = await prisma.calendarEvent.create({
    data: {
      agencyId,
      title,
      startTime,
      endTime,
      status: 'scheduled',
      eventType: 'appointment',
      notes,
      metadata: {
        bookedVia: 'voice_ai',
        conversationId
      }
    }
  });

  return {
    success: true,
    eventId: event.id,
    dateTime: startTime.toISOString(),
    message: `Appointment booked for ${startTime.toLocaleString()}`
  };
}

/**
 * Find the next available appointment slot
 */
async function getNextAvailableSlot(agencyId, args) {
  console.log('[getNextAvailableSlot] START:', { agencyId, args });

  if (!agencyId) {
    console.error('[getNextAvailableSlot] Missing agencyId');
    return { success: false, message: 'Unable to check availability.' };
  }

  const { duration = 30, daysToSearch = 7 } = args;
  const maxDays = Math.min(daysToSearch, 30);
  const now = new Date();

  for (let dayOffset = 0; dayOffset < maxDays; dayOffset++) {
    const checkDate = new Date(now);
    checkDate.setDate(now.getDate() + dayOffset);

    // Skip weekends
    if (checkDate.getDay() === 0 || checkDate.getDay() === 6) continue;

    const dayStart = startOfDay(checkDate);
    const dayEnd = endOfDay(checkDate);

    console.log('[getNextAvailableSlot] Checking day:', {
      dayOffset,
      date: checkDate.toDateString(),
      dayStart: dayStart.toISOString(),
      dayEnd: dayEnd.toISOString()
    });

    const events = await prisma.calendarEvent.findMany({
      where: {
        agencyId,
        AND: [
          { startTime: { lt: dayEnd } },
          { endTime: { gt: dayStart } }
        ],
        status: { not: 'cancelled' }
      }
    });

    console.log('[getNextAvailableSlot] Events on', checkDate.toDateString(), ':', events.length);

    let slots = generateAvailableSlots(checkDate, events, duration);

    // Filter past slots for today
    if (dayOffset === 0) {
      const currentHour = now.getHours();
      const currentMinute = now.getMinutes();
      slots = slots.filter(s => {
        const slotHour = s.getHours();
        const slotMinute = s.getMinutes();
        return slotHour > currentHour || (slotHour === currentHour && slotMinute > currentMinute);
      });
    }

    if (slots.length > 0) {
      const nextSlot = slots[0];
      const formattedDate = checkDate.toDateString();
      const formattedTime = nextSlot.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

      console.log('[getNextAvailableSlot] Found:', { date: formattedDate, time: formattedTime, totalSlots: slots.length });

      return {
        success: true,
        nextAvailable: {
          dateTime: nextSlot.toISOString(),
          formatted: `${formattedDate} at ${formattedTime}`
        },
        otherSlots: slots.slice(1, 4).map(s => s.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })),
        message: `Next available: ${formattedDate} at ${formattedTime}`
      };
    }
  }

  console.log('[getNextAvailableSlot] No slots found in', maxDays, 'days');
  return {
    success: false,
    message: `No availability in the next ${maxDays} days.`
  };
}

/**
 * Execute a function call from the AI
 */
async function executeFunctionCall({ openaiWs, agencyId, conversationId, functionName, callId, arguments: args }) {
  let result;
  console.log('[executeFunctionCall] START:', { functionName, callId, agencyId, args });

  try {
    switch (functionName) {
      case 'check_availability':
        result = await checkAvailability(agencyId, args);
        break;
      case 'book_appointment':
        result = await bookAppointment(agencyId, conversationId, args);
        break;
      case 'get_next_available_slot':
        result = await getNextAvailableSlot(agencyId, args);
        break;
      default:
        console.warn('[executeFunctionCall] Unknown function:', functionName);
        result = { error: 'Unknown function' };
    }
  } catch (error) {
    console.error('[Function] Execution error:', error);
    result = { success: false, message: 'An error occurred. Please try again.' };
  }

  console.log('[executeFunctionCall] Result:', { functionName, success: result.success !== false });

  // Send result back to OpenAI
  openaiWs.send(JSON.stringify({
    type: 'conversation.item.create',
    item: {
      type: 'function_call_output',
      call_id: callId,
      output: JSON.stringify(result)
    }
  }));

  // Trigger AI to respond with the result
  openaiWs.send(JSON.stringify({ type: 'response.create' }));
}

module.exports = {
  handleVoiceWebhook,
  handleVoiceStream
};
