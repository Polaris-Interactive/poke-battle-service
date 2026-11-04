import ps from 'pokemon-showdown';

const { Battle, Side } = ps;

type ShowdownBattle = InstanceType<typeof Battle>;
type ShowdownSide = InstanceType<typeof Side>;
type ShowdownPokemon = ShowdownSide['pokemon'][number];

/**
 * What a format allows on top of moves and switches, from its {@code polaris} block in config/formats.json.
 */
export interface FormatFeatures {
    capture?: boolean;
    bag?: boolean;
    flee?: boolean;
}

/**
 * What one battle allows a side, from the start packet. Sent as a {@code rules} option of {@code >player}, which the
 * simulator keeps in its input log as given: a replay gets the same rules.
 */
export interface SideRules {
    capture: boolean;
    bag: boolean;
}

/** Where the patched setPlayer keeps each side's rules. */
const RULES = Symbol('polarisRules');
/** The side that fled, set when a flee succeeds: the battle then ends with no winner. */
const FLED = Symbol('polarisFled');
/** The side that caught the opponent: the battle then ends with that side's win. */
const CAPTURED = Symbol('polarisCaptured');
/** Failed flee attempts per side, each one makes the next likelier. */
const FLEE_ATTEMPTS = Symbol('polarisFleeAttempts');

type PolarisBattle = ShowdownBattle & {
    [RULES]?: Record<string, SideRules>;
    [FLED]?: string;
    [CAPTURED]?: string;
    [FLEE_ATTEMPTS]?: Record<string, number>;
    format: ShowdownBattle['format'] & { polaris?: FormatFeatures };
};

/**
 * One effect of a bag item, as the shard read it from the item's AstralItems blueprint.
 */
export type ItemEffect =
    | { kind: 'heal'; amount: number | null }
    | { kind: 'cure' }
    | { kind: 'revive'; fraction: number }
    | { kind: 'pp'; amount: number | null };

interface PolarisAction {
    choice: 'polarisball' | 'polarisrun' | 'polarisitem';
    pokemon: ShowdownPokemon;
    /** The choice as sent: what the input log records, so a replay makes it again. */
    raw: string;
    order: number;
    priority: number;
    ball?: string;
    shakes?: number;
    caught?: boolean;
    item?: string;
    target?: ShowdownPokemon;
    effects?: ItemEffect[];
}

/** Before every move (200) and switch (103), after the turn's start (4, 5): fleeing first, then the bag. */
const RUN_ORDER = 100;
const BAG_ORDER = 102;

const ID = /^[a-z0-9]+$/;

let installed = false;

/**
 * Adds PokeSMP's choices to the simulator, for a side whose active creature has to act (a move request, singles):
 * <ul>
 *     <li>{@code ball <ball> <shakes> <caught>}: a ball thrown at the opponent. <b>The shard rolls the capture</b> (it
 *     owns the formula and the ball rules) and sends the result; the choice is in the input log, so a replay throws the
 *     same ball with the same result. A catch ends the battle with this side's win.</li>
 *     <li>{@code run}: flee. Succeeds when faster, else with the mainline odds that grow with each attempt; a trapped
 *     creature cannot try (Ghost types, Run Away and Smoke Ball always can).</li>
 *     <li>{@code item <item> <position> <effects>}: a bag item used on the creature at {@code position} (1-based, as
 *     {@code switch N}, fainted ones included). Effects are joined by {@code +}: {@code heal[=N]}, {@code cure},
 *     {@code revive=F}, {@code pp[=N]}. An item that would do nothing is refused, so it is never spent for nothing.</li>
 * </ul>
 * Each takes the creature's turn and runs before moves. The format must allow it ({@link FormatFeatures}), and the
 * battle too for the ball and the bag ({@link SideRules}). This is a monkey-patch until the Showdown fork exists.
 */
