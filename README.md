# LiquidDesk — Quantbot Strategy Template

Build a custom quant engine and deploy it to the [Liquid Desk](https://liquiddesk.co) platform for any market.

This repo is the official starting point. It ships with a complete reference engine (EMA crossover with RSI filter), the full TypeScript contract, starter agent prompts, and a submission guide.

## How to deploy
[![Watch the video](https://res.cloudinary.com/estaterally/image/upload/v1785596305/trading_agent_video_cover_etwraw.png)](https://www.youtube.com/watch?v=FaKjFMaf1pI)

---

## Quick start

```bash
git clone https://github.com/YOUR_ORG/quant-bot-strategy-engine-template my-engine
cd my-engine
npm install
# Edit src/engine.ts — swap in your strategy logic
npm run build       # → engine.js + manifest.json
npm run check       # type-check only (no build output)
```

See [SUBMITTING.md](./SUBMITTING.md) when you are ready to publish.

---

## Repository structure

```
my-engine/
├── src/
│   └── engine.ts              ← Your strategy (the only file you must change)
├── AGENTS-template/
│   ├── market-analyst.md      ← Agent prompt tuned to this engine's indicators
│   └── risk-manager.md        ← Agent prompt for position sizing + SL/TP
├── types/
│   └── engine-sdk.d.ts        ← Vendored platform types — do not edit
├── scripts/
│   └── gen-manifest.mjs       ← Extracts manifest export → manifest.json
├── tsup.config.ts
├── tsconfig.json
├── package.json
└── SUBMITTING.md
```

**Files you edit:** `src/engine.ts`, `AGENTS-template/*.md`  
**Files you leave alone:** everything else

---

## The engine contract

Every engine module must export exactly two things:

```typescript
// 1. Factory function — required
export default function createEngine(ctx: EngineContext): IQuantEngine { ... }

// 2. Manifest — required; extracted to manifest.json on build
export const manifest: EngineManifest = { ... }
```

### `IQuantEngine`

```typescript
interface IQuantEngine {
  start(): Promise<void>;   // platform calls this once at instance startup
  stop(): void;             // platform calls this on pause/stop
  on(event: "signal", listener: (signal: Signal) => void): this;
}
```

Emit `Signal` objects with `emitter.emit("signal", signal)`. Each signal is routed through the agent pipeline unless `signal.flags.bypassLlm` is `true`.

---

## EngineContext API

### Configuration

```typescript
ctx.config.bot.market           // "BTCUSDT" — the market this instance trades
ctx.config.bot.candleInterval   // "1h" — candle interval for signal computation
ctx.config.bot.signalIntervalSeconds  // how often your tick() loop fires
ctx.config.indicators           // cast as IndicatorConfig for computeIndicators()
ctx.exchange.id                 // "bybit" | "100x" | "binance"
```

### `ctx.params` — runtime parameters

Per-instance resolved configuration. Cascade: `instance params → instance secrets → global secrets → process.env`.

```typescript
// Always use this pattern — safe for multi-instance deployments
const threshold = Number(ctx.params.RSI_THRESHOLD ?? process.env.RSI_THRESHOLD ?? "70");
```

### `ctx.getCandles(market, interval, limit)`

Historical OHLCV. Always fetch more than you need for indicator warmup, and drop the last (in-progress) candle.

```typescript
const candles = await ctx.getCandles(market, interval, 100);
const closed  = candles.slice(0, -1);  // exclude forming candle
const current = closed[closed.length - 1]!;

// Fire once per new closed candle
if (current.time <= lastCandleTime) return;
lastCandleTime = current.time;
```

### `ctx.getOpenPositions()`

Returns filled buys with no matched exit sell — scoped to this engine + market.

```typescript
const positions = ctx.getOpenPositions();
if (positions.length >= maxPositions) return;  // position gate
```

### `ctx.computeIndicators(candles, orderbook, config)`

Built-in technical analysis. Returns: `ema9`, `ema21`, `ema50`, `rsi14`, `macdLine`, `macdSignal`, `macdHistogram`, `bbUpper/Middle/Lower`, `volumeSma20`, `currentVolume`, `bidAskSpread`, `bidAskImbalance`.

```typescript
const ind = ctx.computeIndicators(closed, orderbook, ctx.config.indicators as unknown as IndicatorConfig);
// ind.ema9, ind.rsi14, ind.macdHistogram, etc. — all nullable
```

### `ctx.exchangeWs` — shared WebSocket

**Do not open your own WebSocket.** Subscribe to the platform's shared connection.

```typescript
ctx.exchangeWs.connect();
ctx.exchangeWs.subscribe(market);

ctx.exchangeWs.on("orderbook_snapshot", (data: Orderbook) => { orderbook = data; });
ctx.exchangeWs.on("orderbook_update",   (u: OrderbookUpdate) => { /* apply delta */ });
ctx.exchangeWs.on("trade",              (t: TradeEvent) => { /* price feed */ });
```

### `ctx.logger`

Structured pino logger. Always include an `event` key.

```typescript
ctx.logger.info({ event: "signal_emitted", action: "buy", strength: 0.8 }, "EMA crossover");
ctx.logger.warn({ event: "warmup_incomplete", count: candles.length }, "Not enough candles yet");
```

---

## Signals

```typescript
const signal: Signal = {
  id:        randomUUID(),     // import { randomUUID } from "crypto"
  market,
  timestamp: Date.now(),
  action:    "buy",            // "buy" | "sell" | "hold" | "open_long" | ...
  strength:  0.75,             // 0.0–1.0
  indicators: {
    // Keys here MUST match manifest.indicators exactly
    ema9:  97500,
    rsi14: 58.3,
  },
  marketSnapshot: {
    market, price: current.close,
    bestBid: bid, bestAsk: ask,
    timestamp: Date.now(), candleInterval: interval,
  },
  summary:   "EMA crossover — fast above slow, RSI 58.3.",
};
emitter.emit("signal", signal);
```

### `bypassLlm` — skip the agent pipeline

Set `signal.flags = { bypassLlm: true }` for mechanical exits that must not be delayed by LLM calls.

```typescript
// Hard stop-loss — execute immediately, no agent reasoning
if (rsi > 85 && positions.length > 0) {
  emitter.emit("signal", { ..., action: "sell", flags: { bypassLlm: true } });
}
```

---

## Manifest

Declares what this engine exposes to the deployment UI and agent prompts.

```typescript
export const manifest: EngineManifest = {
  name: "My Engine", version: "1.0.0",

  // Keys must EXACTLY match Signal.indicators keys — injected into every agent prompt
  indicators: {
    rsi14: { type: "number", description: "RSI-14. >70 = overbought." },
    macdHistogram: { type: "number", description: "MACD histogram. Positive = bullish." },
  },

  // Collected at deploy time → injected as ctx.params + process.env at runtime
  params: {
    RSI_THRESHOLD: {
      label: "RSI Overbought Threshold", type: "number",
      required: false, default: 70,
    },
    API_KEY: {
      label: "Third-party API Key", type: "secret",  // encrypted at rest
      required: true,
    },
  },
};
```

| Param type | UI control | Notes |
|------------|-----------|-------|
| `"string"`  | Text input | Plain text |
| `"secret"`  | Password input | Masked + encrypted; no `default` allowed |
| `"number"`  | Number input | Arrives as string — use `Number()` |
| `"boolean"` | Text input | `"true"` / `"false"` |
| `"select"`  | Dropdown | Requires `options: string[]` |

---

## Agent prompts (`AGENTS-template/`)

These `.md` files are copied into every new bot instance that uses your engine. They define how the LLM pipeline reasons about your signals.

Frontmatter format:

```yaml
---
name: MarketAnalyst
role: market_analysis   # market_analysis | risk_management | trade_execution | custom
active: true
model: null             # null = platform default
temperature: 0.3
input: [signal, openPositions, recentMemory, previousAgentOutput]
output: [reasoning, recommendation, confidence]
---
```

The markdown body is the LLM system prompt. Write explicit decision rules referencing your `manifest.indicators` keys. Agents must return valid JSON matching the `output` fields.

The platform automatically prepends your `manifest.indicators` descriptions to every agent prompt — reference those keys by name in your rules.

---

## Build

```bash
npm run build          # tsup (default) + gen-manifest
npm run build:esbuild  # esbuild alternative
npm run check          # tsc --noEmit
npm run dev            # watch mode
```

Output:

| File | What it is |
|------|-----------|
| `engine.js` | Single-file ESM bundle — upload this |
| `manifest.json` | Auto-generated from the `manifest` export — include with submission |

---

## Testing locally

Mock `EngineContext` to unit-test signal logic in isolation:

```typescript
import createEngine from "../src/engine.js";
import type { EngineContext } from "@agentic-trading/shared";

const signals: Signal[] = [];
const engine = createEngine(mockCtx);  // see README for full mock shape
engine.on("signal", (s) => signals.push(s));
await engine.start();
engine.stop();
assert(signals.length > 0);
```

For integration testing, deploy to the platform in `executionMode: "signal"` (signals recorded, no orders placed) and inspect traces in the dashboard.

---

## License

MIT — see [LICENSE](./LICENSE).
