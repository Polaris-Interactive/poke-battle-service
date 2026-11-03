import type { Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import { beforeEach, describe, expect, it } from 'vitest';

import { RedisBattleStore } from '../src/store/battle-store.js';
import { keys } from '../src/store/keys.js';

describe('RedisBattleStore', () => {
    let redis: Redis;
    let store: RedisBattleStore;
    const meta = { workerId: 'worker-1', shardId: 'shard-a', format: 'polariswild', seed: 'sodium,00' };

    beforeEach(async () => {
        redis = new RedisMock() as unknown as Redis;
        await redis.flushall();
        store = new RedisBattleStore(redis, 900, 5);
    });

    it('lets only the first worker claim a battle', async () => {
        expect(await store.claim('b1', meta)).toBe(true);
        expect(await store.claim('b1', { ...meta, workerId: 'worker-2' })).toBe(false);

        expect(await redis.hgetall(keys.battle('b1'))).toMatchObject({ workerId: 'worker-1', shardId: 'shard-a', turn: '0' });
        expect(await redis.ttl(keys.battle('b1'))).toBeGreaterThan(0);
    });

    it('drops a claim only for its owner', async () => {
        await store.claim('b1', meta);
        await store.appendLog('b1', ['>start {}']);

        await store.unclaim('b1', 'worker-2');
        expect(await redis.exists(keys.battle('b1'))).toBe(1);

        await store.unclaim('b1', 'worker-1');
        expect(await redis.exists(keys.battle('b1'), keys.battleLog('b1'))).toBe(0);
        expect(await store.claim('b1', { ...meta, workerId: 'worker-2' })).toBe(true);
    });

    it('keeps the inputs in order and the keys of an ended battle briefly', async () => {
        await store.claim('b1', meta);
        await store.appendLog('b1', ['>start {}', '>player p1 {}']);
        await store.appendLog('b1', ['>p1 move 1']);
        expect(await redis.lrange(keys.battleLog('b1'), 0, -1)).toEqual(['>start {}', '>player p1 {}', '>p1 move 1']);

        await store.finish('b1', 'p1');
        expect(await redis.hget(keys.battle('b1'), 'result')).toBe('p1');
        expect(await redis.ttl(keys.battle('b1'))).toBeLessThanOrEqual(300);
    });

    it('beats with a short time to live', async () => {
        await store.heartbeat('worker-1', 3, 50, 1000);
        expect(await redis.hgetall(keys.worker('worker-1'))).toMatchObject({ battles: '3', capacity: '50' });
        expect(await redis.ttl(keys.worker('worker-1'))).toBeLessThanOrEqual(5);
        await store.removeHeartbeat('worker-1');
        expect(await redis.exists(keys.worker('worker-1'))).toBe(0);
    });
});
