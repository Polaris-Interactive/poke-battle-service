import ps from 'pokemon-showdown';

import { RandomAi } from '../src/ai/random-ai.js';
import type { BattleSide, BattleStartPacket, ShardPacket } from '../src/codec/packets.js';
import type { BattleMeta, BattleStore, TakeOver } from '../src/store/battle-store.js';

const { Teams } = ps;

/**
 * Teams from the simulator's own random generator: the tests never name a creature. Without held items, which heal
 * or hurt on their own (berries, Leftovers) and would make HP checks flaky.
 */
export function randomTeam(): string {
    return Teams.pack(Teams.generate('gen9randombattle').map(set => ({ ...set, item: '' })));
}

export function startPacket(overrides: Partial<BattleStartPacket> = {}, sides?: BattleSide[]): BattleStartPacket {
    return {
        packet: 'BattleStartPacket',
        battleId: crypto.randomUUID(),
        shardId: 'shard-a',
        format: 'polariswild',
        seed: '',
        sides: sides ?? [
            { slot: 'p1', name: 'Player', playerId: crypto.randomUUID(), team: randomTeam(), ai: '', state: [] },
            { slot: 'p2', name: 'Wild', playerId: null, team: randomTeam(), ai: 'wild', state: [] },
        ],
        turnTimerSeconds: 0,
        allowBag: false,
        allowCapture: false,
        ...overrides,
    };
}

export class MemoryStore implements BattleStore {
    readonly claims = new Map<string, BattleMeta>();
    readonly logs = new Map<string, string[]>();
    readonly results = new Map<string, string>();
    readonly shards = new Map<string, string>();
    readonly ended = new Map<string, string>();
    /** Workers whose heartbeat is gone. */
    readonly dead = new Set<string>();

    async claim(battleId: string, meta: BattleMeta): Promise<boolean> {
        if (this.claims.has(battleId))
            return false;
        this.claims.set(battleId, meta);
        return true;
    }

    async unclaim(battleId: string, workerId: string): Promise<void> {
        if (this.claims.get(battleId)?.workerId === workerId)
            this.claims.delete(battleId);
    }

    async appendLog(battleId: string, inputs: string[]): Promise<void> {
        this.logs.set(battleId, [...(this.logs.get(battleId) ?? []), ...inputs]);
    }

    async touch(): Promise<void> {
    }

    async setShard(battleId: string, shardId: string): Promise<void> {
        this.shards.set(battleId, shardId);
    }

    async takeOver(battleId: string, workerId: string, instance: string): Promise<TakeOver> {
        const meta = this.claims.get(battleId);
        if (meta === undefined)
            return { status: 'missing' };
        if (this.ended.has(battleId))
            return { status: 'ended' };
        if (meta.instance !== instance && !this.dead.has(meta.workerId))
            return { status: 'alive' };
        this.claims.set(battleId, { ...meta, workerId, instance });
        return { status: 'taken', seed: meta.seed, start: meta.start, log: this.logs.get(battleId) ?? [] };
    }

    async finish(battleId: string, result: string, ended: string): Promise<void> {
        this.results.set(battleId, result);
        this.ended.set(battleId, ended);
    }

    async heartbeat(): Promise<void> {
    }

    async removeHeartbeat(): Promise<void> {
    }
}

export interface Sent {
    shardId: string;
    packet: ShardPacket;
}

/**
 * Collects what the session sends, and can play the human sides like a shard would.
 */
export class RecordingOutbox {
    readonly sent: Sent[] = [];
    autoplay: ((side: string, rqid: number, choice: string) => void) | null = null;
    private readonly ai = new RandomAi();

    send(shardId: string, packet: ShardPacket): void {
        this.sent.push({ shardId, packet });
        if (this.autoplay !== null && packet.packet === 'BattleRequestPacket') {
            const choice = this.ai.choose(JSON.parse(packet.request));
            const play = this.autoplay;
            if (choice !== null)
                setImmediate(() => play(packet.side, packet.rqid, choice));
        }
    }

    packets<N extends ShardPacket['packet']>(name: N): Extract<ShardPacket, { packet: N }>[] {
        return this.sent.map(sent => sent.packet).filter(packet => packet.packet === name) as Extract<ShardPacket, { packet: N }>[];
    }
}
