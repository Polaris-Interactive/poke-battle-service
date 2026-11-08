import ps from 'pokemon-showdown';

import type { BattleAi, ChoiceRequest } from './ai.js';
import type { BattleView, CreatureView } from './battle-view.js';

const { Dex } = ps;

type Move = ReturnType<typeof Dex.moves.get>;
type Member = NonNullable<ChoiceRequest['side']>['pokemon'][number];
type Active = NonNullable<ChoiceRequest['active']>[number];

const TARGETED = new Set(['normal', 'any', 'adjacentFoe']);
/** Targets that put a status move's effect on the opponent. */
const ON_FOE = new Set(['normal', 'any', 'adjacentFoe', 'allAdjacentFoes', 'allAdjacent', 'randomNormal', 'foeSide']);
const STAB = 1.5;
/** Power of a damaging move whose power the dex does not give (fixed damage, weight or speed based). */
const VARIABLE_POWER = 60;
/**
 * Roughly how much power takes 1% of a target's HP at equal levels and stats: a neutral 80 power move with STAB (120)
 * takes about 40%. Only used to tell whether a move is likely to finish the opponent.
 */
const POWER_PER_PERCENT = 3;

export interface HeuristicOptions {
    /**
     * Switches out when none of the active creature's moves can touch the opponent (all ×0, no useful status move)
     * and a teammate has a move that can. Otherwise it only switches when forced.
     */
    switchWhenWalled: boolean;
}

interface Scored {
    slot: number;
    /** Expected damage, or a small value for a useful status move. */
    score: number;
    damaging: boolean;
    /** Likely to knock the opponent out. */
    ko: boolean;
    accuracy: number;
    priority: number;
    /** 1-based foe position to aim at, in doubles. */
    target: number;
}

/**
 * Tiers 1 and 2 ({@code trainer}, {@code gym}): damage first. Each usable move is scored from the dex: base power ×
 * STAB × type effectiveness against the opponent's active creature × accuracy (× the attacker's better attacking stat
 * for its category). A move likely to knock the opponent out wins (the most accurate, then the fastest); otherwise the
 * best damage; status moves only count when nothing deals damage. Forced switches send in the bench member with the
 * best matchup.
 * <p>
 * Deterministic: a pure function of the request and the view, no random at all; ties go to the first slot. A recovered
 * battle therefore makes the same choice its first worker would have.
 */
export class HeuristicAi implements BattleAi {

    constructor(private readonly options: HeuristicOptions) {
    }

    choose(request: ChoiceRequest, view?: BattleView): string | null {
        if (request.wait)
            return null;
        // No PokeSMP format has team preview: keep the order
        if (request.teamPreview)
            return 'default';
        if (request.forceSwitch)
            return this.forcedSwitches(request, view);
        if (request.active)
            return request.active.map((active, index) => this.act(request, view, active, index)).join(', ');
        return 'default';
    }

    // ---- Moves ----

    private act(request: ChoiceRequest, view: BattleView | undefined, active: Active, index: number): string {
        const team = request.side?.pokemon ?? [];
        const self = team[index];
        const types = view?.team[index]?.types ?? [];
        const foes = view?.foes ?? [];
        const doubles = (request.active?.length ?? 1) > 1;

        const options = active.moves
            .map((move, slot) => ({ move, slot: slot + 1 }))
            .filter(({ move }) => !move.disabled && (move.pp === undefined || move.pp > 0))
            .map(({ move, slot }) => this.scoreMove(slot, dexMove(move.id), types, self, foes, view?.team[index]));
        // No usable move: the simulator turns move 1 into Struggle
        if (options.length === 0)
            return 'move 1';

        const best = pickMove(options);
        if (this.options.switchWhenWalled && !active.trapped && !active.maybeTrapped && walled(options)) {
            const bench = this.bestBenchMember(team, view, foes, new Set(), false, true);
            if (bench !== null)
                return `switch ${bench}`;
        }
        const move = active.moves[best.slot - 1]!;
        if (doubles && move.target !== undefined && TARGETED.has(move.target))
            return `move ${best.slot} ${best.target}`;
        return `move ${best.slot}`;
    }

