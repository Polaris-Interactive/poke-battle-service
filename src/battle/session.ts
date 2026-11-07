import ps from 'pokemon-showdown';
import battleModule from 'pokemon-showdown/dist/sim/battle.js';

import type { BattleAi, ChoiceRequest } from '../ai/ai.js';
import { RandomAi } from '../ai/random-ai.js';
import {
    encode, type BattleEndedPacket, type BattleSide, type BattleStartPacket, type BattleTeamState, type ShardPacket,
} from '../codec/packets.js';
import { log } from '../log.js';
import { capturingSide, fledSide, type SideRules } from './polaris-choices.js';
import { reportTeams } from './team-state.js';
import type { BattleStore } from '../store/battle-store.js';

const { BattleStream, Dex, PRNG, Teams } = ps;
const { extractChannelMessages } = battleModule;

type PRNGSeed = Parameters<typeof PRNG.get>[0];

const SIDE_IDS = ['p1', 'p2', 'p3', 'p4'] as const;
const MAX_CHOICE_LENGTH = 200;

/**
 * First line of an update that carries the player's whole view of the battle so far, sent from sequence 0 when the
 * battle moves to another shard or worker: the shard starts its view over from it.
 */
export const RESYNC_LINE = '|polaris-resync|';

/**
 * Where a session sends what the shard must see. Addressed by shard id: it changes when a player re-attaches from
 * another server.
 */
export interface Outbox {
    send(shardId: string, packet: ShardPacket): void;
}

export interface SessionDependencies {
    outbox: Outbox;
    store: BattleStore;
    createAi: (id: string) => BattleAi | undefined;
    idleTimeoutSeconds: number;
    /** Turn timers run out in a row before a player counts as gone and the battle is aborted; 0 never. */
    absentTurns: number;
    /** Called once, after the battle's last packet was sent. */
    onClosed: (session: BattleSession) => void;
}

/**
 * Why a start cannot run; the message goes back to the shard in the start reply.
 */
export class StartRejected extends Error {
}

interface HumanSide {
    side: BattleSide;
    /** The request the player has to answer, re-sent on re-attach. */
    pending: { rqid: number; request: string } | null;
    /** A choice for {@link pending} went to the simulator and was not refused. */
    answered: boolean;
    /** Plays for the player when the turn timer runs out. */
    timer: NodeJS.Timeout | null;
    /** Turn timers run out in a row: the player may be gone (their shard crashed, they left). */
    timeouts: number;
}

/** Plays for a player whose turn timer ran out (GDD: the AI chooses). */
const TIMEOUT_AI = new RandomAi();

/**
 * One battle on this worker: a Showdown BattleStream, read in a single loop so that everything the shard receives keeps
 * the simulator's order, with a gapless sequence number per battle.
 * <p>
 * Players' sides get their own view of every update (hidden information stays hidden) and their requests; AI sides
 * are answered here. Every simulator input is appended to the Redis log, enough to replay the battle elsewhere.
 */
export class BattleSession {

    readonly battleId: string;
    private shardId: string;
    private readonly stream: InstanceType<typeof BattleStream>;
    private readonly humans = new Map<string, HumanSide>();
    private readonly ais = new Map<string, BattleAi>();
    private readonly closed: Promise<void>;
    private seq = 0;
    /** The simulator leaves rqid to its server: the session numbers each player request itself. */
    private lastRqid = 0;
    private loggedInputs = 0;
    private abortReason: string | null = null;
    private endReason = '';
    /** Taken when the simulator ends or is stopped: once the stream is closed, the battle is destroyed. */
    private finalTeams: BattleTeamState[] = [];
    private idleTimer: NodeJS.Timeout | null = null;

    private readonly turnTimerSeconds: number;

