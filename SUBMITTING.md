# Submitting to the Rocketx Marketplace

This guide walks you from a working `engine.js` to a published strategy on the Rocketx marketplace.

---

## Prerequisites

- A Rocketx developer account — [rocketx.market](https://rocketx.market) → Sign Up → Developer
- A GitHub repository containing your engine (can be private)
- A passing build: `npm run build` produces `engine.js` + `manifest.json`
- A passing type-check: `npm run check` exits 0

---

## Step 1 — Build and commit

```bash
# Ensure you are on the version branch/tag you want to submit
npm run build
npm run check         # must exit 0 before submitting

git add engine.js manifest.json
git commit -m "chore: build v1.0.0"
git push
```

> The marketplace pins the artifact to the **exact commit SHA** at submission time.
> Future commits to the same branch do NOT affect already-submitted versions.

---

## Step 2 — Create a strategy (first time only)

1. Go to [rocketx.market](https://rocketx.market) → **Developer** → **My Strategies**
2. Click **New Strategy**
3. Fill in:
   - **Name** — e.g. "EMA Crossover Engine"
   - **Description** — what it does, intended markets, rough R:R
   - **Tags** — e.g. `trend-following`, `spot`, `bybit`
   - **Pricing model** — Free / One-time / Monthly / Annually
4. **Connect GitHub repo** — authorise the Rocketx GitHub App and select your repository
5. **Save**

---

## Step 3 — Submit a version

1. Open your strategy → click **Submit Version**
2. Fill in:

   | Field | Value |
   |-------|-------|
   | **Version** | Semver — e.g. `1.0.0`. Must be higher than any previous version. |
   | **Changelog** | What changed, what's new, any breaking param renames. |
   | **Engine file** | File picker — select `engine.js` from the connected repo. The platform fetches at the current HEAD commit SHA. |
   | **Manifest** | Click **Fetch from GitHub** — auto-reads `manifest.json` from the repo root at the same commit. Or paste the JSON manually. |

3. Click **Submit for review**

---

## Step 4 — Admin review

A Rocketx admin reviews:

- Engine bundle is valid ESM exporting `createEngine` + `manifest`
- No malicious code or network calls to unexpected hosts
- Manifest indicators match what the engine actually puts in `Signal.indicators`
- Params declared correctly (secrets masked, types valid)

Typical review time: **24–48 hours**. You will receive an email when approved or rejected with feedback.

---

## Step 5 — Acquire your own strategy (optional, for testing)

Once approved, you can acquire your own strategy for free regardless of pricing model:

1. **Marketplace** → find your strategy → **Acquire** (free for own strategies)
2. Your catalog now has this engine available in the deployment CLI and dashboard

---

## Step 6 — Deploy and test

```bash
# In the example-strategy-agent-creator/scripts directory
node deploy-bot.mjs
```

The CLI will:
1. List your catalog — select the new strategy
2. Ask for the target market and any `manifest.params` values
3. Deploy a bot container with your engine
4. Print API + dashboard URLs

Test in **paper mode** (`executionMode: "paper"` in deploy-bot.config.json or set in the instance dashboard). Paper mode runs the full signal → agent → execution pipeline but simulates fills without placing real orders.

---

## Updating an existing version

You **cannot** modify a submitted version's engine file or manifest — the artifact is pinned to a commit forever.

To update:
1. Make your changes in `src/engine.ts`
2. `npm run build && npm run check`
3. Bump `manifest.version` (e.g. `1.0.0` → `1.1.0`)
4. Commit + push
5. Submit a new version via the marketplace portal (Step 3 above)

Users who acquired a previous version continue running it. They see a "Update available" nudge in their dashboard and can choose when to update.

---

## Checklist before submitting

- [ ] `npm run build` exits 0 and produces `engine.js` + `manifest.json`
- [ ] `npm run check` exits 0 (no TypeScript errors)
- [ ] `manifest.version` is bumped from the previous submission
- [ ] `manifest.indicators` keys exactly match what the engine puts in `Signal.indicators`
- [ ] All `manifest.params` keys are readable via `ctx.params.KEY ?? process.env.KEY`
- [ ] The engine does not open its own WebSocket (uses `ctx.exchangeWs` only)
- [ ] `tick()` is wrapped in `try/catch` — errors are logged, not thrown
- [ ] `engine.stop()` clears all timers and calls `ctx.exchangeWs.unsubscribe(market)`
- [ ] `AGENTS-template/` has at least `market-analyst.md` and `risk-manager.md` tuned to your indicator set
- [ ] Changelog describes breaking changes (e.g. renamed params, removed indicators)

---

## FAQ

**Can my engine make external HTTP requests?**  
Yes. Use `fetch` (built into Node 18+). Be aware that requests to external APIs count against your LLM or data service quotas. Use `manifest.params` with `type: "secret"` for any API keys.

**Can I use npm packages?**  
Yes. `npm run build` bundles everything via esbuild/tsup into a single `engine.js`. The `events` and `crypto` modules are excluded (Node built-ins). All other dependencies are inlined.

**Can I have multiple engines in one repo?**  
Yes. Add additional entry points in `package.json` scripts (e.g. `build:myother`) and `tsup.config.ts` entries. Each produces its own `engine.js` equivalent. Submit each as a separate strategy version.

**My engine uses EMA periods other than 9/21/50 — how do I compute them?**  
`ctx.computeIndicators()` always returns `ema9`, `ema21`, and `ema50`. For other periods, compute manually from `candles[].close` using a library like `technicalindicators` (add to `devDependencies` — it gets bundled).

**How do I handle multi-market or multi-timeframe strategies?**  
Each instance is configured with one `market` and one `candleInterval`. Fetch the second timeframe or market via `ctx.getCandles(market, otherInterval, limit)` inside `tick()`. Be mindful of rate limits.
