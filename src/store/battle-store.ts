import { Redis } from 'ioredis';

import { keys } from './keys.js';

export interface BattleMeta {
    workerId: string;
    /** The worker process, new on every boot: a worker restarted with the same id does not hold its battles any more. */
    instance: string;
    shardId: string;
    format: string;
    seed: string;
    /** The start packet as JSON, what a recovering worker needs besides the log (AI ids, timer, rules). */
    start: string;
}

/**
 * What a worker taking over a battle gets: {@code taken} with what it needs to replay it, or why it cannot.
 * <ul>
 *     <li>missing: no such battle (expired, or never claimed);</li>
 *     <li>ended: the battle ended, its ended packet waits in Redis for the shard;</li>
 *     <li>alive: the worker running it still beats.</li>
 * </ul>
 */
export type TakeOver =
    | { status: 'taken'; seed: string; start: string; log: string[] }
    | { status: 'missing' | 'ended' | 'alive' };

/**
 * What the worker keeps in Redis: the claim that makes a battle run on one worker only, the simulator input log that
 * lets another worker replay it, and the heartbeat that tells the others this worker is alive.
 */
export interface BattleStore {
    /** @returns false if another worker already claimed the battle (a redelivered start) */
    claim(battleId: string, meta: BattleMeta): Promise<boolean>;

    /** Drops a claim whose battle could not start. */
    unclaim(battleId: string, workerId: string): Promise<void>;

    appendLog(battleId: string, inputs: string[]): Promise<void>;

    /** Keeps the battle's keys alive and records the turn. */
    touch(battleId: string, turn: number): Promise<void>;

    setShard(battleId: string, shardId: string): Promise<void>;

    /**
     * Moves a battle whose worker died to this worker, atomically: a battle is never taken twice, nor from a worker
     * still beating.
     */
    takeOver(battleId: string, workerId: string, instance: string): Promise<TakeOver>;

    /**
     * Marks the battle ended and keeps its ended packet (base64), for a shard that was not there to receive it (crashed,
     * or the player away): it settles the battle when the player comes back. Keys expire after a while.
     */
    finish(battleId: string, result: string, ended: string): Promise<void>;

    heartbeat(workerId: string, instance: string, battles: number, capacity: number, startedAt: number): Promise<void>;

    removeHeartbeat(workerId: string): Promise<void>;
}

// Claims the battle only if no worker owns it yet, and fills its metadata in the same step
const CLAIM_SCRIPT = `
if redis.call('HSETNX', KEYS[1], 'workerId', ARGV[1]) == 0 then
  return 0
end
redis.call('HSET', KEYS[1], 'instance', ARGV[7], 'shardId', ARGV[2], 'format', ARGV[3], 'seed', ARGV[4], 'turn', '0',
  'createdAt', ARGV[5], 'start', ARGV[8])
redis.call('EXPIRE', KEYS[1], ARGV[6])
return 1
`;

// Takes the battle from a dead worker: one whose heartbeat is gone or belongs to another process (restarted)
const TAKE_OVER_SCRIPT = `
local owner = redis.call('HGET', KEYS[1], 'workerId')
if not owner then
  return 'missing'
end
if redis.call('HEXISTS', KEYS[1], 'ended') == 1 then
  return 'ended'
end
local instance = redis.call('HGET', KEYS[1], 'instance')
if instance == ARGV[2] then
  return 'taken'
end
local beating = redis.call('HGET', ARGV[3] .. owner, 'instance')
if beating and beating == instance then
  return 'alive'
end
redis.call('HSET', KEYS[1], 'workerId', ARGV[1], 'instance', ARGV[2])
return 'taken'
`;

// Removes the claim only if it is still ours
const UNCLAIM_SCRIPT = `
if redis.call('HGET', KEYS[1], 'workerId') == ARGV[1] then
  redis.call('DEL', KEYS[1], KEYS[2])
end
return 1
`;

export class RedisBattleStore implements BattleStore {

    constructor(private readonly redis: Redis, private readonly ttlSeconds: number,
                private readonly heartbeatTtlSeconds: number, private readonly endedTtlSeconds: number) {
    }

    async claim(battleId: string, meta: BattleMeta): Promise<boolean> {
        const claimed = await this.redis.eval(CLAIM_SCRIPT, 1, keys.battle(battleId), meta.workerId, meta.shardId,
            meta.format, meta.seed, Date.now(), this.ttlSeconds, meta.instance, meta.start);
        return claimed === 1;
    }

    async unclaim(battleId: string, workerId: string): Promise<void> {
        await this.redis.eval(UNCLAIM_SCRIPT, 2, keys.battle(battleId), keys.battleLog(battleId), workerId);
    }

    async appendLog(battleId: string, inputs: string[]): Promise<void> {
        if (inputs.length === 0)
            return;
        await this.redis.multi()
            .rpush(keys.battleLog(battleId), ...inputs)
            .expire(keys.battleLog(battleId), this.ttlSeconds)
            .exec();
    }

    async touch(battleId: string, turn: number): Promise<void> {
        await this.redis.multi()
            .hset(keys.battle(battleId), 'turn', turn)
            .expire(keys.battle(battleId), this.ttlSeconds)
            .expire(keys.battleLog(battleId), this.ttlSeconds)
            .exec();
    }

    async setShard(battleId: string, shardId: string): Promise<void> {
        await this.redis.hset(keys.battle(battleId), 'shardId', shardId);
    }

    async takeOver(battleId: string, workerId: string, instance: string): Promise<TakeOver> {
        const status = await this.redis.eval(TAKE_OVER_SCRIPT, 1, keys.battle(battleId), workerId, instance,
            keys.worker('')) as TakeOver['status'];
        if (status !== 'taken')
            return { status };
        const [hash, log] = await Promise.all([
            this.redis.hgetall(keys.battle(battleId)),
            this.redis.lrange(keys.battleLog(battleId), 0, -1),
        ]);
        if (hash.start === undefined || hash.seed === undefined || log.length === 0)
            return { status: 'missing' };
        return { status, seed: hash.seed, start: hash.start, log };
    }

    async finish(battleId: string, result: string, ended: string): Promise<void> {
        await this.redis.multi()
            .hset(keys.battle(battleId), 'result', result, 'endedAt', Date.now(), 'ended', ended)
            .expire(keys.battle(battleId), this.endedTtlSeconds)
            .expire(keys.battleLog(battleId), this.endedTtlSeconds)
            .exec();
    }

    async heartbeat(workerId: string, instance: string, battles: number, capacity: number,
                    startedAt: number): Promise<void> {
        await this.redis.multi()
            .hset(keys.worker(workerId), 'instance', instance, 'battles', battles, 'capacity', capacity,
                'startedAt', startedAt, 'beatAt', Date.now())
            .expire(keys.worker(workerId), this.heartbeatTtlSeconds)
            .exec();
    }

    async removeHeartbeat(workerId: string): Promise<void> {
        await this.redis.del(keys.worker(workerId));
    }
}
