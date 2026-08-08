/**
 * EMA Crossover Engine — Template / Reference Implementation
 *
 * Strategy:
 *   BUY  — EMA_FAST crosses above EMA_SLOW AND RSI < RSI_OVERBOUGHT AND positions < MAX_POSITIONS
 *   SELL — RSI ≥ RSI_OVERBOUGHT while holding (goes through the agent pipeline)
 *   SELL — RSI ≥ RSI_EMERGENCY_EXIT (bypassLlm: true — immediate execution, no LLM delay)
 *
 * What this file demonstrates:
 *   ✓ manifest export          — indicator + param declarations for the deployment UI + agent prompts
 *   ✓ ctx.params               — runtime-configurable thresholds, read safely per instance
 *   ✓ ctx.exchange.category    — spot vs futures detection ("spot" | "linear")
 *   ✓ ctx.exchange.leverage    — configured leverage (futures only)
 *   ✓ ctx.getCandles()         — fetching historical OHLCV
 *   ✓ ctx.computeIndicators()  — EMA, RSI, MACD, Bollinger Bands from the platform
 *   ✓ ctx.getOpenPositions()   — position-gating; positionSide distinguishes longs from shorts
 *   ✓ ctx.getExchangeData()    — capabilities, constraints, fees, derivatives data, and contract terms
 *   ✓ ctx.exchangeWs           — live bid/ask from the shared orderbook WebSocket
 *   ✓ ctx.logger               — structured pino-style logging
 *   ✓ signal.flags.bypassLlm  — mechanical exit that skips the agent pipeline entirely
 *   ✓ Futures intents           — open_long / close_long / open_short / close_short
 *   ✓ Manual Signal construction — explicit and transparent (recommended over ctx.buildSignal)
 *
 * New in SDK v2:
 *   • ctx.exchange.category / leverage — adapt strategy to spot or futures
 *   • getOpenPositions() returns positionSide + averageFillPrice
 *   • Signal.indicators can include ATR-based stop/target hints for agent SL/TP
 *   • Agents honour stopLossPrice / takeProfitPrice / limitPrice / orderSizeUsd output fields
 *
 * Build:
 *   npm run build        — produces engine.js + manifest.json (tsup)
 *   npm run build:esbuild — same output using esbuild directly
 *
 * Replace the algorithm below with your own strategy.
 * Keep the manifest in sync with whatever keys you put in Signal.indicators.
 */

import { EventEmitter } from "events";
import { randomUUID }   from "crypto";
import type {
  IQuantEngine,
  EngineContext,
  EngineManifest,
  IndicatorConfig,
  Signal,
  Candle,
  Orderbook,
  OrderbookUpdate,
} from "@agentic-trading/shared";

// ─── Manifest ─────────────────────────────────────────────────────────────────
//
// The manifest declares what this engine exposes:
//   indicators — injected into every agent system prompt so the LLM understands the values
//   params     — collected from the deployer UI; arrive at runtime via ctx.params
//
// Rules:
//   • manifest.indicators keys MUST exactly match the keys in Signal.indicators below.
//   • manifest.params keys become env var names (e.g. EMA_FAST → process.env.EMA_FAST).
//   • "secret" params are encrypted at rest and never exposed in logs or receipts.
//   • gen-manifest.mjs extracts this export after build and writes manifest.json.

