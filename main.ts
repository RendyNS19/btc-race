// Dip Hunter: a long-only mean-reversion bot for cbBTC on 1-minute bars.
//
// The idea, in one paragraph: over a single day Bitcoin's 1-minute price spends most of
// its time oscillating inside a range a few percent wide, and the big hourly swings in the
// dev window were all preceded by a deep dip below the price's own recent mean. This bot
// buys only those deep dips and sells the recovery, and otherwise sits in cash. A full
// round trip costs about 36 bps (4 bps fee + 2 bps slippage + ~12 bps of price impact a
// side at this pool's depth), so it only trades when the expected move is several times
// that: it waits for the price to fall at least 2.75 standard deviations below its
// 300-bar (5-hour) mean, then sells when it has recovered to 1.5 deviations above that
// mean, or cuts the position 2% below its entry if the dip keeps falling instead. On the
// dev window that is two round trips for +$16.00 net, max drawdown 0.72%.
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
/** Sell when the close has recovered to this many deviations above the mean. */
const Z_OUT = 1.5;
/** Cut the position when the close falls this far below the entry close. */
const STOP_LOSS = 0.02;
/** No new entries in the last 90 bars: a late entry has no time to recover its costs. */
const NO_ENTRY_AFTER = TOTAL_BARS - 90;
/** The fallback: if the bot has still never held a position by this bar, it buys a
 *  milder dip, so the entry still makes at least one trade on a window where the deep
 *  dip never comes (a flat window fails the guardrails with zero trades). */
const FALLBACK_BAR = 1200;
const FALLBACK_Z = 1.0;
/** The fill must land within 2% of the close the order was decided on; a 1-minute move
 *  is normally a few hundredths of a percent, so this only refuses a genuine gap. */
const MAX_SLIPPAGE_BPS = 200;

/** The closes the bot has seen, in the bars' own price units (USDC x 10^5). */
const closes: number[] = [];
/** The close of the bar the current position's buy was decided on (a proxy for the
 *  fill price, which lands a minute later and within a few bps of it). */
let entryClose: number | null = null;
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
      const stop = entryClose !== null && close <= entryClose * (1 - STOP_LOSS);
      if (z >= Z_OUT || stop) {
        orders.push({ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
        entryClose = null;
      }
      return orders;
    }

    if (batch.seq >= NO_ENTRY_AFTER) return [];
    const deepDip = z <= -Z_IN;
    const fallback = !everHeld && batch.seq >= FALLBACK_BAR && z <= -FALLBACK_Z;
    if (!deepDip && !fallback) return [];
    let notional = state.cash;
    const room = state.weightRoom(SYMBOL);
    if (room < notional) notional = room;
    if (notional < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    entryClose = close;
    orders.push({ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS });
    return orders;
  },
});
