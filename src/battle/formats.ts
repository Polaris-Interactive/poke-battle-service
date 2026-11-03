import { readFileSync } from 'node:fs';

import ps from 'pokemon-showdown';
import dexFormats from 'pokemon-showdown/dist/sim/dex-formats.js';

const { Dex, toID } = ps;
const { Format } = dexFormats;

/**
 * A PokeLegends format, registered in the simulator under its id. Shards send that id as is.
 *
 * @param name     display name; its simulator id (lowercase alphanumerics) must be the format's id
 * @param ruleset  simulator rules (clauses, mods, team size, level caps...)
 */
export interface FormatDefinition {
    name: string;
    description?: string;
    mod: string;
    gameType: 'singles' | 'doubles' | 'triples' | 'multi' | 'freeforall';
    ruleset: string[];
}

/**
 * The formats this worker runs, from config/formats.json, added to the simulator's format list at boot. Game rules
 * that need simulator changes (capture, bag, flee, raid bosses) come with the Showdown fork's mod.
 */
export class Formats {

    private constructor(private readonly ids: ReadonlySet<string>) {
    }

    static load(file: string): Formats {
        return Formats.register(JSON.parse(readFileSync(file, 'utf8')) as Record<string, FormatDefinition>);
    }

    /**
     * @throws Error when a definition is inconsistent or uses an unknown rule
     */
    static register(definitions: Record<string, FormatDefinition>): Formats {
        Dex.formats.load();
        const cache = Dex.formats.rulesetCache;
        for (const [id, definition] of Object.entries(definitions)) {
            if (toID(definition.name) !== id)
                throw new Error(`Format ${id}: its name "${definition.name}" has the id ${toID(definition.name)}`);
            if (!Dex.dexes[definition.mod])
                throw new Error(`Format ${id}: unknown mod ${definition.mod}`);

            const format = new Format({
                name: definition.name,
                desc: definition.description,
                mod: definition.mod,
                gameType: definition.gameType,
                ruleset: definition.ruleset,
                baseRuleset: definition.ruleset.slice(),
                effectType: 'Format',
                section: 'PokeLegends',
                searchShow: false,
                challengeShow: false,
                tournamentShow: false,
            });
            cache.set(id, format);
            // Resolves every rule now: a typo fails the boot, not the first battle
            Dex.formats.getRuleTable(format);
        }
        return new Formats(new Set(Object.keys(definitions)));
    }

    has(id: string): boolean {
        return this.ids.has(id);
    }
}