export function installPolarisChoices(): void {
    if (installed)
        return;
    installed = true;

    const setPlayer = Battle.prototype.setPlayer;
    Battle.prototype.setPlayer = function (this: PolarisBattle, slot, options) {
        const rules = (options as { rules?: SideRules }).rules;
        if (rules !== undefined)
            (this[RULES] ??= {})[slot] = rules;
        return setPlayer.call(this, slot, options);
    };

    const choose = Side.prototype.choose;
    Side.prototype.choose = function (this: ShowdownSide, input: string) {
        const trimmed = input.trim();
        const space = trimmed.indexOf(' ');
        const type = space < 0 ? trimmed : trimmed.slice(0, space);
        if (type !== 'ball' && type !== 'run' && type !== 'item')
            return choose.call(this, input);
        // Not this side's turn, or an undo the simulator forbids: its own errors
        if (!this.requestState || this.choice.cantUndo)
            return choose.call(this, input);

        this.clearChoice();
        const data = space < 0 ? '' : trimmed.slice(space + 1).trim();
        const action = polarisAction(this, type, data);
        if (action === null)
            return false;
        this.choice.actions.push({ ...action, raw: trimmed } as never);
        return true;
    };

    // The simulator logs a side's choice as rebuilt from its actions; ours are logged as they were sent
    const getChoice = Side.prototype.getChoice;
    Side.prototype.getChoice = function (this: ShowdownSide) {
        const polaris = this.choice.actions.find(action => (action as unknown as PolarisAction).raw !== undefined);
        return polaris === undefined ? getChoice.call(this) : (polaris as unknown as PolarisAction).raw;
    };

    const runAction = Battle.prototype.runAction;
    Battle.prototype.runAction = function (this: PolarisBattle, action) {
        const polaris = action as unknown as PolarisAction;
        switch (polaris.choice) {
            case 'polarisball':
                throwBall(this, polaris);
                return undefined;
            case 'polarisrun':
                flee(this, polaris);
                return undefined;
            case 'polarisitem':
                useItem(this, polaris);
                return undefined;
            default:
                return runAction.call(this, action);
        }
    };
}

/**
 * The side that fled this battle, if one did.
 */
export function fledSide(battle: ShowdownBattle): string | undefined {
    return (battle as PolarisBattle)[FLED];
}

/**
 * The side that caught its opponent, if one did.
 */
export function capturingSide(battle: ShowdownBattle): string | undefined {
    return (battle as PolarisBattle)[CAPTURED];
}

// ---- Choices ----

function polarisAction(side: ShowdownSide, type: string, data: string): Omit<PolarisAction, 'raw'> | null {
    const battle = side.battle as PolarisBattle;
    const fail = (message: string): null => {
        side.emitChoiceError(`Can't ${type}: ${message}`);
        return null;
    };
    if (side.requestState !== 'move')
        return fail(`only when choosing a move`);
    if (side.active.length !== 1)
        return fail(`only in singles`);
    const pokemon = side.active[0];
    if (pokemon === undefined || pokemon === null || pokemon.fainted)
        return fail(`no active creature`);

    const features = battle.format.polaris ?? {};
    const rules = battle[RULES]?.[side.id] ?? { capture: false, bag: false };

    switch (type) {
        case 'ball': {
            if (!features.capture || !rules.capture)
                return fail(`no capture in this battle`);
            const [ball, shakes, caught, ...rest] = data.split(' ');
            if (ball === undefined || !ID.test(ball) || rest.length > 0 || !/^[0-3]$/.test(shakes ?? '')
                || !/^[01]$/.test(caught ?? ''))
                return fail(`expected "ball <ball> <shakes 0-3> <caught 0|1>"`);
            if (opponent(side) === null)
                return fail(`no creature to catch`);
            return { choice: 'polarisball', pokemon, order: BAG_ORDER, priority: 0, ball,
                shakes: Number(shakes), caught: caught === '1' };
        }
        case 'run': {
            if (!features.flee)
                return fail(`no fleeing from this battle`);
            if (data !== '')
                return fail(`unexpected "${data}"`);
            if ((pokemon.trapped || pokemon.maybeTrapped) && !alwaysEscapes(battle, pokemon))
                return fail(`${pokemon.name} is trapped`);
            return { choice: 'polarisrun', pokemon, order: RUN_ORDER, priority: 0 };
        }
        default: {
            if (!features.bag || !rules.bag)
                return fail(`no bag in this battle`);
            const [item, position, effectsText, ...rest] = data.split(' ');
            if (item === undefined || !ID.test(item) || rest.length > 0 || !/^[1-9]$/.test(position ?? ''))
                return fail(`expected "item <item> <position> <effects>"`);
            const target = side.pokemon[Number(position) - 1];
            if (target === undefined)
                return fail(`no creature at ${position}`);
            const effects = parseEffects(effectsText ?? '');
            if (effects === null)
                return fail(`invalid effects "${effectsText}"`);
            if (!effects.some(effect => applies(effect, effects, target)))
                return fail(`${item} would have no effect on ${target.name}`);
            return { choice: 'polarisitem', pokemon, order: BAG_ORDER, priority: 0, item, target, effects };
        }
    }
}

