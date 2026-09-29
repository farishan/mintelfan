Continue mintelfan in /Users/faris/dev/personal/mintelfan (git main @ ee4f534).

Context: single-file Bun+TS CLI `index.ts` implements PRD Stages 1-6. Read `docs/prd.md` and `index.ts` first. Run with `sudo $(which bun) index.ts -- --once` to verify.

Known Intel facts (MacBookPro16,3, i5-8257U, macOS 15.7.7):
- Single fan, SMC line is `Fan: 6702.16 rpm` (decimal, parse + round)
- Thermal: SMC `CPU die temperature / CPU Thermal level / IO Thermal level / Number of prochots` + `pmset -g therm` pressure
- Energy: `sudo powermetrics --samplers tasks --show-process-energy` has 7 numeric cols, Energy Impact is last; filter self rows `top/powermetrics/own-bun-pid`
- powermetrics SMC/energy require sudo, degrade gracefully to `unavailable (...)` without it
- Flags already work: `--once --json --interval N`, `bun run start`, snapshots have timestamp/fans/thermal/cpuLine/load/processes/energy/gpu=null

Next: PRD Stage 7 correlation + Stage 8 dashboard. Do NOT build all at once:
1. Stage 7: keep ring buffer of snapshots (in-memory), detect process activity rise -> temp rise -> fan rise, output `likely/possible/insufficient evidence` with Evidence + Confidence (medium/low), never claim causation.
2. Stage 8: live terminal renderer reusing existing collectors (`--interval` + console.clear already exists, keep it simple, no frameworks).

Constraints: read-only (no SMC writes, no fan control, no pkill), Bun TS minimal deps, strict/simple functions, keep program runnable after every change, split into `src/` collectors only if it stays small.
