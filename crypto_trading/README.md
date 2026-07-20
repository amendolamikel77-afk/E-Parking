# Intraday Crypto Trading Scaffold

A modular, research-grade intraday crypto trading system in Python 3.11+.
It ingests OHLCV via [CCXT](https://github.com/ccxt/ccxt), generates
long/flat signals from a **replaceable placeholder strategy**, backtests
them with realistic costs, and can execute them automatically with a strong
default safety posture.

> ⚠️ **This is a research scaffold — not a profitable strategy and not
> financial advice.** The bundled MA-crossover-with-RSI-gate strategy is a
> didactic baseline that is expected to *lose* money on most data. Replace
> it with your own alpha before doing anything serious, and never risk money
> you cannot afford to lose.

## Design principles

- **One responsibility per module.** Config, data, signals, backtest, risk,
  execution, state, and orchestration are cleanly separated.
- **Causal by construction.** Indicators at bar `t` use only rows `<= t`;
  the still-forming final bar is dropped on ingest; the backtester fills a
  signal from bar `t` at the **open of bar `t+1`** (no lookahead).
- **Safe by default.** `sandbox=True` *and* `dry_run=True` out of the box.
  Real capital requires flipping **both** flags explicitly.
- **Secrets from the environment only.** Credentials are read from
  `EXCHANGE_API_KEY` / `EXCHANGE_API_SECRET` — never hardcoded, never passed
  as CLI args.

## Module map

| Module          | Responsibility                                                        |
| --------------- | --------------------------------------------------------------------- |
| `config.py`     | Frozen dataclasses; `SystemConfig` aggregates all sub-configs.        |
| `data.py`       | `DataFeed` over a CCXT client; UTC float DataFrame; `closed_only()`.  |
| `signals.py`    | `Signal` enum, Wilder RSI, `generate_signals`, `latest_signal`.      |
| `backtest.py`   | Event-driven next-bar backtester; fees+slippage; return/Sharpe/MDD.   |
| `risk.py`       | Fixed-fractional sizing + notional cap; SL/TP; daily-loss kill switch.|
| `execution.py`  | `Executor` over CCXT; dry-run; idempotent ids; precision; SL/TP/OCO.  |
| `state.py`      | Durable `PositionState` + startup reconciliation vs. `fetch_balance`. |
| `synthetic.py`  | Deterministic offline OHLCV fixture (no keys).                        |
| `main.py`       | Orchestration + `backtest` / `live` CLI subcommands.                  |

## Install

```bash
cd crypto_trading
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```

## Quick start

Run the full data → signal → backtest path on the built-in synthetic fixture
(no API keys required):

```bash
python -m crypto_trading.main backtest
```

Backtest your own OHLCV CSV (columns `timestamp,open,high,low,close,volume`,
UTC timestamps):

```bash
python -m crypto_trading.main --symbol BTC/USDT backtest --csv path/to/ohlcv.csv
```

Run the paper/live loop (defaults to sandbox + dry-run, so it only *logs*
intended orders):

```bash
export EXCHANGE_API_KEY=...        # sandbox keys for the dry-run stage
export EXCHANGE_API_SECRET=...
python -m crypto_trading.main live --iterations 3
```

## Staged de-risking path

Advance one stage at a time. Do **not** skip stages, and spend real time in
each before proceeding.

1. **Backtest (offline).** `main.py backtest`. Validate the signal logic,
   inspect the equity curve, trades, Sharpe and max drawdown. No keys, no
   network. Iterate on the strategy here.
2. **Sandbox dry-run.** Keep `sandbox=True`, `dry_run=True` (the defaults)
   and provide sandbox keys. The loop fetches real testnet data, computes
   signals, sizes positions, and *logs* the orders it would send. Confirm
   the intended orders, clientOrderIds, and protective levels look right.
3. **Sandbox live.** Flip `dry_run=False` (keep `sandbox=True`). Orders are
   actually placed on the exchange **test network** with fake funds.
   Verify precision rounding, `minNotional`, SL/TP placement, state
   persistence, and restart reconciliation against a real balance.
4. **Live, minimal capital.** Only after all of the above: set
   `sandbox=False` and `dry_run=False` (both flags — see
   `SystemConfig.with_live_capital()`), fund the account with the *smallest*
   meaningful amount, and keep the notional cap (`RiskConfig.max_notional`)
   tiny. Watch the kill switch and protective orders under real conditions.

At every stage the daily-loss kill switch halts new entries once the
configured loss budget is breached.

## Production hardening included

- **State persistence & reconciliation.** Position state is written
  atomically to `state.json` and reconciled against `fetch_balance` on
  startup, so a restart never loses or double-counts a position.
- **Precision & minimums.** Order amounts/prices are rounded with
  `amount_to_precision` / `price_to_precision` and validated against
  `minAmount` / `minNotional` before submission.
- **Idempotent orders.** `clientOrderId` is derived deterministically from
  `(symbol, bar timestamp, intent)`, so a crash-and-restart within the same
  bar cannot place a duplicate order.
- **Protective orders.** Stop-loss and take-profit are actually placed and
  monitored — via a single OCO where the exchange supports it, otherwise two
  reduce-only orders — not merely computed.

## Testing

```bash
python -m pytest
```

The suite validates the offline data → signal → backtest path on a synthetic
fixture, the no-lookahead invariant, next-bar execution, cost accounting,
sizing/kill-switch, state round-trip/reconciliation, and dry-run execution
(idempotent ids, `minNotional` rejection, kill-switch suppression). No live
keys are required.

## Replacing the strategy

Edit the clearly-marked `PLACEHOLDER STRATEGY` block in
`signals.generate_signals`. The only contract is: emit a `signal` column of
`Signal` values where the decision at row `t` depends on columns at row `t`
only. Everything downstream (backtest, sizing, execution) is agnostic to how
signals are produced.
