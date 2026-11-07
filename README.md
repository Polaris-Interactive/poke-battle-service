# poke-battle-service

The PokeSMP battle worker. It runs Pokémon Showdown battles for **PokeBattle** (Paper) and talks to it over
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
- **Creature condition:** a side may carry each member's HP, status and PP (`state`); every PokeSMP format applies
  it before the leads switch in, and `BattleEndedPacket.teams` reports how every team left, in start order. The state
  is a `>player` option, so it is in the replay log too. A fainted member may come along (hp 0, never the lead) so the
  bag can revive it. Until the Showdown fork, this is a small patch of `Battle.setPlayer` (`src/battle/team-state.ts`).
- **Request ids:** the simulator leaves `rqid` to its server, so the session numbers every player request itself; a
  choice for an older one is refused as stale.
- **Turn timer:** with `turnTimerSeconds` > 0, a player request left unanswered that long is answered by the random AI,
  and the player's view gets a `|polaris-timer|<side>` line first.
- **Replay:** every simulator input is appended to `pokebattle:battle:<id>:log`. With the seed, that replays the
  battle exactly (tested).
- **Recovery:** a shard whose battle's worker stopped beating sends `BattleRecoverPacket` to the start queue. The first
  worker with room takes the battle over in Redis (only from a dead worker: no heartbeat, or one from another process
  with the same id), replays its log silently and answers like a start. The battle then goes to the shard again from
  sequence 0: one update per player starting with `|polaris-resync|` (their whole view so far), then the requests still
  unanswered. Re-attaching to another shard (`BattleAttachPacket`) sends the same resync.
- **Ended battles wait:** the `BattleEndedPacket` is kept in the battle's hash (`ended`, base64) for `ENDED_TTL_SECONDS`,
  so a shard that was not there to receive it (crashed, player away) settles it when the player comes back.
- **Absent players:** after `ABSENT_TURNS` turn timers in a row with no choice, the battle is aborted (reason
  `absent`): a battle whose shard crashed does not get played to the end by the timer AI.
- **Heartbeat:** `pokebattle:worker:<id>` (`instance`, battles, capacity) with a short TTL, to detect dead workers.
  `instance` is new on every boot.

The protocol is defined in PokeBattle's `common` module (`PokeBattlePacketRegistry`, `PokeBattleExchanges`,
`PokeBattleKeys`). `test/contract/vectors.json` holds byte vectors written by AstralCore's Java serializer; the
codec must reproduce them exactly. After a contract change: regenerate them in PokeBattle
(`mvn test -pl common -Dcontract.regenerate=true`), then `npm run sync-vectors` here.

## Formats and AI

`config/formats.json` defines the formats added to the simulator at boot; a shard sends the format id as is
(`polariswild`). A format's `polaris` block turns on PokeSMP's choices (`src/battle/polaris-choices.ts`); the ball and
the bag also need the start's `allowCapture` / `allowBag`. Each takes the creature's turn and runs before moves
(singles only):

| Choice | Effect | Line in the player's view |
|---|---|---|
| `ball <ball> <shakes> <caught 0\|1>` | **The shard rolls the capture** and sends the result (logged, so replays agree). A catch ends the battle with the thrower's win, reason `captured` | `\|polaris-ball\|<target>\|<ball>\|<shakes>\|caught\|free` |
| `run` | Escapes when faster, else with the mainline odds (+30/256 per attempt, battle random). Refused when trapped, except Ghost types, Run Away, Smoke Ball. An escape ends with result `fled` | `\|polaris-run\|<pokemon>\|escaped\|failed` |
| `item <item> <position> <effects>` | A bag item on the member at `position` (as `switch N`, fainted ones included). Effects joined by `+`: `heal[=N]`, `cure`, `revive=F`, `pp[=N]`, read by the shard from the item's AstralItems blueprint. Refused if it would do nothing | `\|polaris-item\|<target>\|<item>`, then `-heal` / `-curestatus` |

Raid mechanics come with the Showdown fork.

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
| `ABSENT_TURNS` | 3 | turn timers run out in a row before the battle is aborted as `absent`; 0 never |
| `ENDED_TTL_SECONDS` | 3600 | how long an ended battle's keys (and its ended packet) stay for a shard to settle it |
| `HEARTBEAT_INTERVAL_MS`, `HEARTBEAT_TTL_SECONDS` | 1000, 5 | |
| `DRAIN_TIMEOUT_SECONDS` | 600 | on SIGTERM: stop taking starts, wait this long for battles, then abort them |
| `FORMATS_FILE` | `config/formats.json` | |
| `LOG_LEVEL` | info | JSON lines on stdout |

```
npm install
npm test          # contract vectors, AI, full battles, store
npm run build && npm start
```

## battle-bench

`npm run bench` plays a shard against the running workers through the real start queue. It measures what a player
waits for, excluding the player's own thinking:
- **turn latency:** from a choice published to that battle's next request or end;
- **start latency:** from a start published to the worker's reply.

The player's side answers at once with a random legal choice, against the wild AI. It uses the same `RABBITMQ_*`
variables as the worker. `BENCH_BATTLES` (500), `BENCH_CONCURRENCY` (100), `BENCH_P99_MS` (80), `BENCH_FORMAT` and
`BENCH_TIMEOUT_SECONDS` tune it. It exits 1 unless every battle finished and the turn p99 is under the target.

Phase 0 exit criterion: 500 battles on 4 workers, p99 < 80 ms. First runs on 2026-11-07, on a 10-core laptop, with
RabbitMQ and Redis in Docker Desktop, 4 workers of capacity 50:

| Concurrent battles | Turn p50 | Turn p99 | Turn max | Start p99 |
|---|---|---|---|---|
| 100 (4 runs) | 24–31 ms | 50–73 ms | 105–130 ms | ~860 ms (100 starts at once) |
| 40 (4 runs) | 11–15 ms | 26–38 ms, one run at 82 | 38–233 ms | ~120 ms |

These battles answer instantly. With real players thinking for seconds, a worker carries far less load per battle
than here.