    private scoreMove(slot: number, move: Move, types: readonly string[], self: Member | undefined,
                      foes: readonly (CreatureView | null)[], selfView: CreatureView | undefined): Scored {
        const base = { slot, accuracy: accuracyOf(move), priority: move.priority ?? 0 };
        if (move.category === 'Status')
            return { ...base, score: statusValue(move, foes[0] ?? null, selfView) * base.accuracy, damaging: false,
                ko: false, target: 1 };

        // Aim at the foe it hurts most; with no foe in view, as if neutral
        const targets = foes.length === 0 ? [null] : foes;
        let bestTarget = 1;
        let bestPower = -1;
        let ko = false;
        targets.forEach((foe, position) => {
            if (foes.length > 0 && foe === null)
                return;
            const power = effectivePower(move, types, self, foe);
            if (power > bestPower) {
                bestPower = power;
                bestTarget = position + 1;
                ko = foe !== null && power > 0 && power / POWER_PER_PERCENT >= foe.hpPercent;
            }
        });
        return { ...base, score: Math.max(0, bestPower) * base.accuracy * penalty(move), damaging: true, ko,
            target: bestTarget };
    }

    // ---- Switches ----

    private forcedSwitches(request: ChoiceRequest, view: BattleView | undefined): string {
        const team = request.side?.pokemon ?? [];
        const taken = new Set<number>();
        // After Revival Blessing, the "switch" picks a fainted member to revive instead
        const reviving = team.some(member => member.active && member.reviving);
        return request.forceSwitch!.map(forced => {
            if (!forced)
                return 'pass';
            const slot = this.bestBenchMember(team, view, view?.foes ?? [], taken, reviving, false);
            if (slot === null)
                return 'pass';
            taken.add(slot);
            return `switch ${slot}`;
        }).join(', ');
    }

    /**
     * The bench member with the best matchup against the first opposing creature: its best move's damage, divided by
     * how hard the opponent's types hit it, times its HP left. Null when none can come in (or, with
     * {@code mustHit}, none has a move that touches the opponent).
     *
     * @return its 1-based slot
     */
    private bestBenchMember(team: Member[], view: BattleView | undefined, foes: readonly (CreatureView | null)[],
                            taken: Set<number>, reviving: boolean, mustHit: boolean): number | null {
        const foe = foes.find(candidate => candidate !== null) ?? null;
        let best: number | null = null;
        let bestScore = -1;
        team.forEach((member, index) => {
            const slot = index + 1;
            const hp = hpFraction(member.condition);
            if (member.active || taken.has(slot) || (hp === 0) !== reviving)
                return;
            const types = view?.team[index]?.types ?? [];
            const offense = Math.max(0, ...(member.moves ?? [])
                .map(dexMove)
                .filter(move => move.exists && move.category !== 'Status')
                .map(move => effectivePower(move, types, member, foe) * accuracyOf(move) * penalty(move)));
            if (mustHit && offense <= 0)
                return;
            const score = (offense + 1) / defenseRisk(foe, types) * (reviving ? 1 : hp);
            if (score > bestScore) {
                bestScore = score;
                best = slot;
            }
        });
        return best;
    }
}

// ---- Scoring ----

function pickMove(options: Scored[]): Scored {
    const damaging = options.filter(option => option.damaging && option.score > 0);
    const kos = damaging.filter(option => option.ko);
    if (kos.length > 0)
        return first(kos, (a, b) => a.accuracy - b.accuracy || a.priority - b.priority || a.score - b.score);
    if (damaging.length > 0)
        return first(damaging, (a, b) => a.score - b.score);
    return first(options, (a, b) => a.score - b.score);
}

/** The greatest by {@code compare}, the earliest slot on ties (options are in slot order). */
function first(options: Scored[], compare: (a: Scored, b: Scored) => number): Scored {
    return options.reduce((best, option) => compare(option, best) > 0 ? option : best);
}

/** Nothing the active creature has can do anything to the opponent. */
function walled(options: Scored[]): boolean {
    return options.every(option => option.damaging ? option.score <= 0 : option.score < 1);
}

/**
 * Base power × hits × STAB × effectiveness × the attacker's stat for the move's category (relative to its other
 * attacking stat). 0 when the target is immune. A null target counts as neutral.
 */
