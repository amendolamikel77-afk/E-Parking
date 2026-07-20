"""Orchestration and CLI entry point.

Two subcommands:

* ``backtest`` -- run the data->signal->backtest path over CSV or synthetic
  data and print statistics. Requires no credentials.
* ``live`` -- run the polling loop: fetch closed bars, generate a signal,
  size, execute, place protective orders, persist state, sleep. Honours the
  sandbox/dry-run safety posture; credentials come from the environment only.

Credentials are read exclusively from ``EXCHANGE_API_KEY`` and
``EXCHANGE_API_SECRET``; they are never accepted as CLI arguments.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
import time
from typing import Any

import pandas as pd

from .backtest import BacktestResult, run_backtest
from .config import SystemConfig, default_config
from .data import DataFeed
from .execution import Executor
from .risk import RiskState, protective_levels, size_position
from .signals import Signal, generate_signals, latest_signal
from .state import PositionState, StateStore, reconcile_with_balance

logger = logging.getLogger("crypto_trading")


# --------------------------------------------------------------------------
# Exchange construction
# --------------------------------------------------------------------------
def build_exchange(config: SystemConfig) -> Any:
    """Instantiate a CCXT exchange with credentials from the environment.

    Args:
        config: System configuration (exchange id, sandbox flag).

    Returns:
        A configured CCXT exchange instance.

    Raises:
        RuntimeError: If ccxt is not installed.
    """
    try:
        import ccxt  # type: ignore
    except ImportError as exc:  # pragma: no cover - optional at test time
        raise RuntimeError("ccxt is required for live trading; pip install ccxt") from exc

    exchange_cls = getattr(ccxt, config.exchange.exchange_id)
    client = exchange_cls(
        {
            "apiKey": os.environ.get("EXCHANGE_API_KEY", ""),
            "secret": os.environ.get("EXCHANGE_API_SECRET", ""),
            "enableRateLimit": config.exchange.enable_rate_limit,
        }
    )
    if config.exchange.sandbox and client.has.get("sandbox"):
        client.set_sandbox_mode(True)
    client.load_markets()
    return client


# --------------------------------------------------------------------------
# Backtest subcommand
# --------------------------------------------------------------------------
def load_csv_ohlcv(path: str) -> pd.DataFrame:
    """Load an OHLCV CSV with a UTC timestamp column/index."""
    frame = pd.read_csv(path)
    ts_col = "timestamp" if "timestamp" in frame.columns else frame.columns[0]
    frame[ts_col] = pd.to_datetime(frame[ts_col], utc=True)
    frame = frame.set_index(ts_col).sort_index()
    frame.index.name = "timestamp"
    return frame[["open", "high", "low", "close", "volume"]].astype("float64")


def run_backtest_command(config: SystemConfig, csv_path: str | None) -> BacktestResult:
    """Execute the backtest path and print a summary.

    Args:
        config: System configuration.
        csv_path: OHLCV CSV path; if ``None`` a synthetic series is used.

    Returns:
        The :class:`BacktestResult`.
    """
    if csv_path:
        df = load_csv_ohlcv(csv_path)
    else:
        from .synthetic import synthetic_ohlcv

        logger.info("No CSV given; generating synthetic OHLCV fixture")
        df = synthetic_ohlcv(bars=1500)

    signalled = generate_signals(df, config.strategy)
    result = run_backtest(signalled, config.backtest)
    stats = result.stats
    assert stats is not None
    print("=" * 48)
    print(f"Bars:              {len(df)}")
    print(f"Trades:            {stats.num_trades}")
    print(f"Win rate:          {stats.win_rate:6.2%}")
    print(f"Total return:      {stats.total_return:6.2%}")
    print(f"Annualized Sharpe: {stats.annualized_sharpe:6.2f}")
    print(f"Max drawdown:      {stats.max_drawdown:6.2%}")
    print(f"Final equity:      {stats.final_equity:,.2f}")
    print("=" * 48)
    return result


# --------------------------------------------------------------------------
# Live subcommand
# --------------------------------------------------------------------------
def startup_reconcile(
    executor: Executor, store: StateStore, config: SystemConfig
) -> PositionState:
    """Load persisted state and reconcile it against the exchange balance."""
    state = store.load(config.exchange.symbol)
    try:
        base_free = executor.free_base_balance(config.exchange.symbol)
        state = reconcile_with_balance(state, base_free)
        store.save(state)
    except Exception as exc:  # pragma: no cover - network dependent
        logger.warning("Startup reconciliation skipped (balance unavailable): %s", exc)
    return state


def trade_once(
    feed: DataFeed,
    executor: Executor,
    store: StateStore,
    state: PositionState,
    risk_state: RiskState,
    config: SystemConfig,
) -> PositionState:
    """Run one poll->signal->size->execute cycle on closed bars.

    Returns:
        The updated (and persisted) :class:`PositionState`.
    """
    df = feed.fetch_ohlcv(limit=max(config.strategy.warmup_bars + 5, 200))
    if len(df) < config.strategy.warmup_bars:
        logger.info("Insufficient closed bars (%d); waiting", len(df))
        return state

    signalled = generate_signals(df, config.strategy)
    signal = latest_signal(signalled)
    last_bar = signalled.iloc[-1]
    price = float(last_bar["close"])
    bar_ms = int(signalled.index[-1].value // 1_000_000)

    # Refresh the kill switch against current equity (quote + position value).
    equity = executor.free_quote_balance(config.exchange.symbol) + state.quantity * price
    risk_state.roll_over_if_new_day(equity)
    risk_state.update_halt(config.risk, equity)

    if signal == Signal.BUY and not state.is_long:
        sizing = size_position(equity, price, config.risk)
        if not sizing.is_tradeable:
            logger.info("Sizing produced zero quantity; skipping entry")
            return state
        result = executor.place_entry(
            config.exchange.symbol, sizing.quantity, price, bar_ms, risk_state
        )
        if result.accepted:
            state.quantity = result.amount
            state.entry_price = price
            state.entry_bar_ms = bar_ms
            if config.execution.place_protective_orders:
                levels = protective_levels(price, config.risk)
                protective = executor.place_protective(
                    config.exchange.symbol, result.amount, levels, bar_ms
                )
                for order in protective:
                    if "sl" in order.client_order_id or "oco" in order.client_order_id:
                        state.stop_order_id = order.client_order_id
                    if "tp" in order.client_order_id or "oco" in order.client_order_id:
                        state.take_profit_order_id = order.client_order_id
            store.save(state)

    elif signal == Signal.SELL and state.is_long:
        # Cancel resting protective orders before market-exiting.
        for oid in (state.stop_order_id, state.take_profit_order_id):
            if oid:
                executor.cancel_order(oid, config.exchange.symbol)
        result = executor.place_exit(config.exchange.symbol, state.quantity, price, bar_ms)
        if result.accepted:
            realized = (price - state.entry_price) * state.quantity if state.entry_price else 0.0
            risk_state.register_realized_pnl(realized, config.risk, equity)
            state.to_flat()
            store.save(state)

    return state


def run_live_loop(config: SystemConfig, *, max_iterations: int | None = None) -> None:
    """Run the polling loop until interrupted (or ``max_iterations`` reached)."""
    if config.is_live_capital:
        logger.warning("LIVE CAPITAL MODE: sandbox=False and dry_run=False")
    else:
        logger.info(
            "Safe mode: sandbox=%s dry_run=%s",
            config.exchange.sandbox,
            config.execution.dry_run,
        )

    client = build_exchange(config)
    feed = DataFeed(client, config.exchange)
    executor = Executor(client, config.execution)
    store = StateStore(config.execution.state_path)

    state = startup_reconcile(executor, store, config)
    start_equity = executor.free_quote_balance(config.exchange.symbol)
    risk_state = RiskState.start_day(start_equity or config.backtest.initial_equity)

    iteration = 0
    while max_iterations is None or iteration < max_iterations:
        try:
            state = trade_once(feed, executor, store, state, risk_state, config)
        except Exception as exc:  # pragma: no cover - keep loop alive
            logger.exception("Cycle error: %s", exc)
        iteration += 1
        if max_iterations is not None and iteration >= max_iterations:
            break
        time.sleep(config.execution.poll_interval_s)


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------
def build_parser() -> argparse.ArgumentParser:
    """Construct the argument parser."""
    parser = argparse.ArgumentParser(prog="crypto_trading", description=__doc__)
    parser.add_argument("--symbol", default=None, help="Override the traded symbol")
    parser.add_argument("--timeframe", default=None, help="Override the timeframe")
    parser.add_argument("-v", "--verbose", action="store_true", help="Debug logging")

    sub = parser.add_subparsers(dest="command", required=True)

    bt = sub.add_parser("backtest", help="Run the data->signal->backtest path")
    bt.add_argument("--csv", default=None, help="OHLCV CSV path (else synthetic)")

    live = sub.add_parser("live", help="Run the live/paper polling loop")
    live.add_argument(
        "--iterations", type=int, default=None, help="Stop after N cycles (default: run forever)"
    )

    return parser


def config_from_args(args: argparse.Namespace) -> SystemConfig:
    """Apply CLI overrides to the default (safe) configuration."""
    from dataclasses import replace

    config = default_config()
    overrides: dict[str, Any] = {}
    if args.symbol:
        overrides["symbol"] = args.symbol
    if args.timeframe:
        overrides["timeframe"] = args.timeframe
    if overrides:
        config = replace(config, exchange=replace(config.exchange, **overrides))
    return config


def main(argv: list[str] | None = None) -> int:
    """CLI entry point."""
    args = build_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
    )
    config = config_from_args(args)

    if args.command == "backtest":
        run_backtest_command(config, args.csv)
        return 0
    if args.command == "live":
        run_live_loop(config, max_iterations=args.iterations)
        return 0
    return 1  # pragma: no cover - argparse enforces a command


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