    private constructor(start: BattleStartPacket, private readonly seed: string,
                        private readonly deps: SessionDependencies, replay: string[] | null) {
        this.battleId = start.battleId;
        this.turnTimerSeconds = start.turnTimerSeconds;
        this.shardId = start.shardId;
        this.stream = new BattleStream();

        for (const side of start.sides) {
            if (side.ai === '')
                this.humans.set(side.slot, { side, pending: null, answered: false, timer: null, timeouts: 0 });
            else
                this.ais.set(side.slot, deps.createAi(side.ai)!);
        }

        // A recovered battle replays its log before anything is read: what it printed then was already shown
        const replayed = replay === null ? null : this.replay(replay);

        this.closed = this.pump()
            .catch(error => {
                log.error('Battle stream failed', { battleId: this.battleId, error });
                this.abortReason ??= 'simulator error';
            })
            .then(() => this.close());

        if (replayed !== null) {
            this.resume(replayed);
            this.resetIdleTimer();
            return;
        }
        this.input(`>start ${JSON.stringify({ formatid: start.format, seed })}`);
        // Players get the battle's rules for the ball and the bag; options are logged as given, so replays keep them
        const rules: SideRules = { capture: start.allowCapture, bag: start.allowBag };
        for (const side of start.sides)
            this.input(`>player ${side.slot} ${JSON.stringify({
                name: side.name,
                team: side.team,
                ...(side.state.length > 0 ? { state: side.state } : {}),
                ...(side.ai === '' ? { rules } : {}),
            })}`);
        this.resetIdleTimer();
    }

    /**
     * Checks a start before it is claimed.
     *
     * @return the seed the battle will run with
     * @throws StartRejected when the start is invalid (sides, teams, AI, seed)
     */
    static prepare(start: BattleStartPacket, deps: Pick<SessionDependencies, 'createAi'>): string {
        BattleSession.checkSides(start.sides, deps);
        return BattleSession.checkSeed(start.seed);
    }

    /**
     * Runs a battle checked by {@link prepare}. Its format must be registered ({@code Formats}).
     */
    static run(start: BattleStartPacket, seed: string, deps: SessionDependencies): BattleSession {
        return new BattleSession(start, seed, deps, null);
    }

    /**
     * Takes over a battle whose worker died, from its start and input log: replays it silently, then sends its shard
     * the whole battle again from sequence 0 (a {@link RESYNC_LINE} update per player) and the requests still
     * unanswered. AI sides answer theirs. A battle that had ended closes at once, with its ended packet.
     */
    static recover(start: BattleStartPacket, seed: string, log: string[], deps: SessionDependencies): BattleSession {
        return new BattleSession(start, seed, deps, log);
    }

    /**
     * The seed the battle runs with: the start's, or a new one when it has none. Recorded in Redis for replays.
     */
    static checkSeed(seed: string): string {
        if (seed === '')
            return PRNG.generateSeed();
        try {
            PRNG.get(seed as PRNGSeed);
            return seed;
        } catch {
            throw new StartRejected(`invalid seed ${seed}`);
        }
    }

    private static checkSides(sides: BattleSide[], deps: Pick<SessionDependencies, 'createAi'>): void {
        if (sides.length < 2 || sides.length > SIDE_IDS.length)
            throw new StartRejected(`a battle needs 2 to 4 sides, got ${sides.length}`);
        sides.forEach((side, index) => {
            if (side.slot !== SIDE_IDS[index])
                throw new StartRejected(`side ${index + 1} must be ${SIDE_IDS[index]}, got ${side.slot}`);
            if (side.ai !== '' && deps.createAi(side.ai) === undefined)
                throw new StartRejected(`unknown AI ${side.ai} for ${side.slot}`);
            const team = Teams.unpack(side.team);
            if (team === null || team.length === 0)
                throw new StartRejected(`invalid team for ${side.slot}`);
            if (side.state.length > 0 && side.state.length !== team.length)
                throw new StartRejected(`${side.slot} has ${team.length} members but ${side.state.length} states`);
            if (side.state.length > 0 && side.state[0]!.hp <= 0)
                throw new StartRejected(`${side.slot} leads with a fainted member`);
            for (const set of team)
                if (!Dex.species.get(set.species).exists)
                    throw new StartRejected(`unknown species ${set.species} for ${side.slot}`);
        });
    }

    get seedUsed(): string {
        return this.seed;
    }

    /** Resolves once the battle's last packet was sent. */
    get done(): Promise<void> {
        return this.closed;
    }

