/**
 * AstralCore's BinaryMessage encoding (core-commons, com.astralrealms.core.packet.binary.BinaryMessage):
 * big-endian fixed-width numbers, Minecraft-style varints, strings as varint byte length + UTF-8, UUIDs as two
 * big-endian longs, booleans as one byte, lists as varint count + elements, optionals as a boolean + the value.
 * Any change here must keep test/contract/vectors.json passing: those bytes come from the Java implementation.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class BinaryWriter {
    private buffer = Buffer.allocUnsafe(256);
    private position = 0;

    private ensure(size: number): void {
        if (this.buffer.length - this.position >= size)
            return;
        const grown = Buffer.allocUnsafe(Math.max(Math.ceil(this.buffer.length * 1.5), this.position + size));
        this.buffer.copy(grown, 0, 0, this.position);
        this.buffer = grown;
    }

    writeByte(value: number): this {
        this.ensure(1);
        this.buffer.writeUInt8(value & 0xff, this.position);
        this.position += 1;
        return this;
    }

    writeBoolean(value: boolean): this {
        return this.writeByte(value ? 1 : 0);
    }

    writeInt(value: number): this {
        this.ensure(4);
        this.buffer.writeInt32BE(value, this.position);
        this.position += 4;
        return this;
    }

    writeLong(value: bigint): this {
        this.ensure(8);
        this.buffer.writeBigInt64BE(value, this.position);
        this.position += 8;
        return this;
    }

    /** Java writes the int's two's complement bits, so negative values take 5 bytes. */
    writeVarInt(value: number): this {
        let remaining = value >>> 0;
        while (remaining > 0x7f) {
            this.writeByte((remaining & 0x7f) | 0x80);
            remaining >>>= 7;
        }
        return this.writeByte(remaining);
    }

    writeVarLong(value: number | bigint): this {
        let remaining = BigInt.asUintN(64, BigInt(value));
        while (remaining > 0x7fn) {
            this.writeByte(Number(remaining & 0x7fn) | 0x80);
            remaining >>= 7n;
        }
        return this.writeByte(Number(remaining));
    }

    writeBytes(bytes: Uint8Array): this {
        this.ensure(bytes.length);
        this.buffer.set(bytes, this.position);
        this.position += bytes.length;
        return this;
    }

    /** Null is written as an empty string, as Java does. */
    writeString(value: string | null | undefined): this {
        if (value == null)
            return this.writeVarInt(0);
        const bytes = Buffer.from(value, 'utf8');
        this.writeVarInt(bytes.length);
        return this.writeBytes(bytes);
    }

    writeUuid(value: string): this {
        if (!UUID_PATTERN.test(value))
            throw new Error(`Invalid UUID ${value}`);
        return this.writeBytes(Buffer.from(value.replaceAll('-', ''), 'hex'));
    }

    writeList<T>(values: readonly T[], write: (writer: this, value: T) => void): this {
        this.writeVarInt(values.length);
        for (const value of values)
            write(this, value);
        return this;
    }

    writeOptional<T>(value: T | null | undefined, write: (writer: this, value: T) => void): this {
        if (value == null)
            return this.writeBoolean(false);
        this.writeBoolean(true);
        write(this, value);
        return this;
    }

    toBuffer(): Buffer {
        return Buffer.from(this.buffer.subarray(0, this.position));
    }
}

export class BinaryReader {
    private position = 0;

    constructor(private readonly buffer: Buffer) {
    }

    remaining(): number {
        return this.buffer.length - this.position;
    }

    private require(size: number, what: string): void {
        if (this.remaining() < size)
            throw new Error(`Insufficient data in buffer for ${what}`);
    }

    readByte(): number {
        this.require(1, 'byte');
        return this.buffer.readUInt8(this.position++);
    }

    readBoolean(): boolean {
        return this.readByte() !== 0;
    }

    readInt(): number {
        this.require(4, 'int');
        const value = this.buffer.readInt32BE(this.position);
        this.position += 4;
        return value;
    }

    readLong(): bigint {
        this.require(8, 'long');
        const value = this.buffer.readBigInt64BE(this.position);
        this.position += 8;
        return value;
    }

    readVarInt(): number {
        let result = 0;
        let shift = 0;
        let byte: number;
        do {
            byte = this.readByte();
            result |= (byte & 0x7f) << shift;
            shift += 7;
            if (shift > 35)
                throw new Error(`VarInt too big (shift=${shift})`);
        } while ((byte & 0x80) !== 0);
        return result | 0;
    }

    /** Returned as a number: sequence numbers stay far below 2^53. */
    readVarLong(): number {
        let result = 0n;
        let shift = 0n;
        let byte: number;
        do {
            byte = this.readByte();
            result |= BigInt(byte & 0x7f) << shift;
            shift += 7n;
            if (shift > 63n)
                throw new Error(`VarLong too big (shift=${shift})`);
        } while ((byte & 0x80) !== 0);
        return Number(BigInt.asIntN(64, result));
    }

    readBytes(length: number): Buffer {
        this.require(length, `${length} bytes`);
        const bytes = this.buffer.subarray(this.position, this.position + length);
        this.position += length;
        return bytes;
    }

    readString(): string {
        const length = this.readVarInt();
        if (length === 0)
            return '';
        return this.readBytes(length).toString('utf8');
    }

    readUuid(): string {
        const hex = this.readBytes(16).toString('hex');
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }

    readList<T>(read: (reader: this) => T): T[] {
        const length = this.readVarInt();
        const values: T[] = [];
        for (let i = 0; i < length; i++)
            values.push(read(this));
        return values;
    }

    readOptional<T>(read: (reader: this) => T): T | null {
        return this.readBoolean() ? read(this) : null;
    }
}
