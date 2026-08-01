/**
 * engine-sdk.d.ts — Agentic Trader engine author types (vendored)
 *
 * All types you need to build a custom quant engine. Zero runtime dependencies.
 *
 * Import as:  import type { EngineContext, Signal, ... } from "@agentic-trading/shared"
 * (tsconfig.json paths aliases that module name to this file)
 *
 * Keep in sync with the platform by running:  npm run sync-types
 */

declare module "@agentic-trading/shared" {

  // ─── Market data ────────────────────────────────────────────────────────────

  export interface Candle {
    time:   number;   // Unix ms
    open:   number;
    high:   number;
    low:    number;
    close:  number;
    volume: number;
  }

  export interface OrderbookEntry {
    id:     string;
    price:  number;
    amount: number;
  }

  export interface Orderbook {
    market: string;
    bids:   OrderbookEntry[];
    asks:   OrderbookEntry[];
  }

  export interface Ticker {
    market:                string;
    lastPrice:             number;
    priceChangePercent24h: number;
    volume24h:             number;
    high24h:               number;
    low24h:                number;
  }

  // ─── Indicators ─────────────────────────────────────────────────────────────

  /** Standard indicators returned by ctx.computeIndicators(). */
  export interface Indicators {
    ema9:            number | null;
    ema21:           number | null;
    ema50:           number | null;
    rsi14:           number | null;
    macdLine:        number | null;
    macdSignal:      number | null;
    macdHistogram:   number | null;
    bbUpper:         number | null;
    bbMiddle:        number | null;
    bbLower:         number | null;
    volumeSma20:     number | null;
    currentVolume:   number | null;
    bidAskSpread:    number | null;
    /** (bidVol − askVol) / (bidVol + askVol), range −1 to 1. */
    bidAskImbalance: number | null;
    /** Engine-specific extra indicators — any additional numeric key is valid. */
    [key: string]: number | null | undefined;
  }

  // ─── Signal ─────────────────────────────────────────────────────────────────

  /**
   * Direction the engine recommends.
   * Spot engines use buy / sell / hold.
   * Futures-aware engines may use the explicit 4-way intents below.
   */
  export type SignalAction =
    | "buy" | "sell" | "hold"
    | "open_long" | "close_long" | "open_short" | "close_short";

  export interface MarketSnapshot {
    market:         string;
    price:          number;
    bestBid?:       number | null;
    bestAsk?:       number | null;
    timestamp:      number;         // Unix ms
    candleInterval: string;
    category?:      "spot" | "linear";
    exchangeId?:    string;
    marketAlias?:   string;
  }

  export interface Signal {
    id:             string;          // UUID
    market:         string;
    timestamp:      number;          // Unix ms
    action:         SignalAction;
    /** Confidence 0–1. Higher = more certain. */
    strength:       number;
    /** Free-form map — keys must match what manifest.indicators declares. */
    indicators:     Record<string, number | null>;
    marketSnapshot: MarketSnapshot;
    /** Plain-English narrative — injected into agent prompts. */
    summary:        string;
    /**
     * Execution flags.
     * bypassLlm: true → executor skips the LLM agent pipeline and acts immediately.
     * Use for mechanical exits (stop-loss, profit-lock) that must not be delayed.
     */
    flags?: { bypassLlm?: boolean };
  }

  export interface IndicatorConfig {
    ema: number[];
    rsi: { period: number };
    macd: { fast: number; slow: number; signal: number };
    bollingerBands: { period: number; stdDev: number };
    volumeSma: { period: number };
  }

  export interface TradeEvent {
    id: string;
    market: string;
    price: number;
    amount: number;
    timestamp: number;
  }

  export interface OrderbookUpdate {
    type: "add" | "update" | "remove";
    id: string;
    side: "buy" | "sell";
    price: number;
    amount: number;
    remaining: number;
    filled: number;
    timestamp: number;
  }

  export interface OpenPosition {
    id: string;
    price: number;
    amount: number;
    openedAt?: number;
    unrealizedPnl?: number | null;
  }

  export interface ExchangeWsContext {
    connect(): void;
    subscribe(market: string): void;
    unsubscribe(market: string): void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    on(event: string, listener: (...args: any[]) => void): void;
  }

  export interface EngineConfig {
    bot: {
      market: string;
      candleInterval: string;
      signalIntervalSeconds: number;
      signalPriceChangeThreshold: number;
    };
    risk: {
      positionProfitExitPct?: number;
      [key: string]: unknown;
    };
    indicators: Record<string, unknown>;
  }

