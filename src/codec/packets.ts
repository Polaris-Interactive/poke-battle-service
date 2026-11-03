import { BinaryReader, BinaryWriter } from './binary.js';

/**
 * The battle protocol, mirrored from PokeBattle's common module (PokeBattlePacketRegistry and the
 * com.astralrealms.poke.battle.network.packet classes). A packet is its registry id as a varint, then its fields in
 * declaration order. Never renumber an id; change fields only together with the Java side and the contract vectors.
 */

export interface BattleSide {
    /** Simulator side id: p1, p2 (p3, p4 in multi battles). */
    slot: string;
    name: string;
    /** The player on this side, null for a creature or an NPC. */
    playerId: string | null;
    /** Packed team. */
    team: string;
    /** AI id playing this side, empty when a player chooses. */
    ai: string;
}

export interface BattleStartPacket {
    packet: 'BattleStartPacket';
    battleId: string;
    shardId: string;
    format: string;
    seed: string;
    sides: BattleSide[];
    turnTimerSeconds: number;
    allowBag: boolean;
    allowCapture: boolean;
}

export interface BattleStartReplyPacket {
    packet: 'BattleStartReplyPacket';
    battleId: string;
    accepted: boolean;
    workerId: string;
    reason: string;
}

export interface BattleChoicePacket {
    packet: 'BattleChoicePacket';
    battleId: string;
    side: string;
    rqid: number;
    choice: string;
}

export interface BattleEndPacket {
    packet: 'BattleEndPacket';
    battleId: string;
    /** p1, p2... for that side's win, tie, or aborted. */
    result: string;
    reason: string;
}

export interface BattleAttachPacket {
    packet: 'BattleAttachPacket';
    battleId: string;
    shardId: string;
}

export interface BattleUpdatePacket {
    packet: 'BattleUpdatePacket';
    battleId: string;
    seq: number;
    /** p1, p2... for that player's view, empty for the spectator view. */
    side: string;
    lines: string[];
}

export interface BattleRequestPacket {
    packet: 'BattleRequestPacket';
    battleId: string;
    seq: number;
    side: string;
    rqid: number;
    request: string;
}

export interface BattleChoiceErrorPacket {
    packet: 'BattleChoiceErrorPacket';
    battleId: string;
    seq: number;
    side: string;
    rqid: number;
    message: string;
}

export interface BattleEndedPacket {
    packet: 'BattleEndedPacket';
    battleId: string;
    seq: number;
    result: string;
    reason: string;
    turns: number;
}

export type Packet =
    | BattleStartPacket
    | BattleStartReplyPacket
    | BattleChoicePacket
    | BattleEndPacket
    | BattleAttachPacket
    | BattleUpdatePacket
    | BattleRequestPacket
    | BattleChoiceErrorPacket
    | BattleEndedPacket;

export type PacketName = Packet['packet'];

/** Packets a worker sends to a shard, which all carry the battle's sequence number. */
export type ShardPacket = BattleUpdatePacket | BattleRequestPacket | BattleChoiceErrorPacket | BattleEndedPacket;

type Codec<P extends Packet> = {
    id: number;
    write(writer: BinaryWriter, packet: P): void;
    read(reader: BinaryReader): Omit<P, 'packet'>;
};

const writeSide = (writer: BinaryWriter, side: BattleSide): void => {
    writer.writeString(side.slot)
        .writeString(side.name)
        .writeOptional(side.playerId, (w, id) => w.writeUuid(id))
        .writeString(side.team)
        .writeString(side.ai);
};

const readSide = (reader: BinaryReader): BattleSide => ({
    slot: reader.readString(),
    name: reader.readString(),
    playerId: reader.readOptional(r => r.readUuid()),
    team: reader.readString(),
    ai: reader.readString(),
});

