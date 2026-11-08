import ps from 'pokemon-showdown';
import { describe, expect, it } from 'vitest';

import { createAi } from '../src/ai/registry.js';
import { Formats } from '../src/battle/formats.js';
import { BattleSession } from '../src/battle/session.js';
import type { BattleMemberState, BattleSide, BattleStartPacket } from '../src/codec/packets.js';
import { MemoryStore, RecordingOutbox, randomTeam, startPacket } from './fakes.js';

const { Dex, Teams } = ps;
const formats = Formats.load('config/formats.json');

function deps(outbox: RecordingOutbox, store: MemoryStore) {
    return { outbox, store, createAi, idleTimeoutSeconds: 60, absentTurns: 0, onClosed: () => undefined };
}

function run(start: BattleStartPacket, outbox = new RecordingOutbox(), store = new MemoryStore()) {
    const seed = BattleSession.prepare(start, { createAi });
    const session = BattleSession.run(start, seed, deps(outbox, store));
    return { session, outbox, store };
}

async function nextRequest(outbox: RecordingOutbox, count: number) {
    while (outbox.packets('BattleRequestPacket').length < count)
        await new Promise(resolve => setImmediate(resolve));
    return outbox.packets('BattleRequestPacket')[count - 1]!;
}

async function settle() {
    for (let i = 0; i < 5; i++)
        await new Promise(resolve => setImmediate(resolve));
}

function npc(slot: 'p1' | 'p2', ai: string, team = randomTeam()): BattleSide {
    return { slot, name: `Trainer ${slot}`, playerId: null, team, ai, state: [] };
}

function player(states: Partial<BattleMemberState>[] = []): BattleSide {
    const team = randomTeam();
    const size = Teams.unpack(team)!.length;
    const state = states.length === 0 ? [] : Array.from({ length: size }, (_, index) => ({
        hp: 9999, status: '', pp: [], maxPp: [], ...states[index] }));
    return { slot: 'p1', name: 'Player', playerId: crypto.randomUUID(), team, ai: '', state };
}

/** The AI choices of a battle's log: what a side chose, in order. */
function choices(log: string[], side: string): string[] {
    return log.filter(line => line.startsWith(`>${side} `));
}

describe('Trainer and gym formats', () => {
    it('are registered with their rules and PokeSMP choices', () => {
        expect(formats.has('polaristrainer')).toBe(true);
        expect(formats.has('polarisgym')).toBe(true);
        const trainer = Dex.formats.getRuleTable(Dex.formats.get('polaristrainer'));
        const gym = Dex.formats.getRuleTable(Dex.formats.get('polarisgym'));
        for (const rules of [trainer, gym]) {
            expect(rules.has('hppercentagemod')).toBe(true);
            expect(rules.has('teampreview')).toBe(false);
            expect(rules.has('speciesclause')).toBe(false);
        }
        expect(trainer.has('sleepclausemod')).toBe(false);
        expect(gym.has('sleepclausemod')).toBe(true);
        expect((Dex.formats.get('polaristrainer') as unknown as { polaris: object }).polaris)
            .toEqual({ capture: false, bag: true, flee: false });
        expect((Dex.formats.get('polarisgym') as unknown as { polaris: object }).polaris)
            .toEqual({ capture: false, bag: false, flee: false });
    });
});

