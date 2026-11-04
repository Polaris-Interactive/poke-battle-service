import ps from 'pokemon-showdown';
import { describe, expect, it } from 'vitest';

import { createAi } from '../src/ai/registry.js';
import { Formats } from '../src/battle/formats.js';
import { parseEffects } from '../src/battle/polaris-choices.js';
import { BattleSession } from '../src/battle/session.js';
import type { BattleMemberState, BattleStartPacket } from '../src/codec/packets.js';
import { MemoryStore, RecordingOutbox, randomTeam, startPacket } from './fakes.js';

const { BattleStream, Teams } = ps;
Formats.load('config/formats.json');

function run(start: BattleStartPacket) {
    const outbox = new RecordingOutbox();
    const store = new MemoryStore();
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

async function settle() {
    for (let i = 0; i < 5; i++)
        await new Promise(resolve => setImmediate(resolve));
}

function lines(outbox: RecordingOutbox): string[] {
    return outbox.packets('BattleUpdatePacket').flatMap(update => update.lines);
}

/** A player team whose members start in the given condition (missing ones fresh). */
function withState(states: Partial<BattleMemberState>[], options: Partial<BattleStartPacket> = {}): BattleStartPacket {
    const team = randomTeam();
    const size = Teams.unpack(team)!.length;
    const state = Array.from({ length: size }, (_, index) => ({ hp: 9999, status: '', pp: [], maxPp: [],
        ...states[index] }));
    return startPacket({ allowCapture: true, allowBag: true, ...options }, [
        { slot: 'p1', name: 'Player', playerId: crypto.randomUUID(), team, ai: '', state },
        { slot: 'p2', name: 'Wild', playerId: null, team: randomTeam(), ai: 'wild', state: [] },
    ]);
}

describe('Ball', () => {
    it('ends the battle with the thrower\'s win when the shard\'s roll caught the creature', async () => {
        const { session, outbox } = run(startPacket({ allowCapture: true }));
        const request = await nextRequest(outbox, 1);
        session.choose('p1', request.rqid, 'ball pokeball 3 1');
        await session.done;

        expect(lines(outbox)).toContainEqual(expect.stringMatching(/^\|polaris-ball\|p2a: .+\|pokeball\|3\|caught$/));
        expect(outbox.packets('BattleEndedPacket')[0]).toMatchObject({ result: 'p1', reason: 'captured' });
        // The caught creature's condition comes back with the others
        expect(outbox.packets('BattleEndedPacket')[0]!.teams[1]!.members[0]!.hp).toBeGreaterThan(0);
    });

    it('uses the turn when the creature breaks free, and the battle goes on', async () => {
        const { session, outbox } = run(startPacket({ allowCapture: true }));
        const first = await nextRequest(outbox, 1);
        session.choose('p1', first.rqid, 'ball pokeball 1 0');
        const second = await nextRequest(outbox, 2);

        expect(lines(outbox)).toContainEqual(expect.stringMatching(/^\|polaris-ball\|p2a: .+\|pokeball\|1\|free$/));
        expect(second.rqid).toBeGreaterThan(first.rqid);
        // The opponent still had its move (unless it fainted from something else first)
        expect(lines(outbox).some(line => line.startsWith('|move|p2a:'))).toBe(true);
        expect(outbox.packets('BattleEndedPacket')).toEqual([]);
        session.abort('test');
        await session.done;
    });

    it('is refused when the battle or the format does not allow it, or when malformed', async () => {
        const { session, outbox } = run(startPacket({ allowCapture: false }));
        const request = await nextRequest(outbox, 1);
        session.choose('p1', request.rqid, 'ball pokeball 3 1');
        await settle();
        session.choose('p1', request.rqid, 'ball pokeball 4 1');
        await settle();

        const errors = outbox.packets('BattleChoiceErrorPacket').map(error => error.message);
        expect(errors[0]).toMatch(/no capture in this battle/);
        expect(errors[1]).toMatch(/no capture in this battle/);

        const allowed = run(startPacket({ allowCapture: true }));
        const pending = await nextRequest(allowed.outbox, 1);
        allowed.session.choose('p1', pending.rqid, 'ball Poke-Ball 3 1');
        await settle();
        expect(allowed.outbox.packets('BattleChoiceErrorPacket')[0]!.message).toMatch(/expected "ball/);
        expect(allowed.outbox.packets('BattleEndedPacket')).toEqual([]);

        session.abort('test');
        allowed.session.abort('test');
        await Promise.all([session.done, allowed.session.done]);
    });
});

describe('Run', () => {
    it('escapes sooner or later (each failure raises the odds) and ends with no winner', async () => {
        const { session, outbox, store } = run(startPacket());
        outbox.autoplay = (side, rqid, choice) => {
            const request = JSON.parse(outbox.packets('BattleRequestPacket').at(-1)!.request);
            session.choose(side, rqid, request.forceSwitch ? choice : 'run');
        };
        // The first request was sent before autoplay was set
        const first = await nextRequest(outbox, 1);
        session.choose('p1', first.rqid, 'run');
        await session.done;

        const runs = lines(outbox).filter(line => line.startsWith('|polaris-run|'));
        const ended = outbox.packets('BattleEndedPacket')[0]!;
        // A trapped creature would be refused: random teams rarely trap, but then the battle is lost or aborted
        if (outbox.packets('BattleChoiceErrorPacket').length === 0) {
            expect(ended).toMatchObject({ result: 'fled', reason: 'p1 fled' });
            expect(runs.at(-1)).toMatch(/\|escaped$/);
            expect(runs.slice(0, -1).every(line => line.endsWith('|failed'))).toBe(true);

            // Flee odds come from the battle's random: a replay of the log flees on the same turn
            const replay = new BattleStream();
            void replay.write(store.logs.get(session.battleId)!.join('\n'));
            expect(replay.battle!.ended).toBe(true);
            expect(replay.battle!.turn).toBe(ended.turns);
        }
    });
});

describe('Bag', () => {
    it('heals a hurt creature and takes its turn', async () => {
        const { session, outbox } = run(withState([{ hp: 1 }]));
        const request = await nextRequest(outbox, 1);
        // Usually 1, unless a form change on switch-in rescaled it
        const before = Number.parseInt(JSON.parse(request.request).side.pokemon[0].condition, 10);
        session.choose('p1', request.rqid, 'item potion 1 heal=20');
        await nextRequest(outbox, 2);

        // Before any move: the line right after the item is its effect
        const log = lines(outbox);
        const used = log.findIndex(line => /^\|polaris-item\|p1a: .+\|potion$/.test(line));
        expect(used).toBeGreaterThan(-1);
        expect(log[used + 1]).toMatch(new RegExp(`^\\|-heal\\|p1a: .+\\|${before + 20}\\/\\d+$`));
        session.abort('test');
        await session.done;
    });

    it('refuses an item that would do nothing, so it is never spent for nothing', async () => {
        const { session, outbox } = run(withState([]));
        const request = await nextRequest(outbox, 1);
        session.choose('p1', request.rqid, 'item potion 1 heal=20');
        await settle();
        session.choose('p1', request.rqid, 'item revive 1 revive=0.5');
        await settle();

        const errors = outbox.packets('BattleChoiceErrorPacket').map(error => error.message);
        expect(errors).toHaveLength(2);
        expect(errors.every(message => /would have no effect/.test(message))).toBe(true);
        expect(lines(outbox).some(line => line.startsWith('|polaris-item|'))).toBe(false);
        session.abort('test');
        await session.done;
    });

    it('brings a fainted member along, revives it from the bag, and it can be sent in', async () => {
        const start = withState([{}, { hp: 0 }]);
        if (Teams.unpack(start.sides[0]!.team)!.length < 2)
            return;
        const { session, outbox } = run(start);
        const first = JSON.parse((await nextRequest(outbox, 1)).request);
        expect(first.side.pokemon[1].condition).toBe('0 fnt');

        session.choose('p1', first.rqid, 'switch 2');
        await settle();
        expect(outbox.packets('BattleChoiceErrorPacket')[0]!.message).toMatch(/fainted/);

        session.choose('p1', first.rqid, 'item revive 2 revive=0.5');
        const second = JSON.parse((await nextRequest(outbox, 2)).request);
        expect(lines(outbox)).toContainEqual(expect.stringMatching(/^\|polaris-item\|p1: .+\|revive$/));
        const revived = second.side.pokemon[1].condition as string;
        const [hp, max] = revived.split('/').map(Number);
        expect(hp).toBe(Math.floor(max! * 0.5));

        // It can be sent in (a forced switch if the lead fainted meanwhile, a plain one otherwise), unless trapped
        if (second.active?.[0]?.trapped || second.active?.[0]?.maybeTrapped) {
            session.abort('test');
            await session.done;
            return;
        }
        const switchesBefore = lines(outbox).filter(line => line.startsWith('|switch|p1a:')).length;
        session.choose('p1', second.rqid, 'switch 2');
        await nextRequest(outbox, 3);
        expect(outbox.packets('BattleChoiceErrorPacket')).toHaveLength(1);
        expect(lines(outbox).filter(line => line.startsWith('|switch|p1a:')).length).toBe(switchesBefore + 1);
        session.abort('test');
        await session.done;
    });

    it('does not count fainted members: the battle ends when the standing ones faint', async () => {
        const start = withState([{}, { hp: 0 }, { hp: 0 }, { hp: 0 }, { hp: 0 }, { hp: 0 }]);
        const { session, outbox } = run(start);
        outbox.autoplay = (side, rqid, choice) => session.choose(side, rqid, choice);
        const first = await nextRequest(outbox, 1);
        session.choose('p1', first.rqid, 'default');
        await session.done;
        expect(['p1', 'p2', 'tie']).toContain(outbox.packets('BattleEndedPacket')[0]!.result);
    });

    it('parses effects strictly', () => {
        expect(parseEffects('heal=20+cure')).toEqual([{ kind: 'heal', amount: 20 }, { kind: 'cure' }]);
        expect(parseEffects('heal')).toEqual([{ kind: 'heal', amount: null }]);
        expect(parseEffects('revive=0.5+pp')).toEqual([{ kind: 'revive', fraction: 0.5 }, { kind: 'pp', amount: null }]);
        for (const invalid of ['', 'heal=-1', 'revive', 'revive=2', 'cure=1', 'boost=1', 'heal=1=2'])
            expect(parseEffects(invalid)).toBeNull();
    });
});

describe('Turn timer', () => {
    it('chooses for the player when the time runs out, and tells the shard', async () => {
        const { session, outbox } = run(startPacket({ turnTimerSeconds: 1 }));
        const first = await nextRequest(outbox, 1);
        const second = await nextRequest(outbox, 2);

        expect(second.rqid).toBeGreaterThan(first.rqid);
        expect(lines(outbox)).toContain('|polaris-timer|p1');
        session.abort('test');
        await session.done;
    }, 5_000);

    it('does not fire once the player has chosen', async () => {
        const { session, outbox } = run(startPacket({ turnTimerSeconds: 1 }));
        const first = await nextRequest(outbox, 1);
        session.choose('p1', first.rqid, 'default');
        await nextRequest(outbox, 2);
        session.abort('test');
        await session.done;
        await new Promise(resolve => setTimeout(resolve, 1_200));
        expect(lines(outbox)).not.toContain('|polaris-timer|p1');
    }, 5_000);
});