    // ---- Shard commands ----

    choose(side: string, rqid: number, choice: string): void {
        const human = this.humans.get(side);
        if (human === undefined) {
            log.warn('Choice for a side no player controls', { battleId: this.battleId, side });
            return;
        }
        if (human.pending === null || human.pending.rqid !== rqid) {
            this.emit({ packet: 'BattleChoiceErrorPacket', battleId: this.battleId, seq: 0, side, rqid,
                message: '[Invalid choice] stale request' });
            return;
        }
        // One line, no simulator command of its own: a choice can never become a >forcewin
        if (choice.length === 0 || choice.length > MAX_CHOICE_LENGTH || /[\r\n>]/.test(choice)) {
            this.emit({ packet: 'BattleChoiceErrorPacket', battleId: this.battleId, seq: 0, side, rqid,
                message: '[Invalid choice] malformed' });
            return;
        }

        this.resetIdleTimer();
        human.answered = true;
        human.timeouts = 0;
        this.input(`>${side} ${choice}`);
        void this.deps.store.touch(this.battleId, this.turn()).catch(error =>
            log.warn('Could not refresh the battle keys', { battleId: this.battleId, error }));
    }

    /**
     * @param result p1..p4 to make that side win, tie, or aborted to stop with no winner
     */
    end(result: string, reason: string): void {
        this.endReason = reason;
        if (result === 'tie')
            this.input('>forcetie');
        else if ((SIDE_IDS as readonly string[]).includes(result) && this.hasSide(result))
            this.input(`>forcewin ${result}`);
        else
            this.abort(reason === '' ? 'ended by the shard' : reason);
    }

    /**
     * The battle is now shown by {@code shardId}: it gets the whole battle again from sequence 0, then the pending
     * requests.
     */
    attach(shardId: string): void {
        this.shardId = shardId;
        void this.deps.store.setShard(this.battleId, shardId).catch(error =>
            log.warn('Could not record the new shard', { battleId: this.battleId, error }));
        for (const human of this.humans.values())
            human.timeouts = 0;
        this.resync();
        for (const [side, human] of this.humans)
            if (human.pending !== null)
                this.emit({ packet: 'BattleRequestPacket', battleId: this.battleId, seq: 0, side,
                    rqid: human.pending.rqid, request: human.pending.request });
    }

    /** Stops the battle with no winner and no rewards. */
    abort(reason: string): void {
        this.clearTurnTimers();
        if (this.abortReason !== null)
            return;
        this.abortReason = reason;
        this.snapshotTeams();
        void this.stream.writeEnd();
    }

    // ---- Recovery ----

    /**
     * Writes a logged battle into the fresh stream and takes back what it printed, before the pump reads any of it.
     * The simulator runs inputs synchronously, so the output is all buffered by then.
     *
     * @return the last request each side got
     */
    private replay(inputs: string[]): Map<string, ChoiceRequest> {
        void this.stream.write(inputs.join('\n'));
        this.loggedInputs = this.stream.battle?.inputLog.length ?? 0;
        const requests = new Map<string, ChoiceRequest>();
        for (const chunk of this.stream.buf.splice(0)) {
            const newline = chunk.indexOf('\n');
            const type = newline < 0 ? chunk : chunk.slice(0, newline);
            const data = newline < 0 ? '' : chunk.slice(newline + 1);
            if (type === 'end') {
                this.snapshotTeams();
                continue;
            }
            if (type !== 'sideupdate')
                continue;
            const split = data.indexOf('\n');
            const message = data.slice(split + 1);
            if (message.startsWith('|request|'))
                requests.set(data.slice(0, split), JSON.parse(message.slice('|request|'.length)) as ChoiceRequest);
        }
        return requests;
    }

    /**
     * After a replay: the shard gets the battle again, then each side's unanswered request is asked again (players)
     * or answered (AI).
     */
    private resume(requests: Map<string, ChoiceRequest>): void {
        this.resync();
        const battle = this.stream.battle;
        if (battle === null || battle.ended)
            return;
        for (const [side, request] of requests) {
            const simulated = battle.sides[SIDE_IDS.indexOf(side as typeof SIDE_IDS[number])];
            if (simulated == null || request.wait || simulated.isChoiceDone())
                continue;
            const human = this.humans.get(side);
            if (human !== undefined)
                this.offer(side, human, request);
            else
                this.playAi(side, request);
        }
    }