export const manifest: EngineManifest = {
  name:    "EMA Crossover Engine",
  version: "1.0.0",
  description:
    "Classic EMA fast/slow crossover filtered by RSI. " +
    "Buys when the fast EMA crosses above the slow EMA in a non-overbought market. " +
    "Exits when RSI becomes overbought or hits an emergency threshold.",

  indicators: {
    ema9:                { type: "number", description: "9-period EMA (fast line)." },
    ema21:               { type: "number", description: "21-period EMA (slow line)." },
    rsi14:               { type: "number", description: "RSI-14 (0–100). >70 = overbought, <30 = oversold." },
    macdHistogram:       { type: "number", description: "MACD histogram. Positive = bullish momentum." },
    crossoverStrength:   { type: "number", description: "% gap between fast and slow EMA. Positive = bullish spread." },
    bestBid:             { type: "number", description: "Best bid price at signal time." },
    bestAsk:             { type: "number", description: "Best ask price at signal time." },
    spreadPct:           { type: "number", description: "Bid-ask spread as % of mid-price." },
    suggestedEntryPrice: { type: "number", description: "Recommended limit-order price. BUY: bestBid (passive) or bestAsk (aggressive). SELL: bestBid." },
    openPositionCount:   { type: "number", description: "Open positions at signal time. Used by agents to calibrate position sizing." },
    exchangeContextAvailable: { type: "number", description: "1 when current exchange execution metadata was available; otherwise 0." },
    mutableProtection:   { type: "number", description: "1 when the exchange can update protection on an existing position." },
  },

  params: {
    EMA_FAST: {
      label:       "Fast EMA Period",
      description: "Period for the fast EMA. The platform always computes EMA-9 and EMA-21 — set this to 9 or 21 to use the platform's value, or implement your own EMA calculation for other periods.",
      type:        "number",
      required:    false,
      default:     9,
    },
    EMA_SLOW: {
      label:       "Slow EMA Period",
      description: "Period for the slow EMA (see note on EMA_FAST).",
      type:        "number",
      required:    false,
      default:     21,
    },
    RSI_OVERBOUGHT: {
      label:       "RSI Overbought Threshold",
      description: "RSI above this value triggers a sell signal via the agent pipeline.",
      type:        "number",
      required:    false,
      default:     70,
    },
    RSI_EMERGENCY_EXIT: {
      label:       "RSI Emergency Exit",
      description: "RSI above this value triggers an immediate sell that bypasses the LLM pipeline entirely (bypassLlm).",
      type:        "number",
      required:    false,
      default:     80,
    },
    MAX_POSITIONS: {
      label:       "Max Concurrent Positions",
      description: "New BUY signals are suppressed when open positions reach this count.",
      type:        "number",
      required:    false,
      default:     3,
    },
    FILL_MODE: {
      label:       "Fill Mode",
      description: "'passive' = buy at bestBid (at-market, waits for a seller); 'aggressive' = buy at bestAsk (immediate fill, pays the spread).",
      type:        "select",
      options:     ["passive", "aggressive"],
      required:    false,
      default:     "passive",
    },
    MAX_SPREAD_PCT: {
      label:       "Max Spread % (auto-aggressive)",
      description: "If bid-ask spread exceeds this percentage of mid-price, automatically switch to aggressive pricing so the order fills rather than sitting stale.",
      type:        "number",
      required:    false,
      default:     0.5,
    },
  },
};

// ─── Engine factory ───────────────────────────────────────────────────────────
//
// createEngine is the ONLY export the platform calls.
// It receives a fully-wired EngineContext and returns an IQuantEngine.
// The engine emits "signal" events; the platform picks them up and routes them
// through the agent pipeline (or skips it when signal.flags.bypassLlm is true).