  export interface EngineLogger {
    debug(bindings: Record<string, unknown>, msg?: string): void;
    info(bindings: Record<string, unknown>, msg?: string): void;
    warn(bindings: Record<string, unknown>, msg?: string): void;
    error(bindings: Record<string, unknown>, msg?: string): void;
    child(bindings: Record<string, unknown>): EngineLogger;
  }

  export interface EngineContext {
    config: EngineConfig;
    logger: EngineLogger;
    /**
     * Active exchange identity — set by the platform at startup.
     * Allows engines to adapt behaviour per exchange (e.g. market pair format,
     * order size precision, fee model).
     */
    exchange: {
      /** Exchange identifier. e.g. "100x" | "binance" | "bybit" */
      id:   string;
      /** Human-readable exchange name. e.g. "100x Exchange" | "Binance" */
      name: string;
    };
    /**
     * Per-instance resolved params (SI4). Preferred over process.env for multi-instance safety.
     * Built from cascade: InstanceConfig.params → secrets.instances[id] → secrets.global → process.env
     * Usage: ctx.params.SIGNAL_THRESHOLD ?? process.env.SIGNAL_THRESHOLD ?? "2.0"
     * process.env remains a valid fallback for backward compatibility.
     */
    params: Record<string, string>;
    /** Fetch historical OHLCV candles from the exchange REST API. */
    getCandles(market: string, interval: string, limit: number): Promise<Candle[]>;
    /** Returns currently open long positions (filled buys with no exit sell yet). */
    getOpenPositions(): OpenPosition[];
    /** Shared exchange WebSocket — engines subscribe to events here. */
    exchangeWs: ExchangeWsContext;
    /**
     * Compute technical indicators from candles + orderbook.
     * Pass ctx.config.indicators as IndicatorConfig (cast if needed).
     * Returns ema9, ema21, ema50, rsi14, macdLine, macdSignal, macdHistogram,
     * bbUpper, bbMiddle, bbLower, volumeSma20, currentVolume, bidAskSpread, bidAskImbalance.
     */
    computeIndicators(candles: Candle[], orderbook: Orderbook | null, config: IndicatorConfig): Indicators;
    /**
     * Build a fully-formed Signal from candles + pre-computed indicators.
     * Derives action/strength from multi-factor scoring, attaches market snapshot.
     */
    buildSignal(market: string, candleInterval: string, candles: Candle[], indicators: Indicators, orderbook?: Orderbook | null): Signal;
  }

  export interface ParamDefinition {
    /** Human-readable label shown in deployment UI. */
    label: string;
    /** Help text — may include a URL to obtain the value. */
    description?: string;
    /**
     * Value type.
     * "secret" → masked input, isSecret: true in Superrails, "[secret]" in receipt.
     * "select" → dropdown; requires options[].
     */
    type: "string" | "secret" | "number" | "boolean" | "select";
    /** Default: true. Optional params may be skipped. */
    required?: boolean;
    /** Pre-filled default value. NOT allowed on type: "secret". */
    default?: string | number | boolean;
    /** Allowed values — only for type: "select". */
    options?: string[];
    /** Input placeholder hint (e.g. "sk-..."). */
    placeholder?: string;
  }

  export interface EngineManifest {
    name: string;
    version: string;
    description?: string;
    /**
     * Map of indicator key → description.
     * Keys must match exactly what the engine puts in Signal.indicators.
     * Injected into every agent system prompt as a preamble.
     */
    indicators: Record<string, { type: string; description: string }>;
    /**
     * Map of env var name → param definition.
     * Collected from the user at deployment time; injected as Superrails env vars.
     * Engine reads values from process.env at runtime.
     *
     * @example
     * {
     *   "COINMARKETCAP_API_KEY": {
     *     "label": "CoinMarketCap API Key",
     *     "type": "secret",
     *     "required": true,
     *     "description": "Get one at coinmarketcap.com/api"
     *   }
     * }
     */
    params?: Record<string, ParamDefinition>;
    /** Optional URL to a AGENTS ZIP file pre-written for this engine's indicator set. */
    suggestedAgents?: string;
  }

  export interface IQuantEngine {
    start(): Promise<void>;
    stop(): void;
    on(event: "signal", listener: (signal: Signal) => void): this;
  }

  export type CreateEngine = (ctx: EngineContext) => IQuantEngine;
}