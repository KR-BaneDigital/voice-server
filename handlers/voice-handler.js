const { PrismaClient } = require('@prisma/client');
const { OpenAIRealtimeClient } = require('../lib/openai-realtime-client');

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

    // Return TwiML with Stream directive
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Please wait while I connect you to our AI assistant.</Say>
  <Connect>
    <Stream url="${protocol}://${host}">
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
 * Bridges Twilio ↔ OpenAI Realtime API
 */
function handleVoiceStream(twilioWs, initialCallSid) {
  console.log('[Voice Stream] Client connected');

  let openaiClient = null;
  let conversation = null;
  let callSid = initialCallSid;
  let fromPhone = null;
  let toPhone = null;
  let agencyId = null;
  let streamSid = null;

  twilioWs.on('message', async (message) => {
    try {
      const data = JSON.parse(message.toString());

      switch (data.event) {
        case 'start':
          // Extract call parameters
          callSid = data.start.callSid;
          streamSid = data.start.streamSid;
          fromPhone = data.start.customParameters?.from || data.start.customParameters?.From;
          toPhone = data.start.customParameters?.to || data.start.customParameters?.To;
          
          console.log('[Voice Stream] Call started:', { callSid, fromPhone, toPhone });

          // Find phone number and agency
          const phoneNumber = await prisma.phoneNumber.findFirst({
            where: { phoneNumber: toPhone },
            include: { agency: true }
          });

          if (!phoneNumber) {
            console.error('[Voice Stream] Phone number not found:', toPhone);
            twilioWs.close();
            return;
          }

          agencyId = phoneNumber.agencyId;

          // Find or create prospect
          let prospectContact = await prisma.prospectContact.findFirst({
            where: { phone: fromPhone },
            include: {
              prospect: {
                include: { agency: true }
              }
            }
          });

          if (!prospectContact) {
            // Create new prospect
            const prospect = await prisma.prospect.create({
              data: {
                companyName: 'Unknown Company',
                agencyId: agencyId,
                source: 'voice_inbound',
                status: 'new'
              }
            });

            prospectContact = await prisma.prospectContact.create({
              data: {
                prospectId: prospect.id,
                phone: fromPhone,
                name: 'Unknown Contact',
                isPrimary: true
              },
              include: {
                prospect: {
                  include: { agency: true }
                }
              }
            });
          }

          // Create conversation
          conversation = await prisma.conversation.create({
            data: {
              prospectId: prospectContact.prospectId,
              agencyId: agencyId,
              primaryChannel: 'voice',
              channelsUsed: ['voice'],
              status: 'active',
              metadata: {
                callSid,
                fromPhone,
                toPhone
              }
            }
          });

          // Get AI agent for this phone number
          const agent = await prisma.aiAgent.findFirst({
            where: {
              phoneNumberId: phoneNumber.id,
              isActive: true
            },
            include: {
              knowledgeBases: {
                include: {
                  knowledgeBase: true
                }
              }
            }
          });

          // Prepare system instructions
          const instructions = agent?.systemPrompt || `You are a helpful AI assistant for ${phoneNumber.agency.name}. 
You can help with scheduling appointments and answering questions about our services.
Be friendly, professional, and concise in your responses.`;

          // Define functions for voice AI
          const tools = [
            {
              type: 'function',
              name: 'check_availability',
              description: 'Check available appointment slots for a specific date or date range',
              parameters: {
                type: 'object',
                properties: {
                  startDate: {
                    type: 'string',
                    description: 'Start date for availability check (ISO format or natural language like "tomorrow", "next Monday")'
                  },
                  endDate: {
                    type: 'string',
                    description: 'End date for availability check (optional, defaults to same as startDate)'
                  },
                  duration: {
                    type: 'number',
                    description: 'Appointment duration in minutes (default: 30)'
                  }
                },
                required: ['startDate']
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
                    description: 'Date and time for the appointment (ISO format)'
                  },
                  duration: {
                    type: 'number',
                    description: 'Appointment duration in minutes (default: 30)'
                  },
                  notes: {
                    type: 'string',
                    description: 'Additional notes or reason for appointment'
                  }
                },
                required: ['dateTime']
              }
            }
          ];

          // Initialize OpenAI Realtime
          openaiClient = new OpenAIRealtimeClient({
            model: 'gpt-4o-realtime-preview-2024-10-01',
            voice: agent?.voiceSettings?.voice || 'alloy',
            instructions,
            tools,
            temperature: 0.8
          });

          await openaiClient.connect();

          // Handle OpenAI messages
          openaiClient.onMessage(async (msg) => {
            try {
              switch (msg.type) {
                case 'response.audio.delta':
                  // Stream audio back to Twilio
                  if (streamSid && twilioWs.readyState === 1) { // 1 = OPEN
                    twilioWs.send(JSON.stringify({
                      event: 'media',
                      streamSid: streamSid,
                      media: {
                        payload: msg.delta
                      }
                    }));
                  }
                  break;

                case 'conversation.item.input_audio_transcription.completed':
                  // Store user's transcribed message
                  if (conversation) {
                    await prisma.conversationMessage.create({
                      data: {
                        conversationId: conversation.id,
                        role: 'user',
                        content: msg.transcript,
                        channel: 'voice',
                        direction: 'inbound',
                        metadata: {
                          callSid,
                          confidence: msg.confidence
                        }
                      }
                    });
                  }
                  break;

                case 'response.done':
                  // Store AI's response
                  if (conversation && msg.response?.output?.[0]?.content) {
                    const transcript = msg.response.output[0].content
                      .filter(c => c.type === 'audio' && c.transcript)
                      .map(c => c.transcript)
                      .join(' ');

                    if (transcript) {
                      await prisma.conversationMessage.create({
                        data: {
                          conversationId: conversation.id,
                          role: 'assistant',
                          content: transcript,
                          channel: 'voice',
                          direction: 'outbound',
                          tokensUsed: msg.response.usage?.total_tokens || 0,
                          model: 'gpt-4o-realtime'
                        }
                      });
                    }
                  }
                  break;

                case 'response.function_call_arguments.done':
                  // Execute function call
                  await executeFunctionCall({
                    openaiClient,
                    conversationId: conversation?.id,
                    agencyId,
                    prospectId: prospectContact.prospectId,
                    functionName: msg.name,
                    callId: msg.call_id,
                    arguments: JSON.parse(msg.arguments)
                  });
                  break;
              }
            } catch (err) {
              console.error('[Voice Stream] Error handling OpenAI message:', err);
            }
          });

          break;

        case 'media':
          // Forward audio to OpenAI
          if (openaiClient && data.media?.payload) {
            const audioBuffer = Buffer.from(data.media.payload, 'base64');
            openaiClient.sendAudio(audioBuffer);
          }
          break;

        case 'stop':
          console.log('[Voice Stream] Call ended');
          
          // Complete conversation
          if (conversation) {
            await prisma.conversation.update({
              where: { id: conversation.id },
              data: {
                status: 'completed',
                completedAt: new Date()
              }
            });
          }

          // Cleanup
          if (openaiClient) {
            openaiClient.close();
          }
          break;
      }

    } catch (error) {
      console.error('[Voice Stream] Error:', error);
    }
  });

  twilioWs.on('close', () => {
    console.log('[Voice Stream] Client disconnected');
    if (openaiClient) {
      openaiClient.close();
    }
  });

  twilioWs.on('error', (error) => {
    console.error('[Voice Stream] WebSocket error:', error);
  });
}

