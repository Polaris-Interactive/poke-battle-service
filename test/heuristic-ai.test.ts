import ps from 'pokemon-showdown';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChoiceRequest } from '../src/ai/ai.js';
import type { BattleView, CreatureView } from '../src/ai/battle-view.js';
import { HeuristicAi } from '../src/ai/heuristic-ai.js';

const { Dex } = ps;

type Move = ReturnType<typeof Dex.moves.get>;

/** Moves are picked by what they do, never by name. */
const MOVES = Dex.moves.all().filter(move => move.exists && !move.isNonstandard && !move.isZ && !move.isMax);

function move(predicate: (move: Move) => boolean): string {
    const found = MOVES.find(candidate => predicate(candidate));
    if (found === undefined)
        throw new Error('no such move in the dex');
    return found.id;
}

/** A plain single-hit damaging move, no side effect on its user. */
function attack(type: string, power: number, accuracy: number | true = 100, priority = 0): string {
    return move(candidate => candidate.type === type && candidate.category !== 'Status'
        && candidate.basePower === power && candidate.accuracy === accuracy && candidate.priority === priority
        && !candidate.multihit && !candidate.flags.charge && !candidate.selfdestruct && !candidate.self
        && !candidate.damage && !candidate.ohko && !candidate.basePowerCallback);
}

function creature(types: string[], hpPercent = 100, status = ''): CreatureView {
    return { species: 'X', types, hpPercent, status, fainted: hpPercent === 0 };
}

function view(foe: CreatureView, team: CreatureView[] = [creature([])]): BattleView {
    return { team, foes: [foe] };
}

function moveRequest(moves: string[], bench: { condition: string; moves: string[] }[] = [],
                     active: Partial<NonNullable<ChoiceRequest['active']>[number]> = {}): ChoiceRequest {
    return {
        active: [{ moves: moves.map(id => ({ id, pp: 10 })), ...active }],
        side: { pokemon: [{ active: true, condition: '100/100', moves }, ...bench] },
    };
}

const trainer = new HeuristicAi({ switchWhenWalled: false });
const gym = new HeuristicAi({ switchWhenWalled: true });

afterEach(() => vi.restoreAllMocks());

