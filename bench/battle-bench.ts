import { connect, type Channel, type ConsumeMessage } from 'amqplib';
import ps from 'pokemon-showdown';

import { RandomAi } from '../src/ai/random-ai.js';
import type { ChoiceRequest } from '../src/ai/ai.js';
import { decode, encode, type BattleStartPacket, type Packet } from '../src/codec/packets.js';
import { exchanges } from '../src/store/keys.js';

/**
 * battle-bench: plays a shard against the running workers, through the real start queue, and measures what a player
 * would wait for (Phase 0 exit: 500 battles on 4 workers, p99 < 80 ms, the human excluded).
 * <ul>
 *     <li>turn latency: from a choice published to the next request (or end) of that battle, i.e. the worker's
 *     simulation, the AI's answer and both RabbitMQ hops;</li>
 *     <li>start latency: from a start published to the worker's reply.</li>
 * </ul>
 * The player's side answers at once with a random legal choice; the opponent is the worker's wild AI. Same
 * RABBITMQ_* variables as the worker. Settings: BENCH_BATTLES (500), BENCH_CONCURRENCY (100), BENCH_P99_MS (80),
 * BENCH_FORMAT (polariswild), BENCH_TIMEOUT_SECONDS (600).
 */

const { Teams } = ps;

function integer(name: string, fallback: number): number {
    const raw = process.env[name];
    return raw === undefined || raw === '' ? fallback : Number.parseInt(raw, 10);
}

const total = integer('BENCH_BATTLES', 500);
const concurrency = integer('BENCH_CONCURRENCY', 100);
const p99Target = integer('BENCH_P99_MS', 80);
const timeoutSeconds = integer('BENCH_TIMEOUT_SECONDS', 600);
const format = process.env.BENCH_FORMAT || 'polariswild';
const shardId = `bench-${process.pid}`;
const REPLY_TO = 'amq.rabbitmq.reply-to';

interface Running {
    startedAt: number;
    workerId: string | null;
    /** A request that came before the start reply: answered once the worker is known. */
    early: { rqid: number; request: ChoiceRequest } | null;
    choiceAt: number | null;
}

const ai = new RandomAi();
const running = new Map<string, Running>();
const turnLatencies: number[] = [];
const startLatencies: number[] = [];
const results = new Map<string, number>();
const workers = new Map<string, number>();
let launched = 0;
let finished = 0;
let refused = 0;

function team(): string {
    // No held items: the bench measures the simulator, not berries
    return Teams.pack(Teams.generate('gen9randombattle').map(set => ({ ...set, item: '' })));
}

function startPacket(): BattleStartPacket {
    return {
        packet: 'BattleStartPacket',
        battleId: crypto.randomUUID(),
        shardId,
        format,
        seed: '',
        sides: [
            { slot: 'p1', name: 'Bench', playerId: crypto.randomUUID(), team: team(), ai: '', state: [] },
            { slot: 'p2', name: 'wild', playerId: null, team: team(), ai: 'wild', state: [] },
        ],
        turnTimerSeconds: 0,
        allowBag: false,
        allowCapture: false,
    };
}

function percentile(values: number[], p: number): number {
    if (values.length === 0)
        return Number.NaN;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.ceil(p / 100 * sorted.length) - 1)]!;
}

function summary(values: number[]): string {
    const fixed = (value: number) => value.toFixed(1).padStart(7);
    return `n=${String(values.length).padStart(6)}  p50 ${fixed(percentile(values, 50))}  p95 ${fixed(percentile(values, 95))}`
        + `  p99 ${fixed(percentile(values, 99))}  max ${fixed(Math.max(...values))} ms`;
}

const connection = await connect({
    protocol: 'amqp',
    hostname: process.env.RABBITMQ_HOST || 'localhost',
    port: integer('RABBITMQ_PORT', 5672),
    username: process.env.RABBITMQ_USERNAME || 'guest',
    password: process.env.RABBITMQ_PASSWORD || 'guest',
    vhost: process.env.RABBITMQ_VHOST || '/',
});
const channel: Channel = await connection.createChannel();

// The shard exchange, declared as AstralCore does
const shardExchange = exchanges.shard(shardId);
await channel.assertExchange(shardExchange, 'fanout', { durable: false, autoDelete: true });
const { queue } = await channel.assertQueue('', { exclusive: true, autoDelete: true });
await channel.bindQueue(queue, shardExchange, '');
// The start exchange must exist: the workers declare it
await channel.checkExchange(exchanges.start);

let done: () => void;
const allDone = new Promise<void>(resolve => {
    done = resolve;
});

