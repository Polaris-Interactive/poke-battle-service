import { createAi } from '../ai/registry.js';
import type { BattleStartPacket, Packet } from '../codec/packets.js';
import { log } from '../log.js';
import type { StartOutcome } from '../messaging/messaging.js';
import type { BattleStore } from '../store/battle-store.js';
import type { Formats } from './formats.js';
import { BattleSession, StartRejected, type Outbox } from './session.js';

export interface ManagerOptions {
    workerId: string;
    capacity: number;
    idleTimeoutSeconds: number;
    formats: Formats;
    store: BattleStore;
    outbox: Outbox;
    /** Called when the worker fills up or gets room again, to stop or resume taking starts. */
    onCapacityChange: (full: boolean) => void;
}

/**
 * The battles running on this worker. A start is checked, then claimed in Redis (so a redelivered start never runs
 * twice), then run; only then is it acknowledged and answered.
 */
export class BattleManager {

    private readonly sessions = new Map<string, BattleSession>();
    private wasFull = false;

    constructor(private readonly options: ManagerOptions) {
    }

    get size(): number {
        return this.sessions.size;
    }

    get full(): boolean {
        return this.sessions.size >= this.options.capacity;
    }

    async start(packet: BattleStartPacket): Promise<StartOutcome> {
        const { workerId, formats, store } = this.options;
        const refuse = (reason: string): StartOutcome => {
            log.info('Start refused', { battleId: packet.battleId, reason });
            return {
                kind: 'reply',
                reply: { packet: 'BattleStartReplyPacket', battleId: packet.battleId, accepted: false, workerId, reason },
            };
        };

        if (this.sessions.has(packet.battleId))
            return { kind: 'drop' };
        if (this.full)
            return { kind: 'requeue' };

        if (!formats.has(packet.format))
            return refuse(`unknown format ${packet.format}`);

        let seed: string;
        try {
            seed = BattleSession.prepare(packet, { createAi });
        } catch (error) {
            if (error instanceof StartRejected)
                return refuse(error.message);
            throw error;
        }

        const claimed = await store.claim(packet.battleId, { workerId, shardId: packet.shardId, format: packet.format, seed });
        if (!claimed) {
            log.info('Start already claimed by another worker, dropped', { battleId: packet.battleId });
            return { kind: 'drop' };
        }

        let session: BattleSession;
        try {
            session = BattleSession.run(packet, seed, {
                outbox: this.options.outbox,
                store,
                createAi,
                idleTimeoutSeconds: this.options.idleTimeoutSeconds,
                onClosed: closed => this.closed(closed),
            });
        } catch (error) {
            log.error('Battle could not start', { battleId: packet.battleId, error });
            await store.unclaim(packet.battleId, workerId);
            return refuse('simulator error');
        }

        this.sessions.set(packet.battleId, session);
        this.capacityChanged();
        log.info('Battle started', { battleId: packet.battleId, format: packet.format, shardId: packet.shardId,
            battles: this.sessions.size });
        return {
            kind: 'reply',
            reply: { packet: 'BattleStartReplyPacket', battleId: packet.battleId, accepted: true, workerId, reason: '' },
        };
    }

    command(packet: Packet): void {
        const session = 'battleId' in packet ? this.sessions.get(packet.battleId) : undefined;
        if (session === undefined) {
            log.debug('Command for a battle not running here', { packet: packet.packet });
            return;
        }
        switch (packet.packet) {
            case 'BattleChoicePacket':
                session.choose(packet.side, packet.rqid, packet.choice);
                break;
            case 'BattleEndPacket':
                session.end(packet.result, packet.reason);
                break;
            case 'BattleAttachPacket':
                session.attach(packet.shardId);
                break;
            default:
                log.warn('Unexpected packet on the worker exchange', { packet: packet.packet });
        }
    }

    /**
     * Waits for the running battles to end, then aborts those still running after {@code timeoutMs}.
     */
    async drain(timeoutMs: number): Promise<void> {
        const all = Promise.all([...this.sessions.values()].map(session => session.done));
        const timeout = new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), timeoutMs).unref());
        if (await Promise.race([all, timeout]) === 'timeout') {
            for (const session of this.sessions.values())
                session.abort('worker shutdown');
            await all;
        }
    }

    private closed(session: BattleSession): void {
        this.sessions.delete(session.battleId);
        this.capacityChanged();
        log.info('Battle closed', { battleId: session.battleId, battles: this.sessions.size });
    }

    private capacityChanged(): void {
        const full = this.full;
        if (full !== this.wasFull) {
            this.wasFull = full;
            this.options.onCapacityChange(full);
        }
    }
}
