const WebSocket = require('ws');

const OPENAI_REALTIME_URL = 'wss://api.openai.com/v1/realtime';

class OpenAIRealtimeClient {
  constructor(config) {
    this.ws = null;
    this.sessionConfig = config;
    this.apiKey = process.env.OPENAI_API_KEY;
    
    if (!this.apiKey) {
      throw new Error('OPENAI_API_KEY environment variable is required');
    }
  }

  async connect() {
    return new Promise((resolve, reject) => {
      const url = `${OPENAI_REALTIME_URL}?model=${this.sessionConfig.model}`;
      
      this.ws = new WebSocket(url, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'OpenAI-Beta': 'realtime=v1'
        }
      });

      this.ws.on('open', () => {
        console.log('[OpenAI Realtime] Connected');
        
        // Configure session
        this.send({
          type: 'session.update',
          session: {
            voice: this.sessionConfig.voice,
            instructions: this.sessionConfig.instructions,
            tools: this.sessionConfig.tools || [],
            temperature: this.sessionConfig.temperature || 0.8,
            max_response_output_tokens: this.sessionConfig.max_response_output_tokens || 4096,
            input_audio_format: 'g711_ulaw',
            output_audio_format: 'g711_ulaw',
            input_audio_transcription: {
              model: 'whisper-1'
            },
            turn_detection: null  // Disable auto-turn detection - we'll manually trigger responses
          }
        });
        
        resolve();
      });

      this.ws.on('error', (error) => {
        console.error('[OpenAI Realtime] WebSocket Error:', error);
        console.error('[OpenAI Realtime] Error details:', {
          message: error.message,
          code: error.code,
          stack: error.stack
        });
        reject(error);
      });

      this.ws.on('close', (code, reason) => {
        console.log('[OpenAI Realtime] Disconnected');
        console.log('[OpenAI Realtime] Close code:', code);
        console.log('[OpenAI Realtime] Close reason:', reason?.toString() || 'No reason provided');
        
        // Common close codes
        if (code === 1000) console.log('[OpenAI Realtime] Normal closure');
        else if (code === 1006) console.error('[OpenAI Realtime] Abnormal closure - connection lost');
        else if (code === 1008) console.error('[OpenAI Realtime] Policy violation');
        else if (code === 1011) console.error('[OpenAI Realtime] Server error');
        else console.error('[OpenAI Realtime] Unexpected close code');
      });
    });
  }

  send(message) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  sendAudio(audioBuffer) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.send({
        type: 'input_audio_buffer.append',
        audio: audioBuffer.toString('base64')
      });
    }
  }

  commitAudio() {
    this.send({
      type: 'input_audio_buffer.commit'
    });
  }

  onMessage(callback) {
    if (this.ws) {
      this.ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          callback(message);
        } catch (error) {
          console.error('[OpenAI Realtime] Failed to parse message:', error);
          console.error('[OpenAI Realtime] Raw message data:', data.toString());
        }
      });
    }
  }

  close() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

module.exports = { OpenAIRealtimeClient };
