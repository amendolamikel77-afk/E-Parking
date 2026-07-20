"""Signal generation: indicators plus a replaceable reference strategy.

Core invariant enforced throughout this module: the indicator and signal
value at row ``t`` is a function of rows ``<= t`` only. All rolling windows
and the Wilder RSI recursion are strictly backward-looking, so signals are
free of lookahead bias. Combined with next-bar execution in the backtester
and dropping the open bar in :mod:`crypto_trading.data`, the end-to-end path
is causal.
"""

from __future__ import annotations

from enum import IntEnum

import numpy as np
import pandas as pd

from .config import StrategyConfig


class Signal(IntEnum):
    """Discrete position intent for a long/flat system."""

    SELL = -1
    HOLD = 0
    BUY = 1


def wilder_rsi(close: pd.Series, period: int) -> pd.Series:
    """Compute Wilder's RSI using an exponential recursion.

    Wilder smoothing is an EMA with ``alpha = 1 / period``. The result at
    index ``t`` depends only on closes up to and including ``t``.

    Args:
        close: Close-price series (float), ascending time order.
        period: Averaging window (``>= 2``).

    Returns:
        RSI series in ``[0, 100]`` aligned to ``close``; the first
        ``period`` observations are ``NaN`` during warm-up.
    """
    if period < 2:
        raise ValueError("period must be >= 2")

    delta = close.diff()
    gain = delta.clip(lower=0.0)
    loss = (-delta).clip(lower=0.0)

    # Seed with a simple average of the first `period` deltas, then apply the
    # Wilder recursion. ``adjust=False`` gives the classic recursive form.
    avg_gain = gain.ewm(alpha=1.0 / period, min_periods=period, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1.0 / period, min_periods=period, adjust=False).mean()

    rs = avg_gain / avg_loss
    rsi = 100.0 - (100.0 / (1.0 + rs))
    # When average loss is zero RSI is defined as 100 (pure uptrend).
    rsi = rsi.where(avg_loss != 0.0, 100.0)
    # Preserve warm-up NaNs (where avg_gain itself is NaN).
    rsi = rsi.where(avg_gain.notna(), np.nan)
    return rsi.rename("rsi")


def generate_signals(df: pd.DataFrame, cfg: StrategyConfig) -> pd.DataFrame:
    """Append indicator and signal columns to an OHLCV frame.

    Reference strategy (a clearly-marked PLACEHOLDER -- swap this out for
    your own alpha): go long when the fast SMA is above the slow SMA and RSI
    is not yet overbought; go flat when the fast SMA crosses back below the
    slow SMA or RSI collapses. This is a didactic baseline, not a profitable
    edge.

    Args:
        df: OHLCV frame with a float ``close`` column.
        cfg: Strategy parameters.

    Returns:
        A copy of ``df`` with ``fast_ma``, ``slow_ma``, ``rsi`` and integer
        ``signal`` columns appended. ``signal`` holds :class:`Signal` values.
    """
    out = df.copy()
    close = out["close"]

    # --- Indicators (all strictly backward-looking) ---------------------
    out["fast_ma"] = close.rolling(cfg.fast_ma, min_periods=cfg.fast_ma).mean()
    out["slow_ma"] = close.rolling(cfg.slow_ma, min_periods=cfg.slow_ma).mean()
    out["rsi"] = wilder_rsi(close, cfg.rsi_period)

    # ==================================================================
    # PLACEHOLDER STRATEGY -- replace the block below with your own rules.
    # Contract: produce a `desired` array of Signal values where entry(BUY)
    # and exit(SELL) decisions at row t use columns at row t only.
    # ==================================================================
    trend_up = out["fast_ma"] > out["slow_ma"]
    rsi_ok = out["rsi"] < cfg.rsi_buy_ceiling
    rsi_break = out["rsi"] < cfg.rsi_exit_floor

    want_long = trend_up & rsi_ok
    force_flat = (~trend_up) | rsi_break

    desired = np.where(
        want_long, int(Signal.BUY), np.where(force_flat, int(Signal.SELL), int(Signal.HOLD))
    )
    # Rows still in warm-up (any indicator NaN) must be HOLD, never traded.
    warm = out[["fast_ma", "slow_ma", "rsi"]].isna().any(axis=1).to_numpy()
    desired = np.where(warm, int(Signal.HOLD), desired)
    # ==================================================================

    out["signal"] = pd.Series(desired, index=out.index, dtype="int64")
    return out


def latest_signal(df: pd.DataFrame) -> Signal:
    """Return the signal of the most recent (closed) bar.

    Args:
        df: Frame produced by :func:`generate_signals`.

    Returns:
        The :class:`Signal` on the final row, or ``HOLD`` if empty/missing.
    """
    if df.empty or "signal" not in df.columns:
        return Signal.HOLD
    return Signal(int(df["signal"].iloc[-1]))
