require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const streamManager = require('./streamManager');
const scheduler = require('./scheduler');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true
}));
app.use(express.json());

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
app.use('/api/', limiter);

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── Stream endpoints ──────────────────────────────────────────────────────────

// GET all streams
app.get('/api/streams', (req, res) => {
  res.json(streamManager.getAllStreams());
});

// GET single stream
app.get('/api/streams/:id', (req, res) => {
  const stream = streamManager.getStream(req.params.id);
  if (!stream) return res.status(404).json({ error: 'Stream not found' });
  res.json(stream);
});

// POST create & start stream
app.post('/api/streams', async (req, res) => {
  try {
    const { title, playlist, streamKey, platform, bitrate, scheduledAt, duration } = req.body;
    if (!title || !playlist || !streamKey) {
      return res.status(400).json({ error: 'title, playlist, and streamKey are required' });
    }
    if (!Array.isArray(playlist) || playlist.length === 0) {
      return res.status(400).json({ error: 'playlist must be a non-empty array' });
    }

    const stream = {
      id: uuidv4(),
      title,
      playlist,       // [{name, driveUrl, driveId}]
      streamKey,
      platform: platform || 'youtube',
      bitrate: bitrate || 5000,
      scheduledAt: scheduledAt || null,
      duration: duration || null,   // minutes, null = unlimited
      status: scheduledAt ? 'scheduled' : 'starting',
      currentVideoIndex: 0,
      loopCount: 0,
      createdAt: new Date().toISOString(),
      startedAt: null,
      stoppedAt: null,
      logs: []
    };

    streamManager.addStream(stream);

    if (scheduledAt) {
      scheduler.scheduleStream(stream);
      stream.status = 'scheduled';
    } else {
      await streamManager.startStream(stream.id);
    }

    res.status(201).json(stream);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST stop stream
app.post('/api/streams/:id/stop', async (req, res) => {
  try {
    await streamManager.stopStream(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST restart stream
app.post('/api/streams/:id/restart', async (req, res) => {
  try {
    await streamManager.restartStream(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE stream
app.delete('/api/streams/:id', async (req, res) => {
  try {
    await streamManager.stopStream(req.params.id);
    streamManager.removeStream(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH update auto-stop duration
app.patch('/api/streams/:id/schedule-stop', (req, res) => {
  const { duration } = req.body;
  const stream = streamManager.getStream(req.params.id);
  if (!stream) return res.status(404).json({ error: 'Stream not found' });
  streamManager.setAutoStop(req.params.id, duration);
  res.json({ success: true });
});

// GET stream logs (last 100 lines)
app.get('/api/streams/:id/logs', (req, res) => {
  const stream = streamManager.getStream(req.params.id);
  if (!stream) return res.status(404).json({ error: 'Stream not found' });
  res.json({ logs: stream.logs.slice(-100) });
});

// ── Google Drive proxy ────────────────────────────────────────────────────────
// Returns the direct download URL for a Drive file
app.get('/api/gdrive/resolve', async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'url required' });
    const directUrl = resolveGDriveUrl(url);
    res.json({ directUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function resolveGDriveUrl(url) {
  // Handle various Google Drive URL formats
  const patterns = [
    /\/file\/d\/([^/]+)/,
    /id=([^&]+)/,
    /\/d\/([^/]+)/
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) {
      return `https://drive.google.com/uc?export=download&id=${match[1]}&confirm=t`;
    }
  }
  throw new Error('Cannot parse Google Drive URL');
}

// ── Platform RTMP URLs ────────────────────────────────────────────────────────
app.get('/api/platforms', (req, res) => {
  res.json({
    youtube: 'rtmp://a.rtmp.youtube.com/live2',
    youtube_backup: 'rtmp://b.rtmp.youtube.com/live2',
    tiktok: 'rtmp://push.tiktok.com/live',
    facebook: 'rtmps://live-api-s.facebook.com:443/rtmp',
    twitch: 'rtmp://live.twitch.tv/app',
    custom: ''
  });
});

app.listen(PORT, () => {
  console.log(`\n🚀 LoopStream Backend running on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
  scheduler.init();
});
