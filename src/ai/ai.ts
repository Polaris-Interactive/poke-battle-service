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
    }[];
    side?: {
        /** {@code reviving}: Revival Blessing, the forced "switch" names a fainted member to bring back. */
        pokemon: { active?: boolean; condition: string; reviving?: boolean }[];
    };
}

/**
 * Plays a side the shard did not give to a player. Returns the simulator choice, or null when the side has nothing to
 * choose (a wait request).
 */
export interface BattleAi {
    choose(request: ChoiceRequest): string | null;
}

export type Random = () => number;