    /**
     * Sends each player their whole view of the battle so far, from sequence 0.
     */
    private resync(): void {
        this.seq = 0;
        const battle = this.stream.battle;
        if (battle === null)
            return;
        const channels = extractChannelMessages(battle.log.join('\n'), [1, 2, 3, 4]);
        for (const side of this.humans.keys()) {
            const lines = channels[(SIDE_IDS.indexOf(side as typeof SIDE_IDS[number]) + 1) as 1 | 2 | 3 | 4];
            this.emit({ packet: 'BattleUpdatePacket', battleId: this.battleId, seq: 0, side,
                lines: [RESYNC_LINE, ...lines] });
        }
    }

    // ---- Simulator ----

    private input(line: string): void {
        // Requests still buffered after an abort must not write into the ended stream
        if (this.abortReason !== null)
            return;
        void this.stream.write(line);
        this.syncInputLog();
    }

    private syncInputLog(): void {
        const inputs = this.stream.battle?.inputLog ?? [];
        if (inputs.length <= this.loggedInputs)
            return;
        const added = inputs.slice(this.loggedInputs);
        this.loggedInputs = inputs.length;
        void this.deps.store.appendLog(this.battleId, added).catch(error =>
            log.warn('Could not append to the battle log', { battleId: this.battleId, error }));
    }

    private async pump(): Promise<void> {
        for await (const chunk of this.stream) {
            const newline = chunk.indexOf('\n');
            const type = newline < 0 ? chunk : chunk.slice(0, newline);
            const data = newline < 0 ? '' : chunk.slice(newline + 1);
            if (type === 'update')
                this.onUpdate(data);
            else if (type === 'sideupdate')
                this.onSideUpdate(data);
            else if (type === 'end')
                // The battle summary; the stream ends right after it
                this.snapshotTeams();
        }
    }

    private onUpdate(data: string): void {
        if (this.humans.size === 0)
            return;
        const channels = extractChannelMessages(data, [1, 2, 3, 4]);
        for (const side of this.humans.keys()) {
            const lines = channels[(SIDE_IDS.indexOf(side as typeof SIDE_IDS[number]) + 1) as 1 | 2 | 3 | 4];
            if (lines.length > 0)
                this.emit({ packet: 'BattleUpdatePacket', battleId: this.battleId, seq: 0, side, lines });
        }
    }

    private onSideUpdate(data: string): void {
        const newline = data.indexOf('\n');
        const side = data.slice(0, newline);
        const message = data.slice(newline + 1);

        if (message.startsWith('|request|')) {
            const json = message.slice('|request|'.length);
            const human = this.humans.get(side);
            if (human !== undefined) {
                this.offer(side, human, JSON.parse(json) as ChoiceRequest);
            } else {
                this.playAi(side, JSON.parse(json) as ChoiceRequest);
            }
            return;
        }

        if (message.startsWith('|error|')) {
            const human = this.humans.get(side);
            if (human !== undefined) {
                human.answered = false;
                this.emit({ packet: 'BattleChoiceErrorPacket', battleId: this.battleId, seq: 0, side,
                    rqid: human.pending?.rqid ?? 0, message: message.slice('|error|'.length) });
            } else {
                log.warn('AI choice refused, playing the default', { battleId: this.battleId, side, message });
                this.input(`>${side} default`);
            }
        }
    }

    /**
     * Numbers a request for a player and sends it.
     */
    private offer(side: string, human: HumanSide, request: ChoiceRequest): void {
        request.rqid = ++this.lastRqid;
        const numbered = JSON.stringify(request);
        human.pending = { rqid: request.rqid, request: numbered };
        human.answered = false;
        this.emit({ packet: 'BattleRequestPacket', battleId: this.battleId, seq: 0, side,
            rqid: request.rqid, request: numbered });
        this.startTurnTimer(side, human, request);
    }