/**
 * Execute function calls from OpenAI
 */
async function executeFunctionCall(params) {
  const { openaiClient, conversationId, agencyId, prospectId, functionName, callId, arguments: args } = params;

  console.log('[Voice Stream] Executing function:', functionName, args);

  try {
    let result = { success: false };

    switch (functionName) {
      case 'check_availability':
        result = await checkAvailability(agencyId, args);
        break;

      case 'book_appointment':
        result = await bookAppointment(agencyId, prospectId, conversationId, args);
        break;

      default:
        result = { success: false, error: 'Unknown function' };
    }

    // Send function result back to OpenAI
    openaiClient.send({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output: JSON.stringify(result)
      }
    });

    // Tell OpenAI to generate a response based on function result
    openaiClient.send({
      type: 'response.create'
    });

  } catch (error) {
    console.error('[Voice Stream] Function execution error:', error);
    
    openaiClient.send({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output: JSON.stringify({ success: false, error: error.message })
      }
    });
  }
}

/**
 * Check availability for appointments
 */
async function checkAvailability(agencyId, args) {
  try {
    const { startDate, endDate, duration = 30 } = args;
    
    // Parse dates
    const start = new Date(startDate);
    const end = endDate ? new Date(endDate) : start;

    // Get availability config
    const config = await prisma.availabilityConfig.findFirst({
      where: { agencyId, isActive: true }
    });

    if (!config) {
      return {
        success: false,
        message: 'No availability configuration found.'
      };
    }

    // Simple slot generation (you'd want to import the actual availability logic)
    const slots = [];
    const currentDate = new Date(start);
    
    while (currentDate <= end) {
      const dayOfWeek = currentDate.getDay();
      const dayConfig = config.weeklyHours[dayOfWeek];
      
      if (dayConfig && dayConfig.enabled) {
        const [startHour, startMin] = dayConfig.start.split(':').map(Number);
        const [endHour, endMin] = dayConfig.end.split(':').map(Number);
        
        const slotTime = new Date(currentDate);
        slotTime.setHours(startHour, startMin, 0, 0);
        
        const endTime = new Date(currentDate);
        endTime.setHours(endHour, endMin, 0, 0);
        
        while (slotTime < endTime) {
          slots.push({
            start: new Date(slotTime),
            end: new Date(slotTime.getTime() + duration * 60000)
          });
          slotTime.setMinutes(slotTime.getMinutes() + duration);
        }
      }
      
      currentDate.setDate(currentDate.getDate() + 1);
    }

    return {
      success: true,
      slots: slots.slice(0, 5).map(slot => ({
        dateTime: slot.start.toISOString(),
        displayTime: slot.start.toLocaleString('en-US', {
          weekday: 'long',
          month: 'long',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          hour12: true
        })
      })),
      message: slots.length > 0 
        ? `I found ${Math.min(slots.length, 5)} available time${slots.length > 1 ? 's' : ''}.`
        : 'No available times found for that date.'
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      message: 'Sorry, I had trouble checking availability.'
    };
  }
}

