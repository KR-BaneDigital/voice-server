const { OpenAIRealtimeClient } = require('../lib/openai-realtime-client');

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

    // Return TwiML with Stream directive pointing to /media-stream path
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Please wait while I connect you to our AI assistant.</Say>
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
 * Bridges Twilio ↔ OpenAI Realtime API
 */
function handleVoiceStream(twilioWs, initialCallSid) {
  console.log('[Voice Stream] Client connected');

  let openaiClient = null;
  let callSid = initialCallSid;
  let streamSid = null;

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

          // System instructions for the AI
          const instructions = `You are a helpful and friendly AI assistant. 
Be concise in your responses since this is a phone conversation.
Ask clarifying questions when needed and be professional.`;

          // Initialize OpenAI Realtime
          openaiClient = new OpenAIRealtimeClient({
            model: 'gpt-4o-realtime-preview-2024-10-01',
            voice: 'alloy',
            instructions,
            temperature: 0.8
          });

          await openaiClient.connect();

          // Handle OpenAI messages
          openaiClient.onMessage(async (msg) => {
            console.log('[OpenAI] Received message type:', msg.type); // LOG ALL MESSAGE TYPES
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
                  console.log('[Voice Stream] User said:', msg.transcript);
                  break;

                case 'response.done':
                  if (msg.response?.output?.[0]?.content) {
                    const transcript = msg.response.output[0].content
                      .filter(c => c.type === 'audio' && c.transcript)
                      .map(c => c.transcript)
                      .join(' ');

                    if (transcript) {
                      console.log('[Voice Stream] AI said:', transcript);
                    }
                  }
                  break;
              }
            } catch (err) {
              console.error('[Voice Stream] Error handling OpenAI message:', err);
            }
          });

          break;

        case 'media':
          // Forward audio to OpenAI
          console.log('[Voice Stream] Received media from Twilio, payload size:', data.media?.payload?.length || 0);
          if (openaiClient && data.media?.payload) {
            const audioBuffer = Buffer.from(data.media.payload, 'base64');
            console.log('[Voice Stream] Forwarding audio to OpenAI, buffer size:', audioBuffer.length);
            openaiClient.sendAudio(audioBuffer);
          } else {
            console.log('[Voice Stream] Skipping media - openaiClient:', !!openaiClient, 'payload:', !!data.media?.payload);
          }
          break;

        case 'stop':
          console.log('[Voice Stream] Call ended');
          
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

module.exports = {
  handleVoiceWebhook,
  handleVoiceStream
};
