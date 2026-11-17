// Dip Hunter: a long-only mean-reversion bot for cbBTC on 1-minute bars.
//
// The idea, in one paragraph: over a single day Bitcoin's 1-minute price spends most of
// its time oscillating inside a range a few percent wide, and the big hourly swings in the
// dev window were all preceded by a deep dip below the price's own recent mean. This bot
// buys only those deep dips and sells the recovery, and otherwise sits in cash. A full
// round trip costs about 36 bps (4 bps fee + 2 bps slippage + ~12 bps of price impact a
// side at this pool's depth), so it only trades when the expected move is several times
// that: it waits for the price to fall at least 2.75 standard deviations below its
// 300-bar (5-hour) mean. A tiered fallback relaxes the entry if the bot has still never
// traded late in the window, so a trend-only window still yields at least one trade.
//
// The exit is two-regime, because the dev window's two recoveries had different shapes.
// A normal recovery grinds upward: the bot sells when the close reaches 1.5 deviations
// above the mean, or earlier, once the close has passed 1.0 deviations and a bar closes
// down — the move has stalled at a local top, and waiting for the full target only gives
// the gain back. A spike recovery goes vertical: once the highest deviation since entry
// reaches 2.0, the fixed targets are disarmed and the bot instead rides the spike,
// selling when the deviation fades 0.3 below its peak — the first sign the burst is over.
// On the dev window the spike exit lifts the first round trip from +$10.20 to +$19.26
// and the stall exit adds a little to the second: +$25.61 net in all, against +$16.00
// for the fixed-target exit, with the same 0.72% maximum drawdown. A 2% stop-loss
// under the entry close guards both regimes. Every exit parameter sits in the middle
// of a plateau: fades of 0.15–0.5 deviations, arm levels of 1.5–2.5 and stall levels
// of 0.9–1.1 all score within a dollar of the chosen point on the dev window.
//
// Determinism: the bot keeps the closes it has seen and recomputes the mean and the
// population standard deviation over the last 300 of them on every bar, in float64. It
// reads no clock, no environment and no randomness; the same bars always give the same
// orders, so the two graded executions agree byte for byte.

import { runBars, type BarsState, type Batch, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
/** The window is 1,440 one-minute bars (the rules fix that for both windows). */
const TOTAL_BARS = 1440;
/** The lookback for the mean and the standard deviation: 300 bars = 5 hours. */
const LOOKBACK = 300;
/** Buy when the close is this many deviations below its 300-bar mean. */
const Z_IN = 2.75;
/** Normal regime: sell when the close has recovered to this many deviations above the mean. */
const Z_OUT = 1.5;
/** Normal regime: sell on a down bar once the close has passed this many deviations —
 *  the recovery has stalled at a local top. */
const Z_STALL = 1.0;
/** Spike regime: once the highest deviation since entry reaches this, the fixed
 *  targets above are disarmed and the fade exit below takes over. */
const Z_ARM = 2.0;
/** Spike regime: sell when the deviation fades this far below its peak since entry. */
const Z_FADE = 0.3;
/** Cut the position when the close falls this far below the entry close. */
const STOP_LOSS = 0.02;
/** No new entries in the last 90 bars: a late entry has no time to recover its costs. */
const NO_ENTRY_AFTER = TOTAL_BARS - 90;
/** The fallback tiers: if the bot has still never held a position, the dip it waits
 *  for gets milder as the window runs out, so the entry still makes at least one trade
 *  on a window where the deep dip never comes (a flat window fails the guardrails
 *  with zero trades, which ranks below every entry that made one). The last tier buys
 *  at the market: on a strong uptrend the price never dips at all, and buying the
 *  trend for the final two hours beats sitting out entirely. The stop-loss still
 *  applies to a fallback buy. None of these tiers fires on the dev window, where the
 *  first deep dip comes at bar 371. */
const FALLBACKS = [
  { bar: 720, z: 2.0 },
  { bar: 1200, z: 1.0 },
  { bar: 1300, z: Infinity },
];
/** The fill must land within 2% of the close the order was decided on; a 1-minute move
 *  is normally a few hundredths of a percent, so this only refuses a genuine gap. */
const MAX_SLIPPAGE_BPS = 200;

/** The closes the bot has seen, in the bars' own price units (USDC x 10^5). */
const closes: number[] = [];
/** The close of the bar the current position's buy was decided on (a proxy for the
 *  fill price, which lands a minute later and within a few bps of it). */
let entryClose: number | null = null;
/** The highest deviation since the current position was entered: it arms the spike
 *  regime and anchors its fade exit. Reset whenever the bot is flat. */
let peakZ = Number.NEGATIVE_INFINITY;
/** Whether the bot has ever held the asset: the fallback needs it, and a rejected
 *  buy must not count. */
let everHeld = false;

/** Mean and population standard deviation of the last LOOKBACK closes, or null while
 *  fewer than LOOKBACK closes have been seen. */
function meanAndSd(): { mean: number; sd: number } | null {
  if (closes.length < LOOKBACK) return null;
  const window = closes.slice(closes.length - LOOKBACK);
  let sum = 0;
  for (const c of window) sum += c;
  const mean = sum / LOOKBACK;
  let sq = 0;
  for (const c of window) {
    const d = c - mean;
    sq += d * d;
  }
  return { mean, sd: Math.sqrt(sq / LOOKBACK) };
}

await runBars({
  onBatch(state: BarsState, batch: Batch) {
    for (const bar of batch.bars) {
      if (bar.symbol === SYMBOL) closes.push(Number(bar.c));
    }
    // A buy that filled on this batch confirms the position (and that the fallback
    // has served its purpose); a rejected buy leaves everHeld false.
    for (const fill of batch.fills) {
      if (fill.symbol === SYMBOL && fill.side === 'buy' && fill.status === 'filled') everHeld = true;
    }
    if (state.warmingUp) return [];

    const held = state.positions.get(SYMBOL);
    const stats = meanAndSd();
    if (stats === null) return [];
    const close = Number(state.latest.get(SYMBOL)!.c);
    const z = stats.sd > 0 ? (close - stats.mean) / stats.sd : 0;

    const orders: (BuyInput | SellInput)[] = [];
    if (held !== undefined) {
      if (z > peakZ) peakZ = z;
      const spiked = peakZ >= Z_ARM;
      const fade = spiked && z <= peakZ - Z_FADE;
      const prevClose = closes.length >= 2 ? closes[closes.length - 2] : null;
      const stall = !spiked && z >= Z_STALL && prevClose !== null && close < prevClose;
      const target = !spiked && z >= Z_OUT;
      const stop = entryClose !== null && close <= entryClose * (1 - STOP_LOSS);
      if (fade || stall || target || stop) {
        orders.push({ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
        entryClose = null;
        peakZ = Number.NEGATIVE_INFINITY;
      }
      return orders;
    }

    if (batch.seq >= NO_ENTRY_AFTER) return [];
    let threshold = Z_IN;
    if (!everHeld) {
      for (const tier of FALLBACKS) {
        if (batch.seq >= tier.bar) threshold = tier.z;
      }
    }
    if (z > -threshold) return [];
    let notional = state.cash;
    const room = state.weightRoom(SYMBOL);
    if (room < notional) notional = room;
    if (notional < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    entryClose = close;
    peakZ = Number.NEGATIVE_INFINITY;
    orders.push({ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS });
    return orders;
  },
});
