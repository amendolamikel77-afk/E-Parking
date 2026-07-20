"""Event-driven backtester with strict next-bar execution.

Execution model: a signal observed on the close of bar ``t`` is acted upon
at the **open of bar ``t + 1``**. This removes the most common source of
inflated backtest results (filling at the same close that produced the
signal). Per-side taker fees and slippage are charged in basis points on
every fill.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from .config import BacktestConfig
from .signals import Signal

_BPS = 1e-4


@dataclass(frozen=True, slots=True)
class Trade:
    """A completed round-trip (entry to exit)."""

    entry_time: pd.Timestamp
    exit_time: pd.Timestamp
    entry_price: float
    exit_price: float
    quantity: float
    pnl: float
    return_pct: float


@dataclass(frozen=True, slots=True)
class BacktestStats:
    """Headline performance statistics."""

    total_return: float
    annualized_sharpe: float
    max_drawdown: float
    num_trades: int
    win_rate: float
    final_equity: float


@dataclass(slots=True)
class BacktestResult:
    """Full backtest output bundle."""

    equity_curve: pd.Series
    trades: list[Trade] = field(default_factory=list)
    stats: BacktestStats | None = None


def _sharpe(returns: np.ndarray, bars_per_year: int) -> float:
    """Annualised Sharpe from a per-bar return array (risk-free = 0)."""
    if returns.size < 2:
        return 0.0
    std = returns.std(ddof=1)
    if std == 0.0 or not np.isfinite(std):
        return 0.0
    return float(np.sqrt(bars_per_year) * returns.mean() / std)


def _max_drawdown(equity: np.ndarray) -> float:
    """Maximum peak-to-trough drawdown as a negative fraction."""
    if equity.size == 0:
        return 0.0
    running_peak = np.maximum.accumulate(equity)
    drawdowns = equity / running_peak - 1.0
    return float(drawdowns.min())


def run_backtest(df: pd.DataFrame, cfg: BacktestConfig) -> BacktestResult:
    """Simulate the long/flat strategy encoded in ``df['signal']``.

    Args:
        df: Frame with ``open``/``close`` prices and an integer ``signal``
            column (see :func:`crypto_trading.signals.generate_signals`).
        cfg: Cost model and horizon.

    Returns:
        A :class:`BacktestResult` with a per-bar equity curve, the list of
        completed round-trip trades, and summary statistics.

    Raises:
        ValueError: If required columns are missing.
    """
    required = {"open", "close", "signal"}
    missing = required - set(df.columns)
    if missing:
        raise ValueError(f"df missing required columns: {sorted(missing)}")

    opens = df["open"].to_numpy(dtype=np.float64)
    closes = df["close"].to_numpy(dtype=np.float64)
    signals = df["signal"].to_numpy(dtype=np.int64)
    index = df.index
    n = len(df)

    cost_rate = (cfg.fee_bps + cfg.slippage_bps) * _BPS

    equity = np.empty(n, dtype=np.float64)
    cash = cfg.initial_equity
    position_qty = 0.0  # base-currency units held
    entry_price = 0.0
    entry_time: pd.Timestamp | None = None
    trades: list[Trade] = []

    for t in range(n):
        # Mark-to-market equity at this bar's close.
        equity[t] = cash + position_qty * closes[t]

        # Decision made on bar t-1's close executes at bar t's open.
        if t == 0:
            continue
        intent = signals[t - 1]
        fill = opens[t]

        if intent == int(Signal.BUY) and position_qty == 0.0:
            # Enter long: buy with slippage-inflated price + fee on notional.
            eff_price = fill * (1.0 + cost_rate)
            qty = cash / eff_price
            cash -= qty * eff_price
            position_qty = qty
            entry_price = eff_price
            entry_time = index[t]
        elif intent == int(Signal.SELL) and position_qty > 0.0:
            # Exit long: sell with slippage-deflated price minus fee.
            eff_price = fill * (1.0 - cost_rate)
            proceeds = position_qty * eff_price
            cash += proceeds
            pnl = proceeds - position_qty * entry_price
            trades.append(
                Trade(
                    entry_time=entry_time,  # type: ignore[arg-type]
                    exit_time=index[t],
                    entry_price=entry_price,
                    exit_price=eff_price,
                    quantity=position_qty,
                    pnl=pnl,
                    return_pct=eff_price / entry_price - 1.0,
                )
            )
            position_qty = 0.0
            entry_price = 0.0
            entry_time = None

        # Recompute equity after any fill at this bar.
        equity[t] = cash + position_qty * closes[t]

    equity_series = pd.Series(equity, index=index, name="equity")

    # Per-bar simple returns for Sharpe.
    with np.errstate(divide="ignore", invalid="ignore"):
        bar_returns = np.diff(equity) / equity[:-1]
    bar_returns = bar_returns[np.isfinite(bar_returns)]

    wins = sum(1 for tr in trades if tr.pnl > 0)
    stats = BacktestStats(
        total_return=float(equity[-1] / cfg.initial_equity - 1.0) if n else 0.0,
        annualized_sharpe=_sharpe(bar_returns, cfg.bars_per_year),
        max_drawdown=_max_drawdown(equity),
        num_trades=len(trades),
        win_rate=(wins / len(trades)) if trades else 0.0,
        final_equity=float(equity[-1]) if n else cfg.initial_equity,
    )
    return BacktestResult(equity_curve=equity_series, trades=trades, stats=stats)