const CODECS: { [N in PacketName]: Codec<Extract<Packet, { packet: N }>> } = {
    BattleStartPacket: {
        id: 0x00,
        write: (w, p) => {
            w.writeUuid(p.battleId).writeString(p.shardId).writeString(p.format).writeString(p.seed);
            w.writeList(p.sides, writeSide);
            w.writeVarInt(p.turnTimerSeconds).writeBoolean(p.allowBag).writeBoolean(p.allowCapture);
        },
        read: r => ({
            battleId: r.readUuid(),
            shardId: r.readString(),
            format: r.readString(),
            seed: r.readString(),
            sides: r.readList(readSide),
            turnTimerSeconds: r.readVarInt(),
            allowBag: r.readBoolean(),
            allowCapture: r.readBoolean(),
        }),
    },
    BattleStartReplyPacket: {
        id: 0x01,
        write: (w, p) => w.writeUuid(p.battleId).writeBoolean(p.accepted).writeString(p.workerId).writeString(p.reason),
        read: r => ({ battleId: r.readUuid(), accepted: r.readBoolean(), workerId: r.readString(), reason: r.readString() }),
    },
    BattleChoicePacket: {
        id: 0x02,
        write: (w, p) => w.writeUuid(p.battleId).writeString(p.side).writeVarInt(p.rqid).writeString(p.choice),
        read: r => ({ battleId: r.readUuid(), side: r.readString(), rqid: r.readVarInt(), choice: r.readString() }),
    },
    BattleEndPacket: {
        id: 0x03,
        write: (w, p) => w.writeUuid(p.battleId).writeString(p.result).writeString(p.reason),
        read: r => ({ battleId: r.readUuid(), result: r.readString(), reason: r.readString() }),
    },
    BattleAttachPacket: {
        id: 0x04,
        write: (w, p) => w.writeUuid(p.battleId).writeString(p.shardId),
        read: r => ({ battleId: r.readUuid(), shardId: r.readString() }),
    },
    BattleUpdatePacket: {
        id: 0x05,
        write: (w, p) => w.writeUuid(p.battleId).writeVarLong(p.seq).writeString(p.side)
            .writeList(p.lines, (lw, line) => lw.writeString(line)),
        read: r => ({ battleId: r.readUuid(), seq: r.readVarLong(), side: r.readString(), lines: r.readList(lr => lr.readString()) }),
    },
    BattleRequestPacket: {
        id: 0x06,
        write: (w, p) => w.writeUuid(p.battleId).writeVarLong(p.seq).writeString(p.side).writeVarInt(p.rqid)
            .writeString(p.request),
        read: r => ({
            battleId: r.readUuid(), seq: r.readVarLong(), side: r.readString(), rqid: r.readVarInt(), request: r.readString(),
        }),
    },
    BattleChoiceErrorPacket: {
        id: 0x07,
        write: (w, p) => w.writeUuid(p.battleId).writeVarLong(p.seq).writeString(p.side).writeVarInt(p.rqid)
            .writeString(p.message),
        read: r => ({
            battleId: r.readUuid(), seq: r.readVarLong(), side: r.readString(), rqid: r.readVarInt(), message: r.readString(),
        }),
    },
    BattleEndedPacket: {
        id: 0x08,
        write: (w, p) => w.writeUuid(p.battleId).writeVarLong(p.seq).writeString(p.result).writeString(p.reason)
            .writeVarInt(p.turns),
        read: r => ({
            battleId: r.readUuid(), seq: r.readVarLong(), result: r.readString(), reason: r.readString(), turns: r.readVarInt(),
        }),
    },
};

const BY_ID = new Map<number, PacketName>(
    (Object.keys(CODECS) as PacketName[]).map(name => [CODECS[name].id, name]),
);

export function packetId(name: PacketName): number {
    return CODECS[name].id;
}

export function encode(packet: Packet): Buffer {
    const writer = new BinaryWriter();
    const codec = CODECS[packet.packet] as Codec<Packet>;
    writer.writeVarInt(codec.id);
    codec.write(writer, packet);
    return writer.toBuffer();
}

/**
 * @throws Error on an unknown id, truncated data, or unread trailing bytes (a contract mismatch)
 */
export function decode(data: Buffer): Packet {
    const reader = new BinaryReader(data);
    const id = reader.readVarInt();
    const name = BY_ID.get(id);
    if (name === undefined)
        throw new Error(`Unknown packet ID: 0x${id.toString(16)}`);
    const packet = { packet: name, ...CODECS[name].read(reader) } as Packet;
    if (reader.remaining() > 0)
        throw new Error(`${name} left ${reader.remaining()} unread bytes: contract mismatch`);
    return packet;
}