describe('Trainer and gym AIs', () => {
    it('play a whole gym battle against each other, without a refused choice', async () => {
        const { session, outbox, store } = run(startPacket({ format: 'polarisgym' },
            [npc('p1', 'trainer'), npc('p2', 'gym')]));
        await session.done;

        const ended = outbox.packets('BattleEndedPacket')[0]!;
        expect(['p1', 'p2', 'tie']).toContain(ended.result);
        expect(ended.turns).toBeGreaterThan(0);
        // A refused AI choice is replaced by "default"
        const log = store.logs.get(session.battleId)!;
        expect(log.filter(line => /^>p[12] default$/.test(line))).toEqual([]);
        expect(choices(log, 'p2').length).toBeGreaterThan(0);
    });

    it('plays a whole trainer battle against a player', async () => {
        const outbox = new RecordingOutbox();
        const { session, store } = run(startPacket({ format: 'polaristrainer', allowBag: true },
            [player(), npc('p2', 'trainer')]), outbox);
        outbox.autoplay = (side, rqid, choice) => session.choose(side, rqid, choice);
        await session.done;

        const ended = outbox.packets('BattleEndedPacket')[0]!;
        expect(['p1', 'p2', 'tie']).toContain(ended.result);
        expect(outbox.packets('BattleChoiceErrorPacket')).toEqual([]);
        expect(choices(store.logs.get(session.battleId)!, 'p2')).not.toContain('>p2 default');
        // Hidden information: the player never gets the trainer's requests
        expect(outbox.packets('BattleRequestPacket').every(request => request.side === 'p1')).toBe(true);
    });

    it('choose the same from the same battle: a rerun and a recovery give the same choices', async () => {
        const start = startPacket({ format: 'polarisgym', seed: BattleSession.checkSeed('') },
            [npc('p1', 'gym'), npc('p2', 'trainer')]);
        const first = run(start);
        await first.session.done;
        const second = run({ ...start, battleId: crypto.randomUUID() });
        await second.session.done;
        const log = first.store.logs.get(start.battleId)!;
        expect(second.store.logs.get(second.session.battleId)).toEqual(log);

        // A worker died in the middle of the battle: the new one replays the log, and the AIs answer the requests still
        // pending, then the battle goes on exactly as it did. The simulator logs a turn's choices together, when the
        // last one comes in: a log always ends on a whole turn
        const turns = log.flatMap((line, index) => line.startsWith('>p1 ') ? [index] : []);
        const cut = turns[Math.floor(turns.length / 2)]!;
        const outbox = new RecordingOutbox();
        const store = new MemoryStore();
        const recovered = BattleSession.recover(start, start.seed, log.slice(0, cut), deps(outbox, store));
        await recovered.done;

        const rest = store.logs.get(start.battleId)!;
        expect(choices(rest, 'p2')).toEqual(choices(log.slice(cut), 'p2'));
        expect(choices(rest, 'p1')).toEqual(choices(log.slice(cut), 'p1'));
        expect(outbox.packets('BattleEndedPacket')[0]).toMatchObject({
            result: first.outbox.packets('BattleEndedPacket')[0]!.result,
            turns: first.outbox.packets('BattleEndedPacket')[0]!.turns,
        });
    });
});

describe('Choice gating', () => {
    async function errorsFor(start: BattleStartPacket, ...attempts: string[]) {
        const { session, outbox } = run(start);
        const request = await nextRequest(outbox, 1);
        for (const choice of attempts) {
            session.choose('p1', request.rqid, choice);
            await settle();
        }
        const errors = outbox.packets('BattleChoiceErrorPacket').map(error => error.message);
        const used = outbox.packets('BattleUpdatePacket').flatMap(update => update.lines)
            .filter(line => /^\|polaris-(ball|run|item)\|/.test(line));
        session.abort('test');
        await session.done;
        return { errors, used };
    }

    it('refuses the ball and fleeing in a trainer battle, even when the start allows capture', async () => {
        const { errors, used } = await errorsFor(startPacket({ format: 'polaristrainer', allowCapture: true,
            allowBag: true }, [player(), npc('p2', 'trainer')]), 'ball pokeball 3 1', 'run');
        expect(errors[0]).toMatch(/no capture in this battle/);
        expect(errors[1]).toMatch(/no fleeing from this battle/);
        expect(used).toEqual([]);
    });

    it('allows the bag in a trainer battle only when the start does', async () => {
        const allowed = await errorsFor(startPacket({ format: 'polaristrainer', allowBag: true },
            [player([{ hp: 1 }]), npc('p2', 'trainer')]), 'item potion 1 heal=20');
        expect(allowed.errors).toEqual([]);
        expect(allowed.used).toContainEqual(expect.stringMatching(/^\|polaris-item\|p1a: .+\|potion$/));

        const refused = await errorsFor(startPacket({ format: 'polaristrainer', allowBag: false },
            [player([{ hp: 1 }]), npc('p2', 'trainer')]), 'item potion 1 heal=20');
        expect(refused.errors[0]).toMatch(/no bag in this battle/);
        expect(refused.used).toEqual([]);
    });

    it('refuses the bag, the ball and fleeing in a gym battle, whatever the start says', async () => {
        const { errors, used } = await errorsFor(startPacket({ format: 'polarisgym', allowCapture: true,
            allowBag: true }, [player([{ hp: 1 }]), npc('p2', 'gym')]), 'item potion 1 heal=20', 'ball pokeball 3 1',
        'run');
        expect(errors[0]).toMatch(/no bag in this battle/);
        expect(errors[1]).toMatch(/no capture in this battle/);
        expect(errors[2]).toMatch(/no fleeing from this battle/);
        expect(used).toEqual([]);
    });

    it('refuses a start naming an unknown AI', () => {
        expect(() => BattleSession.prepare(startPacket({ format: 'polaristrainer' },
            [player(), npc('p2', 'champion')]), { createAi })).toThrow(/unknown AI champion/);
    });
});
