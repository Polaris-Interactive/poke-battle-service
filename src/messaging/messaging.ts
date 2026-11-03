import { connect, type Channel, type ChannelModel, type ConsumeMessage, type RecoveringChannelModel } from 'amqplib';

import { decode, encode, type BattleStartPacket, type Packet, type ShardPacket } from '../codec/packets.js';
import type { WorkerConfig } from '../config.js';
import { log } from '../log.js';
import { exchanges } from '../store/keys.js';
import type { Outbox } from '../battle/session.js';

/**
 * What to do with a start once handled.
 * <ul>
 *     <li>reply: acknowledge it and answer the shard (accepted or refused);</li>
 *     <li>drop: acknowledge it without answering (another worker already runs this battle);</li>
 *     <li>requeue: give it back to the queue for another worker (this one filled up meanwhile).</li>
 * </ul>
 */
export type StartOutcome =
    | { kind: 'reply'; reply: Packet }
    | { kind: 'drop' }
    | { kind: 'requeue' };

export interface MessagingHandlers {
    onStart(packet: BattleStartPacket): Promise<StartOutcome>;
    /** A battle command from a shard (choice, end, attach). */
    onCommand(packet: Packet): void;
}

/**
 * The worker's RabbitMQ side, speaking AstralCore's conventions so PokeBattle uses its plain MessagingService:
 * binary packets, {@code appId} as the sender id (echoes are dropped), RPC answers published to the default exchange
 * with the request's {@code replyTo} and {@code correlationId}.
 * <p>
 * RabbitMQ is the router: every worker consumes the shared start queue, one start at a time, and stops consuming it
 * while full. A battle's later messages arrive on this worker's own exchange. The topology is declared again on every
 * reconnection.
 */
export class Messaging implements Outbox {

    private connection: RecoveringChannelModel | null = null;
    private startChannel: Channel | null = null;
    private publishChannel: Channel | null = null;
    private startConsumer: string | null = null;
    private startsPaused = false;
    private readonly declaredShards = new Set<string>();

    constructor(private readonly config: WorkerConfig, private readonly handlers: MessagingHandlers) {
    }

    async connect(): Promise<void> {
        const { host, port, username, password, vhost } = this.config.rabbitmq;
        this.connection = await connect({ protocol: 'amqp', hostname: host, port, username, password, vhost }, {
            clientProperties: { connection_name: `poke-battle-service ${this.config.workerId}` },
            recovery: { setup: (model: ChannelModel) => this.setup(model), initialMaxRetries: 5 },
        });
        this.connection.on('disconnect', error => log.warn('RabbitMQ disconnected, reconnecting', { error }));
        this.connection.on('reconnect-failed', error => log.error('RabbitMQ reconnection gave up', { error }));
    }

    async close(): Promise<void> {
        await this.connection?.close();
        this.connection = null;
    }

    private async setup(model: ChannelModel): Promise<void> {
        this.declaredShards.clear();

        // Shared start queue: durable, so starts wait for a worker while all are busy; a start the shard stopped
        // waiting for expires
        const start = await model.createChannel();
        await start.assertExchange(exchanges.start, 'fanout', { durable: true, autoDelete: false });
        await start.assertQueue(exchanges.start, {
            durable: true,
            arguments: { 'x-message-ttl': this.config.startTtlMs },
        });
        await start.bindQueue(exchanges.start, exchanges.start, '');
        await start.prefetch(1);
        this.startChannel = start;
        this.startConsumer = null;
        if (!this.startsPaused)
            await this.consumeStarts();

        // This worker's exchange: durable and never auto-deleted, so a shard publishing to a dead worker gets its
        // message dropped instead of a channel error
        const commands = await model.createChannel();
        const exchange = exchanges.worker(this.config.workerId);
        await commands.assertExchange(exchange, 'fanout', { durable: true, autoDelete: false });
        const { queue } = await commands.assertQueue('', { exclusive: true, autoDelete: true });
        await commands.bindQueue(queue, exchange, '');
        await commands.consume(queue, message => {
            if (message !== null)
                this.onCommand(commands, message);
        });

        this.publishChannel = await model.createChannel();
        this.publishChannel.on('error', error => log.warn('Publish channel error', { error }));
        log.info('Connected to RabbitMQ', { workerId: this.config.workerId, startsPaused: this.startsPaused });
    }

    // ---- Starts ----

    async pauseStarts(): Promise<void> {
        this.startsPaused = true;
        const consumer = this.startConsumer;
        this.startConsumer = null;
        if (consumer !== null && this.startChannel !== null)
            await this.startChannel.cancel(consumer).catch(error =>
                log.warn('Could not stop consuming starts', { error }));
    }

    async resumeStarts(): Promise<void> {
        this.startsPaused = false;
        if (this.startConsumer === null && this.startChannel !== null)
            await this.consumeStarts();
    }

    private async consumeStarts(): Promise<void> {
        const channel = this.startChannel!;
        const { consumerTag } = await channel.consume(exchanges.start, message => {
            if (message !== null)
                void this.onStart(channel, message);
        });
        this.startConsumer = consumerTag;
    }

    private async onStart(channel: Channel, message: ConsumeMessage): Promise<void> {
        let packet: Packet;
        try {
            packet = decode(message.content);
        } catch (error) {
            log.error('Unreadable start, dropped', { error });
            channel.ack(message);
            return;
        }
        if (packet.packet !== 'BattleStartPacket') {
            log.warn('Unexpected packet on the start queue, dropped', { packet: packet.packet });
            channel.ack(message);
            return;
        }

        let outcome: StartOutcome;
        try {
            outcome = await this.handlers.onStart(packet);
        } catch (error) {
            log.error('Start failed', { battleId: packet.battleId, error });
            outcome = { kind: 'requeue' };
        }

        if (outcome.kind === 'requeue') {
            channel.nack(message, false, true);
            return;
        }
        channel.ack(message);
        if (outcome.kind === 'reply')
            this.reply(message, outcome.reply);
    }

    private reply(request: ConsumeMessage, packet: Packet): void {
        const { replyTo, correlationId } = request.properties;
        if (!replyTo)
            return;
        try {
            this.publishChannel?.publish('', replyTo, encode(packet), {
                appId: this.config.workerId,
                correlationId,
            });
        } catch (error) {
            log.warn('Could not answer a start', { error });
        }
    }

    // ---- Commands ----

    private onCommand(channel: Channel, message: ConsumeMessage): void {
        channel.ack(message);
        if (message.properties.appId === this.config.workerId)
            return;
        try {
            this.handlers.onCommand(decode(message.content));
        } catch (error) {
            log.error('Unreadable or failed battle command', { error });
        }
    }

    // ---- Outbox ----

    send(shardId: string, packet: ShardPacket): void {
        const channel = this.publishChannel;
        if (channel === null) {
            log.warn('Not connected, battle packet lost', { battleId: packet.battleId, packet: packet.packet });
            return;
        }
        const exchange = exchanges.shard(shardId);
        try {
            // Same arguments as AstralCore's registerExchange, which declares it on the shard
            if (!this.declaredShards.has(exchange)) {
                void channel.assertExchange(exchange, 'fanout', { durable: false, autoDelete: true });
                this.declaredShards.add(exchange);
            }
            channel.publish(exchange, '', encode(packet), { appId: this.config.workerId });
        } catch (error) {
            log.warn('Battle packet lost', { battleId: packet.battleId, packet: packet.packet, error });
        }
    }
}
