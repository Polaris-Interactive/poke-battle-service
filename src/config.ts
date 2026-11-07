import { hostname } from 'node:os';

/**
 * Worker settings, from the environment. RabbitMQ and Redis use the same variables as AstralCore, so one environment
 * file serves the whole network.
 */
export interface WorkerConfig {
    workerId: string;
    /** Battles this process runs at once; one process uses one core. */
    capacity: number;
    rabbitmq: { host: string; port: number; username: string; password: string; vhost: string };
    redis: { host: string; port: number; username?: string; password?: string; db: number };
    /** A start older than this is dropped by RabbitMQ: the shard has given up waiting. */
    startTtlMs: number;
    /** A battle with no input for this long is aborted, and its Redis keys expire. */
    idleTimeoutSeconds: number;
    /** Turn timers run out in a row before a player counts as gone and the battle is aborted; 0 never. */
    absentTurns: number;
    /** How long an ended battle's keys stay, so a shard that missed the end can still settle it. */
    endedTtlSeconds: number;
    heartbeatIntervalMs: number;
    heartbeatTtlSeconds: number;
    /** How long SIGTERM waits for running battles before exiting. */
    drainTimeoutSeconds: number;
    formatsFile: string;
}

function integer(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw === '')
        return fallback;
    const value = Number.parseInt(raw, 10);
    if (!Number.isFinite(value))
        throw new Error(`${name} must be an integer, got ${raw}`);
    return value;
}

function text(name: string, fallback: string): string {
    const raw = process.env[name];
    return raw === undefined || raw === '' ? fallback : raw;
}

function optional(name: string): string | undefined {
    const raw = process.env[name];
    return raw === undefined || raw === '' ? undefined : raw;
}

export function loadConfig(): WorkerConfig {
    return {
        // Stable ids (host + index) reuse the same worker exchange across restarts
        workerId: text('WORKER_ID', `${hostname()}-${process.pid}`),
        capacity: integer('WORKER_CAPACITY', 50),
        rabbitmq: {
            host: text('RABBITMQ_HOST', 'localhost'),
            port: integer('RABBITMQ_PORT', 5672),
            username: text('RABBITMQ_USERNAME', 'guest'),
            password: text('RABBITMQ_PASSWORD', 'guest'),
            vhost: text('RABBITMQ_VHOST', '/'),
        },
        redis: {
            host: text('REDIS_HOST', 'localhost'),
            port: integer('REDIS_PORT', 6379),
            username: optional('REDIS_USERNAME'),
            password: optional('REDIS_PASSWORD'),
            db: integer('REDIS_DATABASE', 0),
        },
        startTtlMs: integer('START_TTL_MS', 10_000),
        idleTimeoutSeconds: integer('BATTLE_IDLE_TIMEOUT_SECONDS', 900),
        absentTurns: integer('ABSENT_TURNS', 3),
        endedTtlSeconds: integer('ENDED_TTL_SECONDS', 3_600),
        heartbeatIntervalMs: integer('HEARTBEAT_INTERVAL_MS', 1_000),
        heartbeatTtlSeconds: integer('HEARTBEAT_TTL_SECONDS', 5),
        drainTimeoutSeconds: integer('DRAIN_TIMEOUT_SECONDS', 600),
        formatsFile: text('FORMATS_FILE', 'config/formats.json'),
    };
}
