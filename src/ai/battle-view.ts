import type ps from 'pokemon-showdown';

type ShowdownBattle = InstanceType<typeof ps.Battle>;
type ShowdownPokemon = InstanceType<typeof ps.Side>['pokemon'][number];

/**
 * A creature as an AI may see it.
 *
 * @param types     its current types: a Terastallized creature has its Tera type only
 * @param hpPercent 0 to 100, rounded up like the HP Percentage Mod shows it (1 while it stands)
 * @param status    its major status ({@code par}, {@code slp}...), empty when none
 */
export interface CreatureView {
    readonly species: string;
    readonly types: readonly string[];
    readonly hpPercent: number;
    readonly status: string;
    readonly fainted: boolean;
}

/**
 * What an AI sees of the battle beyond its request: a frozen snapshot, so an AI can never change the battle. Only what
 * a player could see of the opponent (its active creatures as shown, Illusion included).
 *
 * @param team its own team, in the request's order (actives first)
 * @param foes the opposing active creatures, by position; null for an empty or fainted position
 */
export interface BattleView {
    readonly team: readonly CreatureView[];
    readonly foes: readonly (CreatureView | null)[];
}

/**
 * The view of {@code sideId} in {@code battle}. Reads plain fields only: no simulator call that could run an event or
 * draw from the battle's random (getTypes runs the Type event, whose ordering can shuffle), so building it never
 * changes what the battle does next.
 */
export function viewOf(battle: ShowdownBattle, sideId: string): BattleView | undefined {
    const side = battle.sides.find(candidate => candidate?.id === sideId);
    if (side === undefined)
        return undefined;
    const foes = battle.gameType === 'freeforall'
        ? battle.sides.filter(other => other !== side).map(other => other.active[0] ?? null)
        : side.foe?.active ?? [];
    return Object.freeze({
        team: Object.freeze(side.pokemon.map(pokemon => creature(pokemon, pokemon))),
        foes: Object.freeze(foes.map(foe => foe === null || foe === undefined || foe.fainted
            ? null
            : creature(foe, foe.illusion ?? foe))),
    });
}

/**
 * @param shown the creature the others see (an Illusion's disguise), whose species and types are shown
 */
function creature(pokemon: ShowdownPokemon, shown: ShowdownPokemon): CreatureView {
    const tera = pokemon.terastallized;
    const types = tera && tera !== 'Stellar'
        ? [tera]
        : [...(shown === pokemon ? pokemon.types : shown.baseSpecies.types),
            ...(pokemon.addedType ? [pokemon.addedType] : [])];
    const hpPercent = pokemon.fainted || pokemon.hp <= 0
        ? 0
        : Math.max(1, Math.ceil(pokemon.hp * 100 / pokemon.maxhp));
    return Object.freeze({
        species: shown.species.name,
        types: Object.freeze(types),
        hpPercent,
        status: pokemon.status,
        fainted: pokemon.fainted,
    });
}