describe('HeuristicAi', () => {
    it('picks the move that hits hardest by type', () => {
        const fire = attack('Fire', 80);
        const water = attack('Water', 80);
        expect(trainer.choose(moveRequest([water, fire]), view(creature(['Grass'])))).toBe('move 2');
        expect(trainer.choose(moveRequest([water, fire]), view(creature(['Fire'])))).toBe('move 1');
    });

    it('counts STAB', () => {
        const fire = attack('Fire', 80);
        const water = attack('Water', 80);
        const ownTypes = view(creature(['Normal']), [creature(['Fire'])]);
        expect(trainer.choose(moveRequest([water, fire]), ownTypes)).toBe('move 2');
    });

    it('never uses a move the opponent is immune to when another one hits', () => {
        const normal = move(candidate => candidate.type === 'Normal' && candidate.category === 'Physical'
            && candidate.basePower >= 100 && candidate.accuracy === 100 && !candidate.self && !candidate.selfdestruct
            && !candidate.flags.charge);
        const dark = attack('Dark', 80);
        expect(trainer.choose(moveRequest([normal, dark]), view(creature(['Ghost'])))).toBe('move 2');
    });

    it('goes for the sure knock-out on a weakened opponent, the strongest hit otherwise', () => {
        const strong = move(candidate => candidate.accuracy === 70 && candidate.basePower >= 110
            && candidate.category === 'Special' && !candidate.self);
        const type = Dex.moves.get(strong).type;
        const quick = move(candidate => candidate.priority > 0 && candidate.basePower === 40 && candidate.accuracy === 100
            && candidate.type === type && !candidate.self);
        const target = creature(['Normal']);
        // Both finish a creature at 5%: the one that cannot miss
        expect(trainer.choose(moveRequest([strong, quick]), view({ ...target, hpPercent: 5 }))).toBe('move 2');
        // At full HP: the best expected damage
        expect(trainer.choose(moveRequest([strong, quick]), view(target))).toBe('move 1');
    });

    it('uses a useful status move only when nothing deals damage', () => {
        const normal = attack('Normal', 40, 100);
        const paralysis = move(candidate => candidate.category === 'Status' && candidate.status === 'par'
            && candidate.type === 'Electric' && candidate.target === 'normal');
        // Damage first
        expect(trainer.choose(moveRequest([normal, paralysis]), view(creature(['Dark'])))).toBe('move 1');
        // Nothing hurts a Ghost here: paralyse it
        expect(trainer.choose(moveRequest([normal, paralysis]), view(creature(['Ghost'])))).toBe('move 2');
        // Gym does not switch out either: it has something useful to do
        const bench = [{ condition: '100/100', moves: [attack('Dark', 80)] }];
        expect(gym.choose(moveRequest([normal, paralysis], bench), view(creature(['Ghost']),
            [creature(['Normal']), creature(['Dark'])]))).toBe('move 2');
        // Already paralysed: no use, and the gym leader sends in a teammate that can hit
        expect(gym.choose(moveRequest([normal, paralysis], bench), view(creature(['Ghost'], 100, 'par'),
            [creature(['Normal']), creature(['Dark'])]))).toBe('switch 2');
    });

    it('trainer stays in when walled; gym switches to a teammate that can hit', () => {
        const normal = attack('Normal', 40, 100);
        const dark = attack('Dark', 80);
        const request = moveRequest([normal], [
            { condition: '50/100', moves: [normal] },
            { condition: '80/100', moves: [dark] },
        ]);
        const walled = view(creature(['Ghost']), [creature(['Normal']), creature(['Normal']), creature(['Dark'])]);
        expect(trainer.choose(request, walled)).toBe('move 1');
        expect(gym.choose(request, walled)).toBe('switch 3');
        // Unless trapped, or nobody can do better
        expect(gym.choose({ ...request, active: [{ ...request.active![0]!, trapped: true }] }, walled)).toBe('move 1');
        expect(gym.choose(moveRequest([normal], [{ condition: '80/100', moves: [normal] }]), walled)).toBe('move 1');
        // Not walled: no switch
        expect(gym.choose(request, view(creature(['Dark']), walled.team as CreatureView[]))).toBe('move 1');
    });

    it('sends in the best matchup on a forced switch, a fainted member after Revival Blessing', () => {
        const fire = attack('Fire', 80);
        const water = attack('Water', 80);
        const request: ChoiceRequest = {
            forceSwitch: [true],
            side: {
                pokemon: [
                    { active: true, condition: '0 fnt', moves: [fire] },
                    { condition: '100/100', moves: [water] },
                    { condition: '0 fnt', moves: [fire] },
                    { condition: '100/100', moves: [fire] },
                ],
            },
        };
        const team = [creature(['Fire'], 0), creature(['Water']), creature(['Fire'], 0), creature(['Fire'])];
        expect(trainer.choose(request, view(creature(['Grass']), team))).toBe('switch 4');
        expect(trainer.choose(request, view(creature(['Fire']), team))).toBe('switch 2');

        const reviving: ChoiceRequest = { ...request, side: { pokemon: request.side!.pokemon.map((member, index) =>
            index === 0 ? { ...member, condition: '50/100', reviving: true } : member) } };
        expect(trainer.choose(reviving, view(creature(['Grass']), team))).toBe('switch 3');
        expect(trainer.choose({ forceSwitch: [true], side: { pokemon: [{ active: true, condition: '0 fnt' }] } }))
            .toBe('pass');
    });

    it('handles wait, team preview, Struggle and disabled moves', () => {
        const fire = attack('Fire', 80);
        const water = attack('Water', 80);
        expect(trainer.choose({ wait: true })).toBeNull();
        expect(trainer.choose({ teamPreview: true })).toBe('default');
        expect(trainer.choose({ active: [{ moves: [{ id: fire, pp: 0 }] }] })).toBe('move 1');
        const disabled: ChoiceRequest = { active: [{ moves: [{ id: fire, pp: 5, disabled: true }, { id: water, pp: 5 }] }] };
        expect(trainer.choose(disabled, view(creature(['Grass'])))).toBe('move 2');
        // The only move left (a locked move, a recharge turn)
        expect(trainer.choose({ active: [{ moves: [{ id: water }] }] }, view(creature(['Grass'])))).toBe('move 1');
    });

    it('is deterministic: ties go to the first slot, and nothing random is drawn', () => {
        const random = vi.spyOn(Math, 'random');
        const fire = attack('Fire', 80);
        const other = move(candidate => candidate.id !== fire && candidate.type === 'Fire' && candidate.basePower === 80
            && candidate.accuracy === 100 && !candidate.self
            && !candidate.multihit && !candidate.flags.charge && candidate.priority === 0);
        for (let i = 0; i < 5; i++) {
            expect(trainer.choose(moveRequest([fire, other]), view(creature(['Grass'])))).toBe('move 1');
            expect(trainer.choose(moveRequest([other, fire]), view(creature(['Grass'])))).toBe('move 1');
        }
        expect(random).not.toHaveBeenCalled();
    });
});
