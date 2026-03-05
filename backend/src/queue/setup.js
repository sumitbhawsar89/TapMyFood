const { Queue } = require('bullmq');
const IORedis    = require('ioredis');

// Redis connection — used by BullMQ
const redisConnection = new IORedis({
  host:     process.env.REDIS_HOST     || 'localhost',
  port:     parseInt(process.env.REDIS_PORT) || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null,   // required for BullMQ
});

redisConnection.on('connect', () => console.log('✅ Redis connected'));
redisConnection.on('error',   (err) => console.error('❌ Redis error:', err.message));

// Message queue — incoming WhatsApp messages go here
// Worker picks them up and processes with AI
const messageQueue = new Queue('whatsapp-messages', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,                // retry 3 times on failure
    backoff: {
      type: 'exponential',
      delay: 2000,              // start with 2s, then 4s, then 8s
    },
    removeOnComplete: 100,      // keep last 100 completed jobs
    removeOnFail: 50,
  }
});

// Notification queue — sending WhatsApp messages to customers
const notificationQueue = new Queue('whatsapp-notifications', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: 50,
    removeOnFail: 50,
  }
});

module.exports = { messageQueue, notificationQueue, redisConnection };

