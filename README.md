# Voice AI Server

WebSocket server for handling Twilio voice calls with OpenAI Realtime API.

## 🎯 Purpose

This standalone server handles real-time voice AI calls through Twilio. It's separate from the main Next.js app because:
- Vercel has a 60-second timeout (voice calls need longer)
- WebSocket connections need to stay open for the duration of calls
- This server can run on Railway (or similar) with persistent connections

## 📁 Architecture

```
Main App (Vercel)          Voice Server (Railway)
├─ Web UI                 ├─ WebSocket handler
├─ APIs                   ├─ Twilio integration
├─ SMS agents ✅          ├─ OpenAI Realtime API
└─ Database access        └─ Voice AI conversations
```

## 🚀 Deployment Options

### Option 1: Railway (Recommended - $5/month)

**Perfect for production. No cold starts.**

#### Step 1: Push to GitHub

```bash
git add voice-server/
git commit -m "Add voice server"
git push
```

#### Step 2: Deploy to Railway

1. Go to [Railway.app](https://railway.app)
2. Sign in with GitHub
3. Click "New Project" → "Deploy from GitHub repo"
4. Select your repository
5. **IMPORTANT:** Set root directory to `voice-server`
6. Add environment variables (see below)
7. Deploy!

#### Step 3: Get Your URL

Railway will give you: `https://your-app.up.railway.app`

#### Step 4: Configure Twilio

1. Go to [Twilio Console](https://console.twilio.com/)
2. Find your phone number
3. Under "Voice & Fax" → "A CALL COMES IN":
   - Set to: `https://your-app.up.railway.app/webhooks/twilio/voice`
   - Method: `POST`
4. **IMPORTANT:** Leave SMS webhook unchanged (stays on Vercel)

---

### Option 2: Local Testing (Free with ngrok)

**For development only. Not for production.**

#### Step 1: Install Dependencies

```bash
cd voice-server
npm install
```

#### Step 2: Set Up Environment

```bash
cp .env.example .env
# Edit .env with your credentials
```

#### Step 3: Run Server

```bash
npm start
```

Server runs on `http://localhost:3001`

#### Step 4: Expose with ngrok

```bash
# In another terminal
ngrok http 3001
```

You'll get: `https://abc123.ngrok.io`

#### Step 5: Configure Twilio

Point voice webhook to: `https://abc123.ngrok.io/webhooks/twilio/voice`

**Note:** ngrok URL changes every restart on free tier.

---

## 🔐 Environment Variables

### Required Variables

```env
# Database (same as main app)
DATABASE_URL=postgresql://...

# OpenAI
OPENAI_API_KEY=sk-...

# Twilio
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...

# Server
PORT=3001
VOICE_SERVER_URL=https://your-app.up.railway.app
NODE_ENV=production
```

### Where to Get These

- **DATABASE_URL**: Same as your main app (from Vercel env vars)
- **OPENAI_API_KEY**: [OpenAI Dashboard](https://platform.openai.com/api-keys)
- **TWILIO_ACCOUNT_SID & AUTH_TOKEN**: [Twilio Console](https://console.twilio.com/)
- **VOICE_SERVER_URL**: Railway will provide this after deployment

---

## 🔧 How It Works

```
1. Customer calls Twilio number
   ↓
2. Twilio hits: /webhooks/twilio/voice
   ↓
3. Returns TwiML with WebSocket URL
   ↓
4. Twilio establishes WebSocket connection
   ↓
5. Server connects to OpenAI Realtime API
   ↓
6. Audio streams: Twilio ↔ Server ↔ OpenAI
   ↓
7. AI responds in real-time
   ↓
8. Can call functions (check availability, book appointments)
   ↓
9. Conversation logged to database
```

---

## 📊 Monitoring

### Health Check

```bash
curl https://your-app.up.railway.app/health
```

### Logs

**Railway:**
- View in Railway dashboard → Deployments → Logs

**Local:**
- Check terminal where `npm start` is running

---

## 🐛 Troubleshooting

### "WebSocket connection failed"

**Check:**
1. ✅ Server is running (`/health` endpoint responds)
2. ✅ `VOICE_SERVER_URL` env var is set correctly
3. ✅ Twilio webhook URL is correct
4. ✅ No typos in URL (https vs http, trailing slashes)

### "No audio on call"

**Check:**
1. ✅ `OPENAI_API_KEY` is valid
2. ✅ OpenAI account has credit
3. ✅ Check server logs for OpenAI connection errors

### "Phone number not found"

**Check:**
1. ✅ Phone number exists in database (`PhoneNumber` table)
2. ✅ `DATABASE_URL` is correct
3. ✅ Server can connect to database

### "Agent not responding"

**Check:**
1. ✅ AI Agent is created and active in your app
2. ✅ Agent is linked to the phone number
3. ✅ System prompt is set

---

## 💰 Cost Breakdown

### Railway Costs

- **Free Tier**: $0/month (500 hours = ~20 days)
- **Hobby Tier**: $5/month (unlimited, no cold starts) ← Recommended
- **Pro Tier**: $20/month (more resources)

### Other Costs

- **Twilio**: ~$0.01-0.05/minute for calls
- **OpenAI**: ~$0.06/minute for Realtime API
- **Total per call**: ~$0.07-0.11/minute

---

## 📝 Development

### Project Structure

```
voice-server/
├── server.js                 # Main Express server
├── package.json              # Dependencies
├── .env.example              # Environment template
├── handlers/
│   └── voice-handler.js      # Twilio ↔ OpenAI bridge
└── lib/
    └── openai-realtime-client.js  # OpenAI WebSocket client
```

### Adding New Functions

Edit `handlers/voice-handler.js`:

```javascript
// Add to tools array
{
  type: 'function',
  name: 'your_function',
  description: 'What it does',
  parameters: { /* ... */ }
}

// Add to executeFunctionCall switch
case 'your_function':
  result = await yourFunction(agencyId, args);
  break;
```

---

## 🔄 Updating

### Pull latest changes

```bash
git pull
```

### Railway auto-deploys on push

Just push to GitHub and Railway will automatically:
1. Pull changes
2. Install dependencies
3. Restart server
4. Zero downtime!

---

## ✅ Pre-Launch Checklist

Before going live with voice AI:

- [ ] Voice server deployed to Railway
- [ ] Environment variables configured
- [ ] Health check returns 200 OK
- [ ] Twilio voice webhook configured
- [ ] SMS webhook still points to Vercel (unchanged)
- [ ] Made test call - AI answers
- [ ] Verified conversation logs in database
- [ ] Upgraded Railway to Hobby tier (no cold starts)

---

## 🆘 Support

**If something's not working:**

1. Check Railway logs
2. Test `/health` endpoint
3. Verify all env vars are set
4. Check Twilio webhook configuration
5. Look for errors in main app database logs

**Common issues are usually:**
- ❌ Wrong env var values
- ❌ Typo in webhook URL  
- ❌ Database connection string incorrect
- ❌ OpenAI API key invalid/no credit

---

## 🎉 Success Criteria

**Voice AI is working when:**
- ✅ Call connects immediately (no cold start delay)
- ✅ AI greets caller within 2 seconds
- ✅ Voice quality is clear
- ✅ AI can check availability and book appointments
- ✅ Conversation appears in main app inbox
- ✅ No errors in logs

---

**Built with:** Express, WebSocket, OpenAI Realtime API, Twilio, Prisma
