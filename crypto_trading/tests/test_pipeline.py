"""End-to-end and unit tests for the trading scaffold (no live keys)."""

from __future__ import annotations

import time

import numpy as np
import pandas as pd
import pytest

from crypto_trading.backtest import run_backtest
from crypto_trading.config import (
    BacktestConfig,
    RiskConfig,
    StrategyConfig,
    default_config,
)
from crypto_trading.data import DataFeed, closed_only, raw_ohlcv_to_frame
from crypto_trading.execution import Executor, make_client_order_id
from crypto_trading.risk import RiskState, protective_levels, size_position
from crypto_trading.signals import Signal, generate_signals, latest_signal, wilder_rsi
from crypto_trading.state import PositionState, StateStore, reconcile_with_balance
from crypto_trading.synthetic import synthetic_ohlcv


# --------------------------------------------------------------------------
# Fixtures
# --------------------------------------------------------------------------
@pytest.fixture()
def ohlcv() -> pd.DataFrame:
    return synthetic_ohlcv(bars=1200)


# --------------------------------------------------------------------------
# Data
# --------------------------------------------------------------------------
def test_raw_ohlcv_to_frame_types_and_order() -> None:
    rows = [
        [1_700_000_300_000, 2.0, 3.0, 1.0, 2.5, 10.0],
        [1_700_000_000_000, 1.0, 2.0, 0.5, 1.5, 5.0],
    ]
    frame = raw_ohlcv_to_frame(rows)
    assert list(frame.columns) == ["open", "high", "low", "close", "volume"]
    assert str(frame.index.tz) == "UTC"
    assert frame.index.is_monotonic_increasing
    assert frame.dtypes.eq(np.float64).all()


