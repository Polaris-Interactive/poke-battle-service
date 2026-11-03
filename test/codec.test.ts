import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { decode, encode, packetId, type Packet } from '../src/codec/packets.js';

interface Vector {
    packet: Packet['packet'];
    id: number;
    fields: Record<string, unknown>;
    hex: string;
}

/**
 * The bytes come from AstralCore's Java serializer (PokeBattle common, ContractVectorsTest). Refresh this copy with
 * `npm run sync-vectors` whenever the contract changes.
 */
const vectors: Vector[] = JSON.parse(readFileSync(new URL('./contract/vectors.json', import.meta.url), 'utf8'));

describe('contract vectors', () => {
    it.each(vectors.map(vector => [vector.packet, vector] as const))('%s encodes like AstralCore', (_, vector) => {
        const packet = { packet: vector.packet, ...vector.fields } as Packet;

        expect(packetId(vector.packet)).toBe(vector.id);
        expect(encode(packet).toString('hex')).toBe(vector.hex);
        expect(decode(Buffer.from(vector.hex, 'hex'))).toEqual(packet);
    });

    it('rejects unknown ids and trailing bytes', () => {
        expect(() => decode(Buffer.from('7f', 'hex'))).toThrow(/Unknown packet ID/);
        const attach = vectors.find(vector => vector.packet === 'BattleAttachPacket')!;
        expect(() => decode(Buffer.from(attach.hex + '00', 'hex'))).toThrow(/unread bytes/);
    });
});
