import { describe, expect, it } from 'vitest';

import { BattleManager } from '../src/battle/manager.js';
import { Formats } from '../src/battle/formats.js';
import { MemoryStore, RecordingOutbox, randomTeam, startPacket } from './fakes.js';

function manager(capacity = 2, store = new MemoryStore()) {
    const capacityChanges: boolean[] = [];
    const instance = new BattleManager({
        workerId: 'worker-1',
        capacity,
        idleTimeoutSeconds: 60,
        formats: Formats.load('config/formats.json'),
        store,
        outbox: new RecordingOutbox(),
        onCapacityChange: full => capacityChanges.push(full),
    });
    return { instance, store, capacityChanges };
}

describe('BattleManager', () => {
    it('claims, runs and answers a valid start', async () => {
        const { instance, store } = manager();
        const start = startPacket();
        const outcome = await instance.start(start);

        expect(outcome).toEqual({ kind: 'reply', reply: expect.objectContaining({ accepted: true, workerId: 'worker-1' }) });
        expect(store.claims.get(start.battleId)).toMatchObject({ workerId: 'worker-1', shardId: 'shard-a' });
        expect(store.claims.get(start.battleId)!.seed).toMatch(/^sodium,/);
        await instance.drain(0);
    });

    it('drops a start another worker already claimed', async () => {
        const { instance, store } = manager();
        const start = startPacket();
        await store.claim(start.battleId, { workerId: 'worker-2', shardId: 'shard-a', format: 'polariswild', seed: 'x' });

        expect(await instance.start(start)).toEqual({ kind: 'drop' });
        expect(instance.size).toBe(0);
    });

    it.each([
        ['an unknown format', startPacket({ format: 'polarisnope' }), /unknown format/],
        ['an unknown AI', startPacket({}, [
            { slot: 'p1', name: 'A', playerId: null, team: randomTeam(), ai: '' },
            { slot: 'p2', name: 'B', playerId: null, team: randomTeam(), ai: 'grandmaster' },
        ]), /unknown AI/],
        ['an invalid team', startPacket({}, [
            { slot: 'p1', name: 'A', playerId: null, team: 'not a team', ai: '' },
            { slot: 'p2', name: 'B', playerId: null, team: randomTeam(), ai: 'wild' },
        ]), /unknown species|invalid team/],
        ['misnumbered sides', startPacket({}, [
            { slot: 'p2', name: 'A', playerId: null, team: randomTeam(), ai: '' },
            { slot: 'p1', name: 'B', playerId: null, team: randomTeam(), ai: 'wild' },
        ]), /side 1 must be p1/],
        ['an invalid seed', startPacket({ seed: 'nope' }), /invalid seed/],
    ])('refuses %s without claiming it', async (_, start, reason) => {
        const { instance, store } = manager();
        const outcome = await instance.start(start);

        expect(outcome.kind).toBe('reply');
        expect(outcome.kind === 'reply' && outcome.reply).toMatchObject({ accepted: false, reason: expect.stringMatching(reason) });
        expect(store.claims.size).toBe(0);
    });

    it('stops taking starts when full and resumes when a battle ends', async () => {
        const { instance, capacityChanges } = manager(1);
        const first = startPacket();
        await instance.start(first);

        expect(instance.full).toBe(true);
        expect(await instance.start(startPacket())).toEqual({ kind: 'requeue' });
        expect(capacityChanges).toEqual([true]);

        instance.command({ packet: 'BattleEndPacket', battleId: first.battleId, result: 'aborted', reason: 'test' });
        await instance.drain(1000);
        expect(instance.full).toBe(false);
        expect(capacityChanges).toEqual([true, false]);
    });
});

describe('Formats', () => {
    it('refuses a definition whose name does not give its id, or with an unknown rule', () => {
        expect(() => Formats.register({ polarisx: { name: 'Polaris Y', mod: 'gen9', gameType: 'singles', ruleset: [] } }))
            .toThrow(/has the id polarisy/);
        expect(() => Formats.register({ polarisz: { name: 'Polaris Z', mod: 'gen9', gameType: 'singles', ruleset: ['Nope Clause'] } }))
            .toThrow();
    });
});
