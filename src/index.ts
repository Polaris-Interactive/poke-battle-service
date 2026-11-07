import { randomUUID } from 'node:crypto';

import { Redis } from 'ioredis';

import { BattleManager } from './battle/manager.js';
import { Formats } from './battle/formats.js';
import { loadConfig } from './config.js';
import { log } from './log.js';
import { Messaging } from './messaging/messaging.js';
import { RedisBattleStore } from './store/battle-store.js';

const config = loadConfig();
const formats = Formats.load(config.formatsFile);
const redis = new Redis({ ...config.redis, maxRetriesPerRequest: 3 });
// ioredis reconnects by itself; say so once in a while rather than on every attempt
let lastRedisWarning = 0;
redis.on('error', error => {
    if (Date.now() - lastRedisWarning < 10_000)
        return;
    lastRedisWarning = Date.now();
    log.warn('Redis unavailable, retrying', { error });
});
const store = new RedisBattleStore(redis, config.idleTimeoutSeconds, config.heartbeatTtlSeconds,
    config.endedTtlSeconds);
const startedAt = Date.now();
// This process: a worker restarted with the same id holds none of its old battles, so they can be taken over
const instance = randomUUID();

let messaging: Messaging;
const manager = new BattleManager({
    workerId: config.workerId,
    instance,
    capacity: config.capacity,
    idleTimeoutSeconds: config.idleTimeoutSeconds,
    absentTurns: config.absentTurns,
    formats,
    store,
    outbox: { send: (shardId, packet) => messaging.send(shardId, packet) },
    onCapacityChange: full => void (full ? messaging.pauseStarts() : messaging.resumeStarts()).catch(error =>
        log.error('Could not change start consumption', { error })),
});
messaging = new Messaging(config, {
    onStart: packet => manager.start(packet),
    onRecover: packet => manager.recover(packet),
    onCommand: packet => manager.command(packet),
});

const heartbeat = setInterval(() => {
    store.heartbeat(config.workerId, instance, manager.size, config.capacity, startedAt)
        .catch(error => log.warn('Heartbeat failed', { error }));
}, config.heartbeatIntervalMs);

let stopping = false;
async function shutdown(signal: string): Promise<void> {
    if (stopping)
        return;
    stopping = true;
    log.info('Draining before exit', { signal, battles: manager.size });
    await messaging.pauseStarts();
    await manager.drain(config.drainTimeoutSeconds * 1000);
    clearInterval(heartbeat);
    await store.removeHeartbeat(config.workerId).catch(() => undefined);
    await messaging.close().catch(() => undefined);
    redis.disconnect();
    log.info('Stopped');
    process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

try {
    await messaging.connect();
} catch (error) {
    log.error('Could not connect to RabbitMQ', { error, host: config.rabbitmq.host, port: config.rabbitmq.port });
    process.exit(1);
}
log.info('Battle worker ready', { workerId: config.workerId, capacity: config.capacity });
