require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { handleVoiceWebhook, handleVoiceStream } = require('./handlers/voice-handler');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    service: 'voice-ai-server'
  });
});

// Twilio voice webhook endpoint
app.post('/webhooks/twilio/voice', handleVoiceWebhook);

// WebSocket connection handler
wss.on('connection', (ws, req) => {
  console.log('📞 New WebSocket connection established');
  
  // Extract callSid from URL if present
  const url = new URL(req.url, `http://${req.headers.host}`);
  const callSid = url.searchParams.get('callSid');
  
  handleVoiceStream(ws, callSid);
  
  ws.on('close', () => {
    console.log('📞 WebSocket connection closed');
  });
  
  ws.on('error', (error) => {
    console.error('📞 WebSocket error:', error);
  });
});

// Error handling
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🎙️  Voice AI Server running on port ${PORT}`);
  console.log(`📡 WebSocket endpoint: ws://localhost:${PORT}`);
  console.log(`🔗 Webhook endpoint: http://localhost:${PORT}/webhooks/twilio/voice`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing server...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
