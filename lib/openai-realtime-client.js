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
            input_audio_format: 'pcm16',
            output_audio_format: 'pcm16',
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
        });
        
        resolve();
      });

      this.ws.on('error', (error) => {
        console.error('[OpenAI Realtime] Error:', error);
        reject(error);
      });

      this.ws.on('close', () => {
        console.log('[OpenAI Realtime] Disconnected');
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
