# poke-battle-service

The PokeLegends battle worker. It runs Pokémon Showdown battles for **PokeBattle** (Paper) and talks to it over
RabbitMQ with AstralCore's binary packets, so PokeBattle uses its plain `MessagingService`. The worker writes no game
data: rewards, captures and storage stay in PokeCore.

## How it fits

```
Paper servers ──BattleStartPacket──▶ pokebattle.start (shared queue) ──▶ a worker with room takes it
     ▲                                                                    │ claims it in Redis, runs it,
     │◀──────────────── BattleStartReplyPacket (RPC reply) ───────────────┘ answers
     ├── choices / end / attach ──▶ pokebattle.worker.<workerId>
     └◀── updates / requests / errors / ended ── pokebattle.shard.<serverId>
```

- **RabbitMQ is the router.** Every worker consumes the shared start queue one start at a time, and stops consuming
  while it is full (`WORKER_CAPACITY`). Add capacity by starting processes; Paper needs no change.
- **A battle stays on its worker** (it lives in memory). Its later messages go to that worker's exchange.
- **Never twice:** a worker claims the battle in Redis (`HSETNX`) before running it, then acks the start, then replies.
- **Order:** AstralCore handles deliveries concurrently, so every worker-to-shard packet carries a gapless per-battle
  `seq` for the shard to reorder.
- **Hidden information:** each player gets their own view of the battle (the opponent's HP as a percentage, no
  opponent requests).
- **Creature condition:** a side may carry each member's HP, status and PP (`state`); every PokeLegends format applies
  it before the leads switch in, and `BattleEndedPacket.teams` reports how every team left, in start order. The state
  is a `>player` option, so it is in the replay log too. Until the Showdown fork, this is a small patch of
  `Battle.setPlayer` (`src/battle/team-state.ts`).
- **Replay:** every simulator input is appended to `pokebattle:battle:<id>:log`. With the seed, that replays the
  battle exactly (tested). Recovery on another worker uses it (not built yet).
- **Heartbeat:** `pokebattle:worker:<id>` (battles, capacity) with a short TTL, to detect dead workers.

The protocol is defined in PokeBattle's `common` module (`PokeBattlePacketRegistry`, `PokeBattleExchanges`,
`PokeBattleKeys`). `test/contract/vectors.json` holds byte vectors written by AstralCore's Java serializer; the
codec must reproduce them exactly. After a contract change: regenerate them in PokeBattle
(`mvn test -pl common -Dcontract.regenerate=true`), then `npm run sync-vectors` here.

## Formats and AI

`config/formats.json` defines the formats added to the simulator at boot; a shard sends the format id as is
(`polariswild`). Capture, bag, flee and raid mechanics come with the Showdown fork.

AI ids a start may give a side: `wild` (random legal choice). A start naming an unknown AI is refused.

## Running

Node 22+. Same environment variables as AstralCore for the infrastructure (`.env.example`):

| Variable | Default | |
|---|---|---|
| `WORKER_ID` | `<hostname>-<pid>` | keep it stable per process slot (e.g. `battle-1-3`): it names the worker's exchange |
| `WORKER_CAPACITY` | 50 | battles at once; one process uses one core, run one per core |
| `RABBITMQ_HOST/PORT/USERNAME/PASSWORD/VHOST` | localhost, 5672, guest, guest, / | |
| `REDIS_HOST/PORT/USERNAME/PASSWORD/DATABASE` | localhost, 6379, -, -, 0 | |
| `START_TTL_MS` | 10000 | a start nobody took by then expires |
| `BATTLE_IDLE_TIMEOUT_SECONDS` | 900 | a battle with no input for this long is aborted |
| `HEARTBEAT_INTERVAL_MS`, `HEARTBEAT_TTL_SECONDS` | 1000, 5 | |
| `DRAIN_TIMEOUT_SECONDS` | 600 | on SIGTERM: stop taking starts, wait this long for battles, then abort them |
| `FORMATS_FILE` | `config/formats.json` | |
| `LOG_LEVEL` | info | JSON lines on stdout |

```
npm install
npm test          # contract vectors, AI, full battles, store
npm run build && npm start
```
