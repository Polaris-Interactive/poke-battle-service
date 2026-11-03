/**
 * Redis keys, mirrored from PokeBattle's PokeBattleKeys.
 */
const PREFIX = 'pokebattle:';

export const keys = {
    battle: (battleId: string) => `${PREFIX}battle:${battleId}`,
    battleLog: (battleId: string) => `${PREFIX}battle:${battleId}:log`,
    worker: (workerId: string) => `${PREFIX}worker:${workerId}`,
};

/**
 * RabbitMQ names, mirrored from PokeBattle's PokeBattleExchanges.
 */
export const exchanges = {
    start: 'pokebattle.start',
    worker: (workerId: string) => `pokebattle.worker.${workerId}`,
    shard: (shardId: string) => `pokebattle.shard.${shardId}`,
};