def test_closed_only_drops_open_bar() -> None:
    idx = pd.date_range("2024-01-01", periods=3, freq="5min", tz="UTC")
    frame = pd.DataFrame(
        {"open": 1.0, "high": 1.0, "low": 1.0, "close": 1.0, "volume": 1.0}, index=idx
    )
    tf_ms = 5 * 60_000
    # "now" is one minute into the final bar -> it should be dropped.
    now_ms = int(idx[-1].value // 1_000_000) + 60_000
    trimmed = closed_only(frame, tf_ms, now_ms=now_ms)
    assert len(trimmed) == 2
    # "now" well past the final bar's close -> keep everything.
    now_ms2 = int(idx[-1].value // 1_000_000) + tf_ms + 1
    assert len(closed_only(frame, tf_ms, now_ms=now_ms2)) == 3


def test_datafeed_uses_closed_only() -> None:
    # Anchor the final bar to "now" so it is genuinely still open.
    now_ms = int(time.time() * 1000)
    tf_ms = 5 * 60_000
    last_open = (now_ms // tf_ms) * tf_ms  # current, still-forming bar
    opens = [last_open - 3 * tf_ms, last_open - 2 * tf_ms, last_open - tf_ms, last_open]
    rows = [[m, 1.0, 1.0, 1.0, 1.0, 1.0] for m in opens]

    class FakeClient:
        def fetch_ohlcv(self, symbol, timeframe="5m", since=None, limit=None, params=None):
            return rows

    feed = DataFeed(FakeClient(), default_config().exchange)
    assert feed.timeframe_ms == tf_ms
    frame = feed.fetch_ohlcv(limit=10)
    # Last bar is still open relative to real "now", so it is dropped.
    assert len(frame) == 3


# --------------------------------------------------------------------------
# Signals
# --------------------------------------------------------------------------
def test_wilder_rsi_bounds_and_warmup() -> None:
    close = pd.Series(np.linspace(100, 120, 50))
    rsi = wilder_rsi(close, 14)
    valid = rsi.dropna()
    assert (valid >= 0).all() and (valid <= 100).all()
    # Monotonic increase -> RSI pinned at 100.
    assert valid.iloc[-1] == pytest.approx(100.0)
    assert rsi.iloc[:14].isna().all()


def test_signals_no_lookahead(ohlcv: pd.DataFrame) -> None:
    """Signal at row t must be reproducible from data[:t+1] alone."""
    cfg = StrategyConfig()
    full = generate_signals(ohlcv, cfg)
    t = 800
    partial = generate_signals(ohlcv.iloc[: t + 1], cfg)
    assert int(full["signal"].iloc[t]) == int(partial["signal"].iloc[t])
    assert full["rsi"].iloc[t] == pytest.approx(partial["rsi"].iloc[t], rel=1e-9)


def test_signals_are_valid_enum(ohlcv: pd.DataFrame) -> None:
    signalled = generate_signals(ohlcv, StrategyConfig())
    assert set(signalled["signal"].unique()).issubset({s.value for s in Signal})
    assert isinstance(latest_signal(signalled), Signal)


def test_warmup_rows_are_hold(ohlcv: pd.DataFrame) -> None:
    cfg = StrategyConfig()
    signalled = generate_signals(ohlcv, cfg)
    warm = signalled.iloc[: cfg.slow_ma - 1]
    assert (warm["signal"] == Signal.HOLD).all()


# --------------------------------------------------------------------------
# Backtest (end-to-end path)
# --------------------------------------------------------------------------
def test_backtest_end_to_end(ohlcv: pd.DataFrame) -> None:
    cfg = default_config()
    signalled = generate_signals(ohlcv, cfg.strategy)
    result = run_backtest(signalled, cfg.backtest)
    stats = result.stats
    assert stats is not None
    assert len(result.equity_curve) == len(ohlcv)
    assert np.isfinite(stats.total_return)
    assert np.isfinite(stats.annualized_sharpe)
    assert -1.0 <= stats.max_drawdown <= 0.0
    assert stats.num_trades >= 0
    # Equity must never go negative in a long/flat, cash-covered system.
    assert (result.equity_curve > 0).all()


def test_backtest_next_bar_execution() -> None:
    """A BUY at bar t fills at t+1 open, not bar t's close."""
    idx = pd.date_range("2024-01-01", periods=4, freq="5min", tz="UTC")
    df = pd.DataFrame(
        {
            "open": [100.0, 100.0, 110.0, 110.0],
            "high": [100.0, 100.0, 110.0, 110.0],
            "low": [100.0, 100.0, 110.0, 110.0],
            "close": [100.0, 100.0, 110.0, 110.0],
            "signal": [Signal.BUY, Signal.HOLD, Signal.HOLD, Signal.HOLD],
        },
        index=idx,
    )
    cfg = BacktestConfig(fee_bps=0.0, slippage_bps=0.0, initial_equity=1000.0)
    result = run_backtest(df, cfg)
    # Entry fills at bar 1 open (100). Position gains when price steps to 110.
    assert result.trades == []  # never exits, but should be long and marked up
    assert result.equity_curve.iloc[-1] == pytest.approx(1100.0, rel=1e-6)


def test_backtest_fees_reduce_equity() -> None:
    df = pd.DataFrame(
        {
            "open": [100.0, 100.0, 100.0],
            "high": [100.0, 100.0, 100.0],
            "low": [100.0, 100.0, 100.0],
            "close": [100.0, 100.0, 100.0],
            "signal": [Signal.BUY, Signal.SELL, Signal.HOLD],
        },
        index=pd.date_range("2024-01-01", periods=3, freq="5min", tz="UTC"),
    )
    free = run_backtest(df, BacktestConfig(fee_bps=0.0, slippage_bps=0.0, initial_equity=1000.0))
    costed = run_backtest(df, BacktestConfig(fee_bps=10.0, slippage_bps=5.0, initial_equity=1000.0))
    assert free.stats.final_equity == pytest.approx(1000.0, rel=1e-9)
    assert costed.stats.final_equity < 1000.0
    assert costed.stats.num_trades == 1


# --------------------------------------------------------------------------
# Risk
# --------------------------------------------------------------------------
def test_size_position_notional_cap() -> None:
    cfg = RiskConfig(risk_fraction=0.5, max_notional=100.0)
    sized = size_position(equity=10_000.0, price=50.0, cfg=cfg)
    assert sized.notional == pytest.approx(100.0)  # capped, not 5000
    assert sized.quantity == pytest.approx(2.0)


def test_protective_levels() -> None:
    cfg = RiskConfig(stop_loss_pct=0.02, take_profit_pct=0.04)
    levels = protective_levels(100.0, cfg)
    assert levels.stop_loss == pytest.approx(98.0)
    assert levels.take_profit == pytest.approx(104.0)


def test_kill_switch_halts() -> None:
    cfg = RiskConfig(daily_max_loss_pct=0.05)
    state = RiskState(day=__import__("datetime").date(2024, 1, 1), start_equity=1000.0)
    assert not state.update_halt(cfg, current_equity=970.0)  # -3% ok
    assert state.update_halt(cfg, current_equity=940.0)  # -6% breaches
    assert state.halted


# --------------------------------------------------------------------------
# State persistence + reconciliation
# --------------------------------------------------------------------------
def test_state_roundtrip(tmp_path) -> None:
    store = StateStore(str(tmp_path / "state.json"))
    state = PositionState(symbol="BTC/USDT", quantity=0.5, entry_price=30_000.0, entry_bar_ms=123)
    store.save(state)
    loaded = store.load("BTC/USDT")
    assert loaded.quantity == pytest.approx(0.5)
    assert loaded.entry_price == pytest.approx(30_000.0)
    assert loaded.entry_bar_ms == 123


def test_state_symbol_mismatch_resets(tmp_path) -> None:
    store = StateStore(str(tmp_path / "state.json"))
    store.save(PositionState(symbol="ETH/USDT", quantity=1.0))
    loaded = store.load("BTC/USDT")
    assert not loaded.is_long


def test_reconcile_flat_when_exchange_flat() -> None:
    state = PositionState(symbol="BTC/USDT", quantity=0.5, entry_price=30_000.0)
    reconcile_with_balance(state, base_free=0.0)
    assert not state.is_long


def test_reconcile_adopts_exchange_balance() -> None:
    state = PositionState(symbol="BTC/USDT")
    reconcile_with_balance(state, base_free=0.25)
    assert state.quantity == pytest.approx(0.25)


# --------------------------------------------------------------------------
# Execution (dry-run, no network)
# --------------------------------------------------------------------------
def test_client_order_id_deterministic() -> None:
    a = make_client_order_id("ct", "BTC/USDT", 1_700_000_000_000, "entry")
    b = make_client_order_id("ct", "BTC/USDT", 1_700_000_000_000, "entry")
    c = make_client_order_id("ct", "BTC/USDT", 1_700_000_000_000, "exit")
    assert a == b  # idempotent across restarts within a bar
    assert a != c  # intent-dependent


class _FakeExchange:
    """Minimal CCXT stand-in for dry-run execution tests."""

    has = {"createOrderWithTakeProfitAndStopLoss": False, "createOCOOrder": False}
    markets: dict = {}

    def market(self, symbol):
        return {"limits": {"amount": {"min": 0.0001}, "cost": {"min": 10.0}}}

    def amount_to_precision(self, symbol, amount):
        return f"{amount:.6f}"

    def price_to_precision(self, symbol, price):
        return f"{price:.2f}"

    def fetch_balance(self, params=None):
        return {"free": {"BTC": 0.0, "USDT": 5000.0}}

    def create_order(self, symbol, type, side, amount, price=None, params=None):
        return {"id": "srv-1", "clientOrderId": (params or {}).get("clientOrderId")}


def test_executor_dry_run_does_not_send(monkeypatch) -> None:
    cfg = default_config()
    assert cfg.execution.dry_run is True
    executor = Executor(_FakeExchange(), cfg.execution)
    state = RiskState.start_day(5000.0)
    res = executor.place_entry("BTC/USDT", amount=0.01, price=30_000.0, bar_ms=1, risk_state=state)
    assert res.accepted and res.dry_run
    assert res.reason == "dry-run"


def test_executor_halted_suppresses_entry() -> None:
    executor = Executor(_FakeExchange(), default_config().execution)
    state = RiskState.start_day(5000.0)
    state.halted = True
    res = executor.place_entry("BTC/USDT", amount=0.01, price=30_000.0, bar_ms=1, risk_state=state)
    assert not res.accepted and res.reason == "halted"


def test_executor_min_notional_rejected() -> None:
    executor = Executor(_FakeExchange(), default_config().execution)
    state = RiskState.start_day(5000.0)
    # 0.0002 * 30000 = 6 USDT < minNotional 10 -> rejected.
    res = executor.place_entry("BTC/USDT", amount=0.0002, price=30_000.0, bar_ms=1, risk_state=state)
    assert not res.accepted
    assert "minNotional" in res.reason


def test_safety_defaults() -> None:
    cfg = default_config()
    assert cfg.exchange.sandbox is True
    assert cfg.execution.dry_run is True
    assert cfg.is_live_capital is False
    assert cfg.with_live_capital().is_live_capital is True