function launch(): void {
    while (launched < total && running.size < concurrency) {
        const packet = startPacket();
        running.set(packet.battleId, { startedAt: performance.now(), workerId: null, early: null, choiceAt: null });
        launched++;
        channel.publish(exchanges.start, '', encode(packet), {
            appId: shardId, replyTo: REPLY_TO, correlationId: packet.battleId,
        });
    }
}

function close(battleId: string, result: string): void {
    if (!running.delete(battleId))
        return;
    finished++;
    results.set(result, (results.get(result) ?? 0) + 1);
    if (finished % 50 === 0)
        console.log(`  ${finished}/${total} battles`);
    if (finished === total)
        done();
    else
        launch();
}

function answer(battleId: string, battle: Running, rqid: number, request: ChoiceRequest): void {
    const choice = ai.choose(request);
    if (choice === null)
        return;
    battle.choiceAt = performance.now();
    channel.publish(exchanges.worker(battle.workerId!), '', encode({
        packet: 'BattleChoicePacket', battleId, side: 'p1', rqid, choice,
    }), { appId: shardId });
}

// Start replies (RPC, direct reply-to)
await channel.consume(REPLY_TO, (message: ConsumeMessage | null) => {
    if (message === null)
        return;
    const packet = decode(message.content);
    if (packet.packet !== 'BattleStartReplyPacket')
        return;
    const battle = running.get(packet.battleId);
    if (battle === undefined)
        return;
    startLatencies.push(performance.now() - battle.startedAt);
    if (!packet.accepted) {
        refused++;
        console.error(`  start refused: ${packet.reason}`);
        close(packet.battleId, 'refused');
        return;
    }
    battle.workerId = packet.workerId;
    workers.set(packet.workerId, (workers.get(packet.workerId) ?? 0) + 1);
    if (battle.early !== null) {
        const { rqid, request } = battle.early;
        battle.early = null;
        answer(packet.battleId, battle, rqid, request);
    }
}, { noAck: true });

// Worker packets for this shard, in order (one worker channel, one consumer)
await channel.consume(queue, (message: ConsumeMessage | null) => {
    if (message === null)
        return;
    const packet: Packet = decode(message.content);
    if (!('battleId' in packet))
        return;
    const battle = running.get(packet.battleId);
    if (battle === undefined)
        return;
    switch (packet.packet) {
        case 'BattleRequestPacket': {
            const request = JSON.parse(packet.request) as ChoiceRequest;
            if (request.wait)
                return;
            if (battle.choiceAt !== null) {
                turnLatencies.push(performance.now() - battle.choiceAt);
                battle.choiceAt = null;
            }
            if (battle.workerId === null)
                battle.early = { rqid: packet.rqid, request };
            else
                answer(packet.battleId, battle, packet.rqid, request);
            break;
        }
        case 'BattleChoiceErrorPacket':
            console.error(`  choice refused in ${packet.battleId}: ${packet.message}`);
            break;
        case 'BattleEndedPacket':
            if (battle.choiceAt !== null)
                turnLatencies.push(performance.now() - battle.choiceAt);
            close(packet.battleId, packet.result);
            break;
        default:
    }
}, { noAck: true });

console.log(`battle-bench: ${total} battles, ${concurrency} at once, format ${format}, shard ${shardId}`);
const began = performance.now();
launch();
const timeout = setTimeout(() => {
    console.error(`Timed out after ${timeoutSeconds} s with ${running.size} battles running`);
    done();
}, timeoutSeconds * 1000);
await allDone;
clearTimeout(timeout);
const seconds = (performance.now() - began) / 1000;

console.log('');
console.log(`finished ${finished}/${total} in ${seconds.toFixed(1)} s (${(finished / seconds).toFixed(1)} battles/s), `
    + `refused ${refused}`);
console.log(`results  ${[...results].map(([result, count]) => `${result} ${count}`).join(', ')}`);
console.log(`workers  ${[...workers].map(([worker, count]) => `${worker} ${count}`).join(', ')}`);
console.log(`turn     ${summary(turnLatencies)}`);
console.log(`start    ${summary(startLatencies)}`);
const p99 = percentile(turnLatencies, 99);
const passed = finished === total && refused === 0 && p99 < p99Target;
console.log(passed ? `PASS: turn p99 ${p99.toFixed(1)} ms < ${p99Target} ms`
    : `FAIL: turn p99 ${p99.toFixed(1)} ms (target < ${p99Target} ms), ${finished}/${total} finished`);

await connection.close();
process.exit(passed ? 0 : 1);
