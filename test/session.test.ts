import ps from 'pokemon-showdown';
import { describe, expect, it } from 'vitest';

import { createAi } from '../src/ai/registry.js';
import { BattleSession } from '../src/battle/session.js';
import { Formats } from '../src/battle/formats.js';
import type { BattleStartPacket } from '../src/codec/packets.js';
import { MemoryStore, RecordingOutbox, randomTeam, startPacket } from './fakes.js';

const { BattleStream, Teams } = ps;
Formats.load('config/formats.json');

function run(start: BattleStartPacket, outbox = new RecordingOutbox(), store = new MemoryStore()) {
    const seed = BattleSession.prepare(start, { createAi });
    const session = BattleSession.run(start, seed, {
        outbox, store, createAi, idleTimeoutSeconds: 60, onClosed: () => undefined,
    });
    return { session, outbox, store };
}

async function nextRequest(outbox: RecordingOutbox, count: number) {
    while (outbox.packets('BattleRequestPacket').length < count)
        await new Promise(resolve => setImmediate(resolve));
    return outbox.packets('BattleRequestPacket')[count - 1]!;
}

describe('BattleSession', () => {
    it('plays a whole battle against the wild AI, in order', async () => {
        const outbox = new RecordingOutbox();
        const { session, store } = run(startPacket(), outbox);
        outbox.autoplay = (side, rqid, choice) => session.choose(side, rqid, choice);
        await session.done;

        const packets = outbox.sent.map(sent => sent.packet);
        // Gapless sequence, ended last, everything for the player's side and shard
        expect(packets.map(packet => packet.seq)).toEqual(packets.map((_, index) => index));
        expect(packets.at(-1)!.packet).toBe('BattleEndedPacket');
        expect(outbox.sent.every(sent => sent.shardId === 'shard-a')).toBe(true);

        const ended = outbox.packets('BattleEndedPacket')[0]!;
        expect(['p1', 'p2', 'tie']).toContain(ended.result);
        expect(ended.turns).toBeGreaterThan(0);
        expect(ended.teams.map(team => team.slot)).toEqual(['p1', 'p2']);
        const loser = ended.result === 'p1' ? 1 : 0;
        if (ended.result !== 'tie')
            expect(ended.teams[loser]!.members.every(member => member.hp === 0)).toBe(true);
        expect(outbox.packets('BattleUpdatePacket').every(update => update.side === 'p1')).toBe(true);
        expect(outbox.packets('BattleChoiceErrorPacket')).toEqual([]);
        expect(store.results.get(session.battleId)).toBe(ended.result);
    });

    it('never shows the player the opponent\'s hidden information', async () => {
        const outbox = new RecordingOutbox();
        const { session } = run(startPacket(), outbox);
        await nextRequest(outbox, 1);
        const lines = outbox.packets('BattleUpdatePacket').flatMap(update => update.lines);
        // The player sees its own exact HP but only a percentage of the opponent's
        expect(lines.some(line => line.startsWith('|split|'))).toBe(false);
        const opponent = lines.filter(line => line.startsWith('|switch|p2a:'));
        expect(opponent.length).toBeGreaterThan(0);
        expect(opponent.every(line => line.endsWith('|100/100'))).toBe(true);
        session.abort('test');
        await session.done;
    });

    it('refuses stale and malformed choices, and the request still stands', async () => {
        const outbox = new RecordingOutbox();
        const { session } = run(startPacket(), outbox);
        const request = await nextRequest(outbox, 1);

        session.choose('p1', request.rqid + 7, 'move 1');
        session.choose('p1', request.rqid, 'move 1\n>forcewin p1');
        session.choose('p1', request.rqid, 'move 9');
        await new Promise(resolve => setImmediate(resolve));

        const errors = outbox.packets('BattleChoiceErrorPacket');
        expect(errors.map(error => error.message)).toEqual([
            '[Invalid choice] stale request',
            '[Invalid choice] malformed',
            expect.stringContaining('[Invalid choice]'),
        ]);
        expect(errors.every(error => error.rqid === request.rqid || error.rqid === request.rqid + 7)).toBe(true);

        session.choose('p1', request.rqid, 'default');
        await nextRequest(outbox, 2);
        session.abort('test');
        await session.done;
    });

    it('ends on the shard\'s word: a forced win, or an abort with no winner', async () => {
        const won = run(startPacket());
        await nextRequest(won.outbox, 1);
        won.session.end('p1', 'capture');
        await won.session.done;
        expect(won.outbox.packets('BattleEndedPacket')[0]).toMatchObject({ result: 'p1', reason: 'capture' });

        const aborted = run(startPacket());
        await nextRequest(aborted.outbox, 1);
        aborted.session.end('aborted', 'player left');
        await aborted.session.done;
        expect(aborted.outbox.packets('BattleEndedPacket')[0]).toMatchObject({ result: 'aborted', reason: 'player left' });
    });

    it('re-sends the pending request to the shard the player re-attached from', async () => {
        const outbox = new RecordingOutbox();
        const { session, store } = run(startPacket(), outbox);
        const request = await nextRequest(outbox, 1);

        session.attach('shard-b');
        const resent = outbox.sent.at(-1)!;
        expect(resent.shardId).toBe('shard-b');
        expect(resent.packet).toMatchObject({ packet: 'BattleRequestPacket', rqid: request.rqid, request: request.request });
        expect(resent.packet.seq).toBe(outbox.sent.length - 1);
        expect(store.shards.get(session.battleId)).toBe('shard-b');

        session.abort('test');
        await session.done;
    });

    it('logs every input, enough to replay the battle identically', async () => {
        const outbox = new RecordingOutbox();
        const { session, store } = run(startPacket(), outbox);
        outbox.autoplay = (side, rqid, choice) => session.choose(side, rqid, choice);
        await session.done;

        const inputs = store.logs.get(session.battleId)!;
        expect(inputs.some(input => input.startsWith('>start '))).toBe(true);

        const replay = new BattleStream();
        void replay.write(inputs.join('\n'));
        const original = outbox.packets('BattleEndedPacket')[0]!;
        expect(replay.battle!.ended).toBe(true);
        expect(replay.battle!.turn).toBe(original.turns);
        const winner = replay.battle!.sides.find(side => side.name === replay.battle!.winner)?.id ?? 'tie';
        expect(winner).toBe(original.result);
    });

    it('starts creatures in the condition the shard sends and reports how every team left', async () => {
        const team = randomTeam();
        const size = Teams.unpack(team)!.length;
        const state = Array.from({ length: size }, (_, index) => index === 0
            ? { hp: 10, status: 'par', pp: [1], maxPp: [5] }
            : { hp: 9999, status: '', pp: [], maxPp: [] });
        const start = startPacket({}, [
            { slot: 'p1', name: 'Player', playerId: crypto.randomUUID(), team, ai: '', state },
            { slot: 'p2', name: 'Wild', playerId: null, team: randomTeam(), ai: 'wild', state: [] },
        ]);
        const { session, outbox, store } = run(start);
        const request = JSON.parse((await nextRequest(outbox, 1)).request);

        expect(request.side.pokemon[0].condition).toMatch(/^10\/\d+ par$/);
        expect(request.active[0].moves[0]).toMatchObject({ pp: 1, maxpp: 5 });
        // Before the leads switch in: no line shows the lead at full HP
        const lead = outbox.packets('BattleUpdatePacket').flatMap(update => update.lines)
            .find(line => line.startsWith('|switch|p1a:'))!;
        expect(lead).toMatch(/\|10\/\d+ par$/);

        session.abort('test');
        await session.done;
        const ended = outbox.packets('BattleEndedPacket')[0]!;
        expect(ended.teams.map(t => t.slot)).toEqual(['p1', 'p2']);
        expect(ended.teams[0]!.members).toHaveLength(size);
        expect(ended.teams[0]!.members[0]).toMatchObject({ hp: 10, status: 'par' });
        expect(ended.teams[0]!.members[0]!.pp[0]).toBe(1);
        expect(ended.teams[0]!.members[0]!.maxPp[0]).toBe(5);
        // Clamped to the maximum: before any switch, the request lists the team in start order
        expect(ended.teams[0]!.members[1]!.hp).toBe(Number(request.side.pokemon[1].condition.split('/')[0]));

        // The state is part of the logged input: a replay starts from it too
        const replay = new BattleStream();
        void replay.write(store.logs.get(session.battleId)!.join('\n'));
        expect(replay.battle!.sides[0]!.pokemon[0]!.hp).toBe(10);
        expect(replay.battle!.sides[0]!.pokemon[0]!.status).toBe('par');
    });

    it('refuses a fainted lead or a state per member mismatch', () => {
        const team = randomTeam();
        const size = Teams.unpack(team)!.length;
        const sides = (state: { hp: number; status: string; pp: number[]; maxPp: number[] }[]) => [
            { slot: 'p1', name: 'Player', playerId: null, team, ai: '', state },
            { slot: 'p2', name: 'Wild', playerId: null, team: randomTeam(), ai: 'wild', state: [] },
        ];
        const fresh = { hp: 1, status: '', pp: [], maxPp: [] };
        expect(() => BattleSession.prepare(startPacket({}, sides([fresh])), { createAi }))
            .toThrow(size === 1 ? /fainted/ : /states/);
        expect(() => BattleSession.prepare(startPacket({}, sides(Array(size).fill({ ...fresh, hp: 0 }))), { createAi }))
            .toThrow(/fainted/);
    });
});
