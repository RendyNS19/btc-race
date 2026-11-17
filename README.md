# Dip Hunter — btc-race-24h-20261117-0603

A long-only mean-reversion bot trading Coinbase Wrapped BTC (cbBTC) on 1-minute
Orca Whirlpool bars, entered in make.fun's "Race a BTC trading bot live for 24 hours".

## Strategy

Bitcoin's 1-minute price spends most of a day oscillating inside a range a few percent
wide. The bot buys only deep dips and sells the recovery, and otherwise sits in cash:

- **Entry:** the close falls at least **2.75 standard deviations** below its 300-bar
  (5-hour) mean → buy with 100% of cash.
- **Exit:** the close recovers to **1.5 deviations above** the mean, or falls **2%
  below** the entry close (stop-loss) → sell the whole position.
- **Guards:** no new entries in the last 90 bars of the window; if the bot has still
  never traded by bar 1200, it buys a milder dip (1.0 deviation) so the entry still
  makes at least one trade.
- **Costs:** a full round trip pays ~36 bps (4 bps fee + 2 bps slippage + ~12 bps of
  price impact a side at this pool's depth), so the bot only trades moves several
  times that size. Max slippage per order is 200 bps from the decision close.

## Dev-window result (local grade, `makefun grade-local`)

Two round trips, net PnL **+$16.00** on $1,000, max drawdown **0.72%** — the dev
gate (net PnL > $0) passes. For comparison on the same window: buy-and-hold +$1.07,
momentum +$2.45, EMA-cross −$106.21.

## Files

- `main.ts` — the bot (Node 22, standard library only; runs via the kit's
  `vendor/makefun-bars.ts` shim, copied byte-identical from the kit's SDK).
- `vendor/makefun-bars.ts` — the kit's bars-replay shim, unmodified.

## Run locally

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
```
