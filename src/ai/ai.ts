import type { BattleView } from './battle-view.js';

/**
 * The simulator's choice request, as much of it as the AIs read.
 */
export interface ChoiceRequest {
    rqid?: number;
    wait?: boolean;
    teamPreview?: boolean;
    forceSwitch?: boolean[];
    active?: {
        moves: { id: string; pp?: number; disabled?: boolean | string; target?: string }[];
        trapped?: boolean;
        maybeTrapped?: boolean;
    }[];
    side?: {
        /** {@code reviving}: Revival Blessing, the forced "switch" names a fainted member to bring back. */
        pokemon: {
            active?: boolean;
            condition: string;
            reviving?: boolean;
            /** Move ids; Hidden Power, Return and Frustration carry their type or power after the id. */
            moves?: string[];
            stats?: { atk: number; def: number; spa: number; spd: number; spe: number };
        }[];
    };
}

/**
 * Plays a side the shard did not give to a player. Returns the simulator choice, or null when the side has nothing to
 * choose (a wait request).
 * <p>
 * A battle is replayed from its input log after a worker recovery, and the AI answers the request still pending: an
 * AI other than the random one must choose from the request and the view alone (never the simulator's random, never
 * Math.random), so that the same battle state always gives the same choice.
 *
 * @param view what the AI sees of the battle beyond its request; absent outside a battle (tests)
 */
export interface BattleAi {
    choose(request: ChoiceRequest, view?: BattleView): string | null;
}

export type Random = () => number;