function effectivePower(move: Move, types: readonly string[], self: Member | undefined,
                        foe: CreatureView | null): number {
    let power = move.basePower > 0 ? move.basePower : VARIABLE_POWER;
    if (move.ohko)
        power = 150;
    if (Array.isArray(move.multihit))
        // 2-5 hits: about 3
        power *= Math.min(3, (move.multihit[0]! + move.multihit[1]!) / 2);
    else if (typeof move.multihit === 'number')
        power *= move.multihit;
    if (types.includes(move.type) && !move.damage)
        power *= STAB;
    if (self?.stats !== undefined && !move.damage) {
        const physical = self.stats.atk;
        const special = self.stats.spa;
        const stat = move.category === 'Physical' ? physical : special;
        power *= stat / Math.max(1, physical, special);
    }
    if (foe !== null)
        power *= effectiveness(move, foe.types);
    return power;
}

function effectiveness(move: Move, types: readonly string[]): number {
    const typeList = [...types];
    if (typeList.length === 0)
        return 1;
    if (move.ignoreImmunity !== true && !Dex.getImmunity(move, typeList))
        return 0;
    if (move.flags.powder && typeList.includes('Grass'))
        return 0;
    // Fixed damage ignores weaknesses and resistances
    if (move.damage)
        return 1;
    return 2 ** Dex.getEffectiveness(move, typeList);
}

/** Moves that cost more than their damage: fainting, a charge turn, a recharge turn, a delay. */
function penalty(move: Move): number {
    if (move.selfdestruct)
        return 0.3;
    if (move.flags.charge || move.flags.futuremove)
        return 0.5;
    if (move.self?.volatileStatus === 'mustrecharge')
        return 0.7;
    return 1;
}

/**
 * A status move's worth, only used when no move deals damage: a major status on a foe that can take it (2), a
 * volatile on a foe or a boost (1), healing when hurt (3), anything else a token 0.1.
 */
function statusValue(move: Move, foe: CreatureView | null, self: CreatureView | undefined): number {
    const onFoe = ON_FOE.has(move.target);
    if (move.status && onFoe) {
        if (foe === null || foe.status !== '')
            return 0.1;
        const types = [...foe.types];
        if (!Dex.getImmunity(move.status, types) || effectiveness(move, types) === 0)
            return 0.1;
        return 2;
    }
    if ((move.heal || move.flags.heal) && !onFoe)
        return self !== undefined && self.hpPercent < 50 ? 3 : 0.1;
    if (move.volatileStatus && onFoe)
        return foe === null ? 0.1 : 1;
    if ((move.boosts && !onFoe) || move.self?.boosts)
        return 1;
    return 0.1;
}

/** How hard the foe's own types hit these types: the worst multiplier, at least 0.25 (an immunity still counts). */
function defenseRisk(foe: CreatureView | null, types: readonly string[]): number {
    if (foe === null || types.length === 0)
        return 1;
    const typeList = [...types];
    const worst = Math.max(...foe.types.map(type => Dex.getImmunity(type, typeList)
        ? 2 ** Dex.getEffectiveness(type, typeList)
        : 0));
    return Math.max(0.25, worst);
}

function accuracyOf(move: Move): number {
    return move.accuracy === true ? 1 : move.accuracy / 100;
}

/**
 * The dex move for a request's move id. Hidden Power, Return and Frustration carry their type or power after the id
 * ({@code return102}): the power is kept.
 */
function dexMove(id: string): Move {
    const move = Dex.moves.get(id);
    if (move.exists)
        return move;
    const match = /^([a-z]+?)(\d+)$/.exec(id);
    if (match === null)
        return move;
    const base = Dex.moves.get(match[1]!);
    if (!base.exists)
        return move;
    return Object.assign(Object.create(Object.getPrototypeOf(base) as object) as Move, base,
        { basePower: Number(match[2]) });
}

/** The fraction of HP left from a request condition ({@code 120/300 par}, {@code 0 fnt}). */
function hpFraction(condition: string): number {
    if (condition.endsWith(' fnt'))
        return 0;
    const [hp, max] = condition.split(' ')[0]!.split('/').map(Number);
    if (hp === undefined || max === undefined || !Number.isFinite(hp) || !Number.isFinite(max) || max <= 0)
        return 1;
    return hp / max;
}
