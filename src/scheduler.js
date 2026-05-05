const cron = require('node-cron');
const streamManager = require('./streamManager');

const scheduledJobs = new Map();

function init() {
  // Check every minute for scheduled streams
  cron.schedule('* * * * *', checkScheduledStreams);
  console.log('⏰ Scheduler initialized');
}

async function checkScheduledStreams() {
  const streams = streamManager.getAllStreams();
  const now = new Date();

  for (const stream of streams) {
    if (stream.status === 'scheduled' && stream.scheduledAt) {
      const scheduledTime = new Date(stream.scheduledAt);
      if (scheduledTime <= now) {
        console.log(`⏰ Triggering scheduled stream: ${stream.title}`);
        try {
          await streamManager.startStream(stream.id);
        } catch (err) {
          console.error(`Failed to start scheduled stream ${stream.id}:`, err);
        }
      }
    }
  }
}

function scheduleStream(stream) {
  console.log(`⏰ Stream "${stream.title}" scheduled for ${stream.scheduledAt}`);
}

function cancelSchedule(streamId) {
  const job = scheduledJobs.get(streamId);
  if (job) {
    job.stop();
    scheduledJobs.delete(streamId);
  }
}

module.exports = { init, scheduleStream, cancelSchedule };
