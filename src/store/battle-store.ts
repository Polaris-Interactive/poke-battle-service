import { Redis } from 'ioredis';

import { keys } from './keys.js';

export interface BattleMeta {
    workerId: string;
    shardId: string;
    format: string;
    seed: string;
}

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

    /** Keeps the keys of an ended battle a little longer, for investigations, then lets them expire. */
    finish(battleId: string, result: string): Promise<void>;

    heartbeat(workerId: string, battles: number, capacity: number, startedAt: number): Promise<void>;

    removeHeartbeat(workerId: string): Promise<void>;
}

// Claims the battle only if no worker owns it yet, and fills its metadata in the same step
const CLAIM_SCRIPT = `
if redis.call('HSETNX', KEYS[1], 'workerId', ARGV[1]) == 0 then
  return 0
end
redis.call('HSET', KEYS[1], 'shardId', ARGV[2], 'format', ARGV[3], 'seed', ARGV[4], 'turn', '0', 'createdAt', ARGV[5])
redis.call('EXPIRE', KEYS[1], ARGV[6])
return 1
`;

// Removes the claim only if it is still ours
const UNCLAIM_SCRIPT = `
if redis.call('HGET', KEYS[1], 'workerId') == ARGV[1] then
  redis.call('DEL', KEYS[1], KEYS[2])
end
return 1
`;

export class RedisBattleStore implements BattleStore {

    private static readonly ENDED_TTL_SECONDS = 300;

    constructor(private readonly redis: Redis, private readonly ttlSeconds: number,
                private readonly heartbeatTtlSeconds: number) {
    }

    async claim(battleId: string, meta: BattleMeta): Promise<boolean> {
        const claimed = await this.redis.eval(CLAIM_SCRIPT, 1, keys.battle(battleId), meta.workerId, meta.shardId,
            meta.format, meta.seed, Date.now(), this.ttlSeconds);
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

    async finish(battleId: string, result: string): Promise<void> {
        await this.redis.multi()
            .hset(keys.battle(battleId), 'result', result, 'endedAt', Date.now())
            .expire(keys.battle(battleId), RedisBattleStore.ENDED_TTL_SECONDS)
            .expire(keys.battleLog(battleId), RedisBattleStore.ENDED_TTL_SECONDS)
            .exec();
    }

    async heartbeat(workerId: string, battles: number, capacity: number, startedAt: number): Promise<void> {
        await this.redis.multi()
            .hset(keys.worker(workerId), 'battles', battles, 'capacity', capacity, 'startedAt', startedAt,
                'beatAt', Date.now())
            .expire(keys.worker(workerId), this.heartbeatTtlSeconds)
            .exec();
    }

    async removeHeartbeat(workerId: string): Promise<void> {
        await this.redis.del(keys.worker(workerId));
    }
}