export function parseEffects(text: string): ItemEffect[] | null {
    if (text === '')
        return null;
    const effects: ItemEffect[] = [];
    for (const part of text.split('+')) {
        const [kind, value, ...rest] = part.split('=');
        if (rest.length > 0)
            return null;
        const number = value === undefined ? null : Number(value);
        if (number !== null && (!Number.isFinite(number) || number <= 0))
            return null;
        switch (kind) {
            case 'heal':
                effects.push({ kind: 'heal', amount: number === null ? null : Math.floor(number) });
                break;
            case 'pp':
                effects.push({ kind: 'pp', amount: number === null ? null : Math.floor(number) });
                break;
            case 'cure':
                if (number !== null)
                    return null;
                effects.push({ kind: 'cure' });
                break;
            case 'revive':
                if (number === null || number > 1)
                    return null;
                effects.push({ kind: 'revive', fraction: number });
                break;
            default:
                return null;
        }
    }
    return effects;
}

/**
 * Whether an effect would change the target, as out of battle: healing and curing need a creature still standing,
 * reviving a fainted one.
 */
function applies(effect: ItemEffect, all: ItemEffect[], target: ShowdownPokemon): boolean {
    const revives = all.some(other => other.kind === 'revive');
    switch (effect.kind) {
        case 'revive':
            return target.fainted;
        case 'heal':
            return !target.fainted && target.hp < target.maxhp;
        case 'cure':
            return !target.fainted && target.status !== '';
        case 'pp':
            return (!target.fainted || revives) && target.baseMoveSlots.some(slot => slot.pp < slot.maxpp);
    }
}

// ---- Actions ----

function throwBall(battle: PolarisBattle, action: PolarisAction): void {
    const target = opponent(action.pokemon.side);
    if (target === null)
        return;
    battle.add('polaris-ball', target, action.ball!, String(action.shakes!), action.caught ? 'caught' : 'free');
    if (!action.caught)
        return;
    battle[CAPTURED] = action.pokemon.side.id;
    battle.win(action.pokemon.side);
}

function flee(battle: PolarisBattle, action: PolarisAction): void {
    const pokemon = action.pokemon;
    if (!pokemon.isActive || pokemon.fainted)
        return;
    const side = pokemon.side;
    const foe = opponent(side);
    const attempts = battle[FLEE_ATTEMPTS] ??= {};
    attempts[side.id] = (attempts[side.id] ?? 0) + 1;

    let escaped = foe === null || alwaysEscapes(battle, pokemon);
    if (!escaped) {
        const speed = pokemon.getStat('spe');
        const foeSpeed = Math.max(1, foe!.getStat('spe'));
        // Mainline odds (gen 3+): out of 256, plus 30 for every attempt
        const odds = Math.floor(speed * 128 / foeSpeed) + 30 * attempts[side.id]!;
        escaped = speed >= foeSpeed || odds > 255 || battle.random(256) < odds;
    }

    battle.add('polaris-run', pokemon, escaped ? 'escaped' : 'failed');
    if (!escaped)
        return;
    battle[FLED] = side.id;
    battle.win();
}

function useItem(battle: PolarisBattle, action: PolarisAction): void {
    const target = action.target!;
    const effects = action.effects!;
    battle.add('polaris-item', target, action.item!);

    const revive = effects.find(effect => effect.kind === 'revive');
    if (revive !== undefined && target.fainted) {
        // As Revival Blessing does for a fainted creature on the bench
        target.fainted = false;
        target.faintQueued = false;
        target.subFainted = false;
        target.status = '';
        target.hp = 1;
        target.sethp(Math.max(1, Math.floor(target.maxhp * revive.fraction)));
        target.side.pokemonLeft++;
        battle.add('-heal', target, target.getHealth, '[from] polaris-revive');
    }
    if (target.fainted)
        return;

    for (const effect of effects) {
        switch (effect.kind) {
            case 'heal': {
                if (target.hp >= target.maxhp)
                    break;
                target.sethp(effect.amount === null ? target.maxhp : target.hp + effect.amount);
                battle.add('-heal', target, target.getHealth);
                break;
            }
            case 'cure': {
                if (target.status === '')
                    break;
                const status = target.status;
                target.clearStatus();
                // clearStatus only announces it for an active creature
                if (!target.isActive)
                    battle.add('-curestatus', target, status, '[msg]');
                break;
            }
            case 'pp': {
                for (const slot of target.baseMoveSlots)
                    slot.pp = effect.amount === null ? slot.maxpp : Math.min(slot.maxpp, slot.pp + effect.amount);
                break;
            }
            case 'revive':
                break;
        }
    }
}

// ---- Helpers ----

function opponent(side: ShowdownSide): ShowdownPokemon | null {
    const foe = side.foe.active[0];
    return foe === undefined || foe === null || foe.fainted ? null : foe;
}

/** Ghost types (gen 6+), Run Away and Smoke Ball flee from anything, trapped or not. */
function alwaysEscapes(battle: ShowdownBattle, pokemon: ShowdownPokemon): boolean {
    return (battle.gen >= 6 && pokemon.hasType('Ghost'))
        || pokemon.hasAbility('runaway')
        || pokemon.hasItem('smokeball');
}