export default function createEngine(ctx: EngineContext): IQuantEngine {
  const emitter  = new EventEmitter();
  const log      = ctx.logger.child({ engineId: "ema-crossover" });
  const market   = ctx.config.bot.market;
  const interval = ctx.config.bot.candleInterval;

  // Mutable state
  let timerId:       ReturnType<typeof setInterval> | null = null;
  let orderbook:     Orderbook | null = null;
  let lastCandleTime = 0;
  // Tracks whether EMA fast was above EMA slow in the previous closed candle
  let prevEmaAbove:  boolean | null   = null;

  // ── Param helpers ────────────────────────────────────────────────────────────
  // ctx.params contains per-instance values (set in the deployment UI or PATCH /instances/:id).
  // Always fall back to process.env, then to a hard-coded default.
  function p(key: string, fallback: string): string {
    return ctx.params[key] ?? process.env[key] ?? fallback;
  }
  function pNum(key: string, fallback: number): number {
    return Number(p(key, String(fallback)));
  }

  // ── Orderbook helpers ────────────────────────────────────────────────────────
  function getBestBid(): number | null {
    if (!orderbook?.bids.length) return null;
    return Math.max(...orderbook.bids.map((b) => b.price));
  }

  function getBestAsk(): number | null {
    if (!orderbook?.asks.length) return null;
    return Math.min(...orderbook.asks.map((a) => a.price));
  }

  // Compute the suggested limit-order price for an entry.
  // BUY:  passive = bestBid (sits in the bid queue); aggressive = bestAsk (fills immediately)
  // SELL: always bestBid — exit quickly against existing bids
  function suggestEntryPrice(action: "buy" | "sell" | "open_long" | "close_long", fallback: number): number {
    const bid = getBestBid();
    const ask = getBestAsk();
    if (bid === null || ask === null) return fallback;

    const mid       = (bid + ask) / 2;
    const spreadPct = mid > 0 ? ((ask - bid) / mid) * 100 : 0;
    const fillMode  = p("FILL_MODE", "passive");
    const maxSpread = pNum("MAX_SPREAD_PCT", 0.5);

    // Auto-switch to aggressive when spread is too wide to sit passively
    const aggressive = spreadPct > maxSpread || fillMode === "aggressive";

    return action === "buy" || action === "open_long"
      ? (aggressive ? ask : bid)  // buy passive = at bid, aggressive = at ask
      : bid;                      // sell = always at bid for quick execution
  }

  // ── Signal loop ──────────────────────────────────────────────────────────────
  async function tick(): Promise<void> {
    try {
      const rsiOverbought = pNum("RSI_OVERBOUGHT",    70);
      const rsiEmergency  = pNum("RSI_EMERGENCY_EXIT", 80);
      const maxPositions  = Math.max(1, pNum("MAX_POSITIONS", 3));

      // Fetch enough candles for the slow EMA warmup window + 1 in-progress (excluded) candle
      const emaSlow = Math.max(3, pNum("EMA_SLOW", 21));
      const needed  = emaSlow * 3;
      const candles = await ctx.getCandles(market, interval, Math.max(needed, 60));
      if (candles.length < needed) return;

      // Exclude the in-progress (last, forming) candle — only trade on closed candles
      const closed  = candles.slice(0, -1) as Candle[];
      const current = closed[closed.length - 1]!;

      // Deduplicate: fire once per new closed candle, not on every poll interval
      if (current.time <= lastCandleTime) return;
      lastCandleTime = current.time;

      const exchangeData = await ctx.getExchangeData().catch((error) => {
        log.warn({ event: "exchange_context_unavailable", err: String(error) }, "Continuing without exchange execution context");
        return null;
      });

      // ── Standard indicator computation ──────────────────────────────────────
      // computeIndicators always returns ema9 and ema21 (the platform's fixed periods).
      // For custom EMA periods set via params, you would compute them manually here
      // from the raw candle close prices (e.g. using the 'technicalindicators' package).
      const indCfg = ctx.config.indicators as unknown as IndicatorConfig;
      const ind    = ctx.computeIndicators(closed, orderbook, indCfg);

      const rsi  = ind.rsi14;
      const macdH = ind.macdHistogram;

      // ── Live orderbook snapshot ──────────────────────────────────────────────
      const bid       = getBestBid();
      const ask       = getBestAsk();
      const mid       = bid !== null && ask !== null ? (bid + ask) / 2 : current.close;
      const spreadPct = bid !== null && ask !== null && mid > 0
        ? ((ask - bid) / mid) * 100
        : 0;

      // ── EMA crossover detection ──────────────────────────────────────────────
      // The platform computes ema9 and ema21. For other periods, compute manually.
      const ema9  = ind.ema9;
      const ema21 = ind.ema21;

      const emaAbove  = ema9 !== null && ema21 !== null && ema9 > ema21;
      const crossedUp = emaAbove && prevEmaAbove === false;   // fast just crossed above slow
      prevEmaAbove    = emaAbove;

      // Percentage gap between fast and slow EMA — positive = bullish spread
      const crossoverStrength = ema9 !== null && ema21 !== null && ema21 > 0
        ? ((ema9 - ema21) / ema21) * 100
        : 0;

      // ── Open position check ──────────────────────────────────────────────────
      const positions    = ctx.getOpenPositions();
      const openLongs    = positions.filter((position) => position.positionSide !== "short");
      const openCount    = openLongs.length;
      const hasPositions = openCount > 0;
      const isLinear     = ctx.exchange.category === "linear";

      // ── Determine action ─────────────────────────────────────────────────────
      let action:    "buy" | "sell" | "open_long" | "close_long" = isLinear ? "open_long" : "buy";
      let strength   = 0;
      let bypassLlm  = false;
      let summary    = "";

      if (rsi !== null && rsi >= rsiEmergency && hasPositions) {
        // RSI hit the extreme threshold — hard exit, no LLM, no agent delay
        action    = isLinear ? "close_long" : "sell";
        strength  = 1.0;
        bypassLlm = true;
        summary   = `Emergency sell: RSI ${rsi.toFixed(1)} ≥ ${rsiEmergency}. Immediate exit (bypassLlm).`;

      } else if (rsi !== null && rsi >= rsiOverbought && hasPositions) {
        // RSI overbought while holding — profit-exit suggestion, let agents confirm
        action   = isLinear ? "close_long" : "sell";
        strength = Math.min((rsi - rsiOverbought) / 10, 1);
        summary  = `RSI overbought at ${rsi.toFixed(1)} — recommend exit via agent pipeline.`;

      } else if (crossedUp && openCount < maxPositions && (rsi === null || rsi < rsiOverbought)) {
        // Fast EMA just crossed above slow EMA — buy entry signal
        action   = isLinear ? "open_long" : "buy";
        strength = Math.min(Math.abs(crossoverStrength) / 2, 1);
        summary  = `EMA crossover: fast (${ema9?.toFixed(2)}) > slow (${ema21?.toFixed(2)}). RSI ${rsi?.toFixed(1) ?? "n/a"}.`;

      } else {
        // No actionable condition — skip; emit only meaningful signals
        return;
      }

      const entryPrice = suggestEntryPrice(action, current.close);

      // ── Build and emit the signal ────────────────────────────────────────────
      // Construct the Signal manually for full control over action, strength, and indicators.
      // Alternatively, use ctx.buildSignal() if you want the platform's built-in scoring —
      // but then override signal.action and signal.strength with your own values.
      const signal: Signal = {
        id:        randomUUID(),
        market,
        timestamp: Date.now(),
        action,
        strength,
        // Keys here MUST match manifest.indicators exactly.
        indicators: {
          ema9,
          ema21,
          rsi14:               rsi,
          macdHistogram:       macdH,
          crossoverStrength,
          bestBid:             bid,
          bestAsk:             ask,
          spreadPct,
          suggestedEntryPrice: entryPrice,
          openPositionCount:   openCount,
          exchangeContextAvailable: exchangeData ? 1 : 0,
          mutableProtection: exchangeData?.capabilities.mutableProtection ? 1 : 0,
        },
        marketSnapshot: {
          market,
          price:          current.close,
          bestBid:        bid,
          bestAsk:        ask,
          timestamp:      Date.now(),
          candleInterval: interval,
          category:       ctx.exchange.category,
          exchangeId:     ctx.exchange.id,
        },
        summary,
        flags: bypassLlm ? { bypassLlm: true } : undefined,
      };

      log.info(
        { event: "signal_emitted", action, strength: strength.toFixed(3), bypassLlm },
        signal.summary,
      );

      emitter.emit("signal", signal);

    } catch (err) {
      log.error({ event: "tick_error", err: String(err) }, "Engine tick failed");
    }
  }

  // ─── IQuantEngine interface ──────────────────────────────────────────────────

  return {
    async start(): Promise<void> {
      // Connect to the shared exchange WebSocket and subscribe to the instance's market.
      // The platform manages the underlying TCP connection — you only need to subscribe.
      ctx.exchangeWs.connect();
      ctx.exchangeWs.subscribe(market);

      // Snapshot: replace local orderbook on full refresh
      ctx.exchangeWs.on("orderbook_snapshot", (data: Orderbook) => {
        if (data.market === market) orderbook = data;
      });

      // Incremental update: apply add/update/remove mutations to the local snapshot
      ctx.exchangeWs.on("orderbook_update", (update: OrderbookUpdate) => {
        if (!orderbook || (update as { market?: string }).market !== market) return;
        const list = update.side === "buy" ? orderbook.bids : orderbook.asks;
        if (update.type === "remove") {
          const idx = list.findIndex((e) => e.id === update.id);
          if (idx >= 0) list.splice(idx, 1);
        } else {
          const idx   = list.findIndex((e) => e.id === update.id);
          const entry = { id: update.id, price: update.price, amount: update.remaining };
          if (idx >= 0) list[idx] = entry; else list.push(entry);
        }
      });

      // Optional: individual trade events (useful for volume/momentum analysis)
      // ctx.exchangeWs.on("trade", (trade: TradeEvent) => { ... });

      log.info({ event: "engine_started", market, interval }, "EMA Crossover Engine started");

      // Run immediately then on every configured interval
      const intervalMs = ctx.config.bot.signalIntervalSeconds * 1000;
      await tick();
      timerId = setInterval(() => void tick(), intervalMs);
    },

    stop(): void {
      if (timerId !== null) {
        clearInterval(timerId);
        timerId = null;
      }
      ctx.exchangeWs.unsubscribe(market);
      log.info({ event: "engine_stopped" }, "EMA Crossover Engine stopped");
    },

    on(event: "signal", listener: (signal: Signal) => void): IQuantEngine {
      emitter.on(event, listener);
      return this;
    },
  };
}