    /**
     * Starts the side's turn timer for a request it has to answer: when it runs out, the AI chooses for the player and
     * the shard is told with a {@code |polaris-timer|<side>} line. Off when the start's timer is 0.
     */
    private startTurnTimer(side: string, human: HumanSide, request: ChoiceRequest): void {
        if (human.timer !== null)
            clearTimeout(human.timer);
        human.timer = null;
        const seconds = this.turnTimerSeconds;
        if (seconds <= 0 || request.wait)
            return;
        const rqid = request.rqid!;
        human.timer = setTimeout(() => {
            human.timer = null;
            if (this.abortReason !== null || human.pending?.rqid !== rqid || human.answered)
                return;
            human.timeouts++;
            if (this.deps.absentTurns > 0 && human.timeouts >= this.deps.absentTurns) {
                log.info('Player absent for too many turns, aborting', { battleId: this.battleId, side,
                    timeouts: human.timeouts });
                this.abort('absent');
                return;
            }
            const choice = TIMEOUT_AI.choose(request);
            if (choice === null)
                return;
            log.info('Turn timer ran out, choosing for the player', { battleId: this.battleId, side, rqid });
            this.emit({ packet: 'BattleUpdatePacket', battleId: this.battleId, seq: 0, side,
                lines: [`|polaris-timer|${side}`] });
            human.answered = true;
            this.input(`>${side} ${choice}`);
        }, seconds * 1000);
        human.timer.unref();
    }

    private clearTurnTimers(): void {
        for (const human of this.humans.values()) {
            if (human.timer !== null)
                clearTimeout(human.timer);
            human.timer = null;
        }
    }

    private playAi(side: string, request: ChoiceRequest): void {
        const choice = this.ais.get(side)?.choose(request);
        if (choice != null)
            this.input(`>${side} ${choice}`);
    }

    // ---- Output ----

    private emit(packet: ShardPacket): void {
        packet.seq = this.seq++;
        this.deps.outbox.send(this.shardId, packet);
    }

    private async close(): Promise<void> {
        if (this.idleTimer !== null)
            clearTimeout(this.idleTimer);
        this.clearTurnTimers();
        this.syncInputLog();

        const battle = this.stream.battle;
        let result: string;
        let reason = this.endReason;
        if (this.abortReason !== null || battle === null || !battle.ended) {
            result = 'aborted';
            reason = this.abortReason ?? 'simulator ended';
        } else if (fledSide(battle) !== undefined) {
            result = 'fled';
            reason = `${fledSide(battle)} fled`;
        } else {
            result = this.winningSide();
            if (capturingSide(battle) !== undefined)
                reason = 'captured';
        }

        const ended: BattleEndedPacket = { packet: 'BattleEndedPacket', battleId: this.battleId, seq: 0, result, reason,
            turns: this.turn(), teams: this.finalTeams };
        this.emit(ended);
        // Kept for a shard that was not there to receive it: it settles the battle when the player comes back
        await this.deps.store.finish(this.battleId, result, encode(ended).toString('base64')).catch(error =>
            log.warn('Could not mark the battle ended', { battleId: this.battleId, error }));
        this.deps.onClosed(this);
    }

    private winningSide(): string {
        const battle = this.stream.battle!;
        if (!battle.winner)
            return 'tie';
        const named = battle.sides.filter(side => side.name === battle.winner);
        if (named.length === 1)
            return named[0]!.id;
        // Two sides with the same name: the one with creatures left
        return battle.sides.find(side => side.pokemonLeft > 0)?.id ?? 'tie';
    }

    private snapshotTeams(): void {
        const battle = this.stream.battle;
        if (battle?.started && battle.sides.every(side => side !== null))
            this.finalTeams = reportTeams(battle);
    }

    private turn(): number {
        return this.stream.battle?.turn ?? 0;
    }

    private hasSide(side: string): boolean {
        return this.humans.has(side) || this.ais.has(side);
    }

    private resetIdleTimer(): void {
        if (this.idleTimer !== null)
            clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => this.abort('idle'), this.deps.idleTimeoutSeconds * 1000);
        this.idleTimer.unref();
    }
}