/**
 * Book an appointment
 */
async function bookAppointment(agencyId, prospectId, conversationId, args) {
  try {
    const { dateTime, duration = 30, notes } = args;
    
    const appointmentTime = new Date(dateTime);
    const endTime = new Date(appointmentTime.getTime() + duration * 60000);

    // Get prospect contact for event
    const prospect = await prisma.prospect.findUnique({
      where: { id: prospectId },
      include: {
        contacts: {
          where: { isPrimary: true },
          take: 1
        }
      }
    });

    // Create calendar event
    const event = await prisma.calendarEvent.create({
      data: {
        agencyId,
        title: `Call with ${prospect?.contacts[0]?.name || 'Unknown'}`,
        description: notes || 'Appointment booked via voice AI',
        start: appointmentTime,
        end: endTime,
        type: 'call',
        status: 'scheduled',
        metadata: {
          prospectId,
          conversationId,
          bookedVia: 'voice_ai'
        }
      }
    });

    return {
      success: true,
      eventId: event.id,
      dateTime: appointmentTime.toISOString(),
      message: `Great! I've booked your appointment for ${appointmentTime.toLocaleString('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
      })}.`
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      message: 'Sorry, I had trouble booking that appointment.'
    };
  }
}

module.exports = {
  handleVoiceWebhook,
  handleVoiceStream
};
