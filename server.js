require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { handleVoiceWebhook, handleVoiceStream } = require('./handlers/voice-handler');

const app = express();
const server = http.createServer(app);

// ============================================================================
// LOG CAPTURE SYSTEM - Stores recent logs for debugging via /logs endpoint
// Last deploy trigger: 2026-02-03
// ============================================================================
const LOG_BUFFER_SIZE = 500;
const logBuffer = [];

function captureLog(level, args) {
  const timestamp = new Date().toISOString();
  const message = args.map(arg =>
    typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
  ).join(' ');

  logBuffer.push({ timestamp, level, message });

  // Keep buffer size limited
  while (logBuffer.length > LOG_BUFFER_SIZE) {
    logBuffer.shift();
  }
}

// Override console methods to capture logs
const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

console.log = (...args) => {
  captureLog('info', args);
  originalLog.apply(console, args);
};

console.error = (...args) => {
  captureLog('error', args);
  originalError.apply(console, args);
};

console.warn = (...args) => {
  captureLog('warn', args);
  originalWarn.apply(console, args);
};

// Create WebSocket server WITHOUT auto-attaching (GHL-style)
const wss = new WebSocket.Server({ noServer: true });

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check endpoint with WebSocket stats
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'voice-ai-server',
    activeConnections: wss.clients.size
  });
});

// ============================================================================
// LOGS ENDPOINT - Returns recent logs for debugging
// ============================================================================
app.get('/logs', (req, res) => {
  const level = req.query.level; // Optional filter: info, warn, error
  const limit = Math.min(parseInt(req.query.limit) || 200, LOG_BUFFER_SIZE);
  const format = req.query.format || 'text'; // text or json

  let logs = level
    ? logBuffer.filter(l => l.level === level)
    : logBuffer;

  logs = logs.slice(-limit);

  if (format === 'json') {
    res.json({
      count: logs.length,
      logs: logs
    });
  } else {
    // Plain text format for easy reading
    const text = logs.map(l =>
      `[${l.timestamp}] [${l.level.toUpperCase()}] ${l.message}`
    ).join('\n');

    res.type('text/plain').send(text || 'No logs yet');
  }
});

// Clear logs endpoint
app.post('/logs/clear', (req, res) => {
  logBuffer.length = 0;
  res.json({ success: true, message: 'Logs cleared' });
});

// Twilio voice webhook endpoint
app.post('/webhooks/twilio/voice', handleVoiceWebhook);

// Manual WebSocket upgrade handler with path routing (GHL-style)
server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
  
  console.log('🔄 WebSocket upgrade request:', {
    pathname,
    host: request.headers.host,
    origin: request.headers.origin,
    upgrade: request.headers.upgrade,
    connection: request.headers.connection
  });

  // Only handle /media-stream path
  if (pathname === '/media-stream') {
    try {
      // Validate upgrade headers
      if (request.headers.upgrade !== 'websocket') {
        console.error('❌ Invalid upgrade header:', request.headers.upgrade);
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        socket.destroy();
        return;
      }

      wss.handleUpgrade(request, socket, head, (ws) => {
        console.log('✅ WebSocket upgraded successfully to /media-stream');
        wss.emit('connection', ws, request);
      });
    } catch (error) {
      console.error('❌ WebSocket upgrade failed:', error);
      socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
      socket.destroy();
    }
  } else {
    console.warn('⚠️  Upgrade request to invalid path:', pathname);
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
  }
});

// WebSocket connection handler
wss.on('connection', (ws, req) => {
  console.log('📞 New WebSocket connection established');
  console.log('🔗 Connection details:', {
    url: req.url,
    headers: {
      origin: req.headers.origin,
      userAgent: req.headers['user-agent']
    }
  });
  
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
  console.log(`📡 WebSocket endpoint: ws://localhost:${PORT}/media-stream`);
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
// Deploy trigger: Tue, Feb  3, 2026  4:45:10 PM
