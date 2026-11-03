# poke-battle-service

Node/TypeScript battle worker for PokeBattle. Design and decisions live in the PokeLegends Project Brain at
`/Volumes/Untitled/Polaris Interactive/pokemon` (`brain read-page battle-transport`, `pokebattle-spec`).

## Working rules
- The protocol belongs to PokeBattle's `common` module. Change a packet there first, regenerate the vectors, then
  `npm run sync-vectors` and update `src/codec/packets.ts` until `test/codec.test.ts` passes. Never renumber an id.
- Speak AstralCore's conventions: `appId` = sender id (drop our own echoes), RPC replies to the default exchange with
  `replyTo` + `correlationId`, shard exchanges declared exactly as AstralCore does (fanout, non-durable, auto-delete).
- Everything a shard sees goes through `BattleSession.emit` (sequence numbers). Every simulator input goes through
  `BattleSession.input` (Redis replay log).
- A player's choice is one line and never contains `>`: it must never become a simulator command.
- No creature, move or item names in code or tests: tests use the simulator's random teams.
- Commit after every change (`feat:`, `fix:`, `build:`, `refactor:`), branch `master`.
