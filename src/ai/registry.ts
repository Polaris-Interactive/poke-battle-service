import type { BattleAi } from './ai.js';
import { RandomAi } from './random-ai.js';

/**
 * AI ids a start may give a side. Stronger tiers (trainer, gym, boss) are added here; until then they are unknown and
 * the start is refused, rather than silently playing like a wild creature.
 */
const FACTORIES: Record<string, () => BattleAi> = {
    wild: () => new RandomAi(),
};

export function createAi(id: string): BattleAi | undefined {
    return FACTORIES[id]?.();
}

export function knownAi(id: string): boolean {
    return id in FACTORIES;
}
