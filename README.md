# Agentic Trader — Strategy Engine Template

Build a custom quant engine and deploy it to the [Agentic Trader](https://terminal.liquiddesk.co) platform.

This repo is the official starting point. It ships with a complete reference engine (EMA crossover with RSI filter), the full TypeScript contract, starter agent prompts, and a submission guide.

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

These `.md` files are copied into every new bot instance that uses your engine. They define how the LLM pipeline reasons about your signals before an order is placed.

The platform runs agents **sequentially**: each agent receives the previous agent's output as context. If any required (non-optional) agent fails or vetoes, the pipeline stops and the trade is skipped.

---

### Pipeline flow

```
Engine emits Signal
  └─► MarketAnalyst   (market_analysis)   ← confirms direction
        └─► [optional agents...]
              └─► ExecutionAgent (executor) ← computes prices, final gate
                    └─► Executor module places order (or skips)
```

The `executor` role is the final gate. It computes exact `limitPrice`, `stopLossPrice`, `takeProfitPrice`, and `orderSizePercent`. The platform looks for `role: executor` first, then falls back to `role: risk_management` for backwards compatibility.

---

### Frontmatter reference

```yaml
---
name: MarketAnalyst         # Display name in traces UI
role: market_analysis       # See Role reference below
active: true                # false = excluded from pipeline entirely
optional: false             # true = skip on LLM error instead of halting pipeline
model: null                 # null = platform default model; or "groq/llama-3.3-70b-versatile"
temperature: 0.3            # 0.0–2.0; lower = more deterministic
description: "What this agent does"   # shown in Agent Library UI
input: [signal, openPositions, riskLimits, previousAgentOutput]
output: [reasoning, recommendation, confidence, approved, limitPrice, stopLossPrice, takeProfitPrice]
---
```

---

### Role reference

| Role | Pipeline position | Responsibility |
|---|---|---|
| `market_analysis` | First (or early) | Confirm or veto the engine's direction. Understands your indicator set. |
| `executor` | **Last** — final gate | Compute exact prices + approve/block. Has access to `riskLimits` defaults. **Preferred over `risk_management`.** |
| `risk_management` | Last (legacy) | Same as `executor` — supported for backwards compatibility |
| `regime` | Any position | Detects market regime (bull/bear/sideways); hard veto before LLM pipeline if conditions are wrong |
| `sentiment` | Any position | External sentiment signal (news, funding rate, fear index) |
| Any string | Any position | Custom role — add any specialist agent; executor still looks for `executor` or `risk_management` last |

The executor module parses the `data` field of whichever agent has `role: executor` (preferred) or `role: risk_management` (fallback).

---

### `input:` keys — what data agents can request

Declare keys in frontmatter `input:` to receive additional context blocks. Agents that don't declare a key don't receive it (saves tokens).

| Key | Always included | What it provides |
|---|---|---|
| `signal` | ✅ always | Full signal: `action`, `strength`, `indicators` (all engine keys), `price`, `bestBid`, `bestAsk`, `summary` |
| `openPositions` | ✅ always | `[{ entryPrice, amount, unrealizedPnl, unrealizedPct }]` — positions open at signal time |
| `recentMemory` | ✅ always | Last N trade reflections from memory |
| `previousAgentOutput` | ✅ always | Previous agent's `recommendation`, `confidence`, `data` |
| `balance` | opt-in | `[{ symbol, available, total }]` — live wallet balance from exchange |
| `openOrders` | opt-in | Count + summary of open exchange orders |
| `riskLimits` | **opt-in — highly recommended for executor** | Config defaults + live state (see below) |
| `instanceConfig` | opt-in | `{ executionMode, market, exchange, candleInterval, agentMode }` |
| `engineContext` | opt-in | Engine manifest: `{ engineId, name, version, indicators, params }` |

#### `riskLimits` block (when declared)

```json
{
  "maxOpenOrders": 3,
  "maxOrderSizePercent": 5,
  "dailyLossLimitPercent": 5,
  "stopLossPct": 0.005,
  "takeProfitPct": 0.005,
  "currentDailyPnl": -4.20,
  "openOrderCount": 1,
  "defaultStopLossPrice": 97012.50,
  "defaultTakeProfitPrice": 97987.50
}
```

`defaultStopLossPrice` and `defaultTakeProfitPrice` are pre-computed at the current price using the configured SL%/TP%. Your executor agent can use these directly without doing any math.

---

### `output:` keys — what the executor agent produces

Declare the keys your agent outputs in frontmatter `output:`. The executor module parses these from the `data` field.

| `data` key | Type | Description |
|---|---|---|
| `approved` | `boolean` | **Required.** `false` = block trade entirely |
| `reason` | `string` | Human-readable explanation for the decision |
| `limitPrice` | `number` | Entry limit price. If omitted, platform uses `bestAsk`/`bestBid` |
| `stopLossPrice` | `number` | SL price. If omitted, platform uses `price × (1 − stopLossPct)` |
| `takeProfitPrice` | `number` | TP price. If omitted, platform uses `price × (1 + takeProfitPct)` |
| `orderSizePercent` | `number (0–100)` | Order size as % of available balance. Overrides config default. |
| `overrideAction` | `"buy" \| "sell" \| "hold"` | Override the engine's final direction. Use sparingly. |
| `trailingStopPct` | `number (0–1)` | Exchange-native trailing stop as fraction of entry (e.g. `0.015` = 1.5%). Bybit linear only. |
| `tradeLabel` | `string (max 64)` | Tag stored on the trade record — shows in Trades UI, useful for filtering |

---

### Optional agents

Set `optional: true` in frontmatter for agents that enhance but don't gate the pipeline:

```yaml
---
name: SentimentChecker
role: sentiment
active: true
optional: true        # if this agent fails or times out, pipeline continues
input: [signal, previousAgentOutput]
---
```

Optional agents that fail are logged with `stopReason: agent_skipped_optional` and the pipeline continues using the previous agent's output as context.

---

### `bypassLlm` — skip agents entirely

Set `signal.flags = { bypassLlm: true }` in your engine for mechanical actions that must not be delayed by LLM inference:

```typescript
// Hard stop-loss — execute immediately, bypass all agents
emitter.emit("signal", { ...signal, action: "sell", flags: { bypassLlm: true } });
```

---

### Pipeline stop reasons

Each trace records why the pipeline stopped — visible in the Traces UI:

| `stopReason` | Meaning |
|---|---|
| `completed` | All agents ran, trade executed (or held by decision) |
| `veto` | An agent returned a recommendation conflicting with the engine signal |
| `agent_error` | A required agent returned null (LLM failure) |
| `agent_skipped_optional` | An optional agent failed — pipeline continued |
| `no_execution_agent` | No `executor` or `risk_management` agent ran — config defaults used |
| `circuit_breaker` | Too many consecutive LLM failures — pipeline paused |
| `insufficient_credits` | Managed inference credits exhausted |
| `early_hold` | `market_analysis` agent held with ≥85% confidence — skipped remaining agents |
| `regime_veto` | Regime classifier blocked the trade before any LLM call |

---

### Writing effective agent prompts

1. **Reference your manifest indicator keys exactly.** They're injected as `signal.indicators.KEY`. The platform prepends a description preamble to every agent — don't duplicate it.
2. **Give strict, literal veto rules.** "VETO ONLY IF `rsi14 > 72`" is better than "veto if RSI is high". LLMs add extra conditions unless you're explicit.
3. **Always approve sell/exit signals.** Your engine already confirmed the exit condition — agents should not second-guess it.
4. **Use `input: [riskLimits]` in your executor.** It gives you `defaultStopLossPrice` / `defaultTakeProfitPrice` already computed — no math errors.
5. **Output plain numbers only.** Never write `"limitPrice": "price × 1.005"`. Always compute the value in the prompt rules and output the number.
6. **Keep `temperature` low (0.1–0.3) for the executor.** Deterministic price computation. Higher temperature (0.5–0.7) is fine for analyst roles.
7. **Keep system prompts under ~800 tokens.** Longer prompts cost more and don't improve accuracy for structured JSON tasks.

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
