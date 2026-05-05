const ffmpeg = require('fluent-ffmpeg');
const { v4: uuidv4 } = require('uuid');

// In-memory store (use Redis/SQLite for production persistence)
const streams = new Map();
const processes = new Map(); // streamId -> ffmpeg process

const PLATFORM_RTMP = {
  youtube: 'rtmp://a.rtmp.youtube.com/live2',
  youtube_backup: 'rtmp://b.rtmp.youtube.com/live2',
  tiktok: 'rtmp://push.tiktok.com/live',
  facebook: 'rtmps://live-api-s.facebook.com:443/rtmp',
  twitch: 'rtmp://live.twitch.tv/app',
};

function log(stream, message, level = 'info') {
  const entry = { ts: new Date().toISOString(), level, message };
  stream.logs.push(entry);
  if (stream.logs.length > 500) stream.logs.shift();
  console.log(`[${stream.id.slice(0, 8)}] ${message}`);
}

function getAllStreams() {
  return Array.from(streams.values()).map(s => sanitize(s));
}

function getStream(id) {
  const s = streams.get(id);
  return s ? sanitize(s) : null;
}

function addStream(stream) {
  streams.set(stream.id, stream);
}

function removeStream(id) {
  streams.delete(id);
}

function sanitize(s) {
  // Don't expose stream key in list
  return { ...s, streamKey: s.streamKey ? '••••••••' : '' };
}

function getRtmpUrl(stream) {
  const base = PLATFORM_RTMP[stream.platform] || stream.platform;
  return `${base}/${stream.streamKey}`;
}

function resolveGDriveUrl(url) {
  if (!url) throw new Error('No URL provided');
  // Already a direct URL
  if (url.startsWith('https://drive.google.com/uc') || url.includes('export=download')) return url;
  const patterns = [/\/file\/d\/([^/]+)/, /id=([^&]+)/, /\/d\/([^/]+)/];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) {
      return `https://drive.google.com/uc?export=download&id=${match[1]}&confirm=t`;
    }
  }
  // Return as-is (might be direct URL)
  return url;
}

async function startStream(id) {
  const stream = streams.get(id);
  if (!stream) throw new Error('Stream not found');
  if (processes.has(id)) throw new Error('Stream already running');

  stream.status = 'active';
  stream.startedAt = new Date().toISOString();
  stream.currentVideoIndex = 0;
  stream.loopCount = 0;

  log(stream, `Stream started: ${stream.title}`);
  playNextVideo(id);

  // Auto-stop if duration set
  if (stream.duration) {
    setTimeout(() => {
      stopStream(id).catch(console.error);
    }, stream.duration * 60 * 1000);
  }
}

function playNextVideo(id) {
  const stream = streams.get(id);
  if (!stream || stream.status === 'stopped') return;

  const playlist = stream.playlist;
  const idx = stream.currentVideoIndex;
  const video = playlist[idx];

  if (!video) {
    stream.status = 'error';
    log(stream, 'No video in playlist', 'error');
    return;
  }

  const videoUrl = resolveGDriveUrl(video.driveUrl);
  const rtmpUrl = getRtmpUrl(stream);

  log(stream, `Playing [${idx + 1}/${playlist.length}]: ${video.name}`);
  stream.currentVideo = video.name;

  const proc = ffmpeg(videoUrl)
    .inputOptions([
      '-re',                     // read at native frame rate (crucial for live)
      '-reconnect 1',
      '-reconnect_streamed 1',
      '-reconnect_delay_max 5',
      '-user_agent "Mozilla/5.0"'
    ])
    .videoCodec('libx264')
    .audioCodec('aac')
    .videoBitrate(`${stream.bitrate}k`)
    .audioBitrate('128k')
    .audioFrequency(44100)
    .size('1280x720')
    .fps(30)
    .outputOptions([
      '-preset veryfast',
      '-g 60',                   // GOP size = 2x fps
      '-keyint_min 60',
      '-sc_threshold 0',
      '-b_strategy 0',
      '-ar 44100',
      '-pix_fmt yuv420p',
      '-flvflags no_duration_filesize',
      '-f flv'
    ])
    .output(rtmpUrl)
    .on('start', cmd => {
      log(stream, `FFmpeg started`);
    })
    .on('stderr', line => {
      // Only log important lines
      if (line.includes('error') || line.includes('Error')) {
        log(stream, line, 'error');
      }
    })
    .on('end', () => {
      log(stream, `Finished: ${video.name}`);
      processes.delete(id);

      const currentStream = streams.get(id);
      if (!currentStream || currentStream.status === 'stopped') return;

      // Advance to next video
      let nextIdx = idx + 1;
      if (nextIdx >= playlist.length) {
        nextIdx = 0; // Loop back
        currentStream.loopCount++;
        log(currentStream, `Playlist loop #${currentStream.loopCount} complete, restarting`);
      }
      currentStream.currentVideoIndex = nextIdx;

      // Small delay before next video
      setTimeout(() => playNextVideo(id), 1000);
    })
    .on('error', (err, stdout, stderr) => {
      log(stream, `FFmpeg error: ${err.message}`, 'error');
      processes.delete(id);

      const currentStream = streams.get(id);
      if (!currentStream || currentStream.status === 'stopped') return;

      currentStream.status = 'reconnecting';
      log(currentStream, 'Reconnecting in 5 seconds...');
      setTimeout(() => {
        currentStream.status = 'active';
        playNextVideo(id);
      }, 5000);
    });

  proc.run();
  processes.set(id, proc);
}

async function stopStream(id) {
  const stream = streams.get(id);
  if (!stream) return;

  stream.status = 'stopped';
  stream.stoppedAt = new Date().toISOString();
  log(stream, 'Stream stopped');

  const proc = processes.get(id);
  if (proc) {
    proc.kill('SIGKILL');
    processes.delete(id);
  }
}

async function restartStream(id) {
  await stopStream(id);
  const stream = streams.get(id);
  if (stream) {
    stream.status = 'active';
    stream.stoppedAt = null;
    stream.currentVideoIndex = 0;
    await startStream(id);
  }
}

function setAutoStop(id, durationMinutes) {
  const stream = streams.get(id);
  if (!stream) return;
  stream.duration = durationMinutes;
  log(stream, `Auto-stop set: ${durationMinutes} minutes`);
  setTimeout(() => stopStream(id), durationMinutes * 60 * 1000);
}

module.exports = {
  getAllStreams, getStream, addStream, removeStream,
  startStream, stopStream, restartStream, setAutoStop
};
