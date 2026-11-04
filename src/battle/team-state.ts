import ps from 'pokemon-showdown';

import type { BattleMemberState, BattleTeamState } from '../codec/packets.js';

const { Battle } = ps;

type ShowdownBattle = InstanceType<typeof Battle>;
type ShowdownPokemon = ShowdownBattle['sides'][number]['pokemon'][number];

/** Where the patched setPlayer keeps each side's start state until the battle begins. */
const STATES = Symbol('polarisTeamStates');

type WithStates = ShowdownBattle & { [STATES]?: (BattleMemberState[] | undefined)[] };

let installed = false;

/**
 * Lets a {@code >player} input carry a {@code state} option, the condition of each team member (creatures are not
 * healed by starting a battle). The simulator packs teams into its input log, losing any extra set field, but keeps
 * the options as given: the state is therefore an option, recorded with the input, and a replay restores it.
 * <p>
 * {@link applyTeamStates} is the formats' {@code onBegin}: it runs when the last player joins, before the leads switch
 * in, so no line ever shows a creature at the wrong HP.
 */
export function installTeamStates(): void {
    if (installed)
        return;
    installed = true;

    const setPlayer = Battle.prototype.setPlayer;
    Battle.prototype.setPlayer = function (this: WithStates, slot, options) {
        const state = (options as { state?: BattleMemberState[] }).state;
        if (state !== undefined) {
            const states = this[STATES] ??= [];
            states[parseInt(slot.slice(1)) - 1] = state;
        }
        return setPlayer.call(this, slot, options);
    };
}

export function applyTeamStates(this: ShowdownBattle): void {
    const states = (this as WithStates)[STATES];
    if (states === undefined)
        return;
    this.sides.forEach((side, index) => {
        const state = states[index];
        if (state === undefined)
            return;
        side.pokemon.forEach((pokemon, member) => {
            const condition = state[member];
            if (condition !== undefined)
                applyState(this, pokemon, condition);
        });
    });
}

function applyState(battle: ShowdownBattle, pokemon: ShowdownPokemon, state: BattleMemberState): void {
    // A fainted member is never sent (the shard leaves it out), so at least 1 HP
    pokemon.hp = Math.min(Math.max(1, state.hp), pokemon.maxhp);

    // baseMoveSlots and moveSlots share their slot objects until a move is copied or transformed
    pokemon.baseMoveSlots.forEach((slot, index) => {
        const maxPp = state.maxPp[index];
        if (maxPp !== undefined && maxPp > 0)
            slot.maxpp = maxPp;
        const pp = state.pp[index];
        if (pp !== undefined)
            slot.pp = Math.min(Math.max(0, pp), slot.maxpp);
    });

    if (state.status !== '' && battle.dex.conditions.get(state.status).effectType === 'Status') {
        // Set directly: setStatus would announce it for a creature not on the field yet
        pokemon.status = state.status as ShowdownPokemon['status'];
        pokemon.statusState = battle.initEffectState({ id: state.status, target: pokemon });
        if (state.status === 'slp') {
            // The simulator's own sleep length, from the battle's seeded random: replays sleep the same
            pokemon.statusState.startTime = battle.random(2, 5);
            pokemon.statusState.time = pokemon.statusState.startTime;
        }
    }
}

/**
 * Every side's team as it leaves the battle, in the order of the start team: the simulator reorders members as
 * they switch, but each keeps the set it was built from.
 */
export function reportTeams(battle: ShowdownBattle): BattleTeamState[] {
    return battle.sides.map(side => ({
        slot: side.id,
        members: side.team.map(set => {
            const pokemon = side.pokemon.find(candidate => candidate.set === set);
            if (pokemon === undefined)
                return { hp: 0, status: '', pp: [], maxPp: [] };
            return {
                hp: pokemon.fainted ? 0 : pokemon.hp,
                status: pokemon.fainted ? '' : pokemon.status,
                pp: pokemon.baseMoveSlots.map(slot => slot.pp),
                maxPp: pokemon.baseMoveSlots.map(slot => slot.maxpp),
            };
        }),
    }));
}
