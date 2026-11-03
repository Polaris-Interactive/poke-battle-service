import type { BattleAi, ChoiceRequest, Random } from './ai.js';

const TARGETED = new Set(['normal', 'any', 'adjacentFoe']);

/**
 * Tier 0: a random legal choice. Wild creatures (fleeing comes with the fork) and the fallback of every other AI.
 */
export class RandomAi implements BattleAi {

    constructor(private readonly random: Random = Math.random) {
    }

    choose(request: ChoiceRequest): string | null {
        if (request.wait)
            return null;
        if (request.teamPreview)
            return 'default';
        if (request.forceSwitch)
            return this.forcedSwitches(request);
        if (request.active)
            return request.active.map(active => this.move(active, request.active!.length > 1)).join(', ');
        return 'default';
    }

    private move(active: NonNullable<ChoiceRequest['active']>[number], doubles: boolean): string {
        const usable = active.moves
            .map((move, index) => ({ move, slot: index + 1 }))
            .filter(({ move }) => !move.disabled && (move.pp === undefined || move.pp > 0));
        // No usable move: the simulator turns move 1 into Struggle
        if (usable.length === 0)
            return 'move 1';
        const { move, slot } = this.pick(usable);
        if (doubles && move.target !== undefined && TARGETED.has(move.target))
            return `move ${slot} ${1 + Math.floor(this.random() * 2)}`;
        return `move ${slot}`;
    }

    private forcedSwitches(request: ChoiceRequest): string {
        const team = request.side?.pokemon ?? [];
        const taken = new Set<number>();
        return request.forceSwitch!.map(forced => {
            if (!forced)
                return 'pass';
            const bench = team
                .map((pokemon, index) => ({ pokemon, slot: index + 1 }))
                .filter(({ pokemon, slot }) => !pokemon.active && !pokemon.condition.endsWith(' fnt') && !taken.has(slot));
            if (bench.length === 0)
                return 'pass';
            const { slot } = this.pick(bench);
            taken.add(slot);
            return `switch ${slot}`;
        }).join(', ');
    }

    private pick<T>(values: T[]): T {
        return values[Math.floor(this.random() * values.length)]!;
    }
}
