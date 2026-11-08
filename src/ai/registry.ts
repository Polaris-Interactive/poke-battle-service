import type { BattleAi } from './ai.js';
import { HeuristicAi } from './heuristic-ai.js';
import { RandomAi } from './random-ai.js';

/**
 * AI ids a start may give a side. An unknown id refuses the start, rather than silently playing like a wild creature.
 */
const FACTORIES: Record<string, () => BattleAi> = {
    wild: () => new RandomAi(),
    trainer: () => new HeuristicAi({ switchWhenWalled: false }),
    gym: () => new HeuristicAi({ switchWhenWalled: true }),
};

export function createAi(id: string): BattleAi | undefined {
    return FACTORIES[id]?.();
}

export function knownAi(id: string): boolean {
    return id in FACTORIES;
}
