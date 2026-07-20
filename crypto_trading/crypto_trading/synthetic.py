"""Deterministic synthetic OHLCV generator for tests and demos.

Produces a reproducible geometric-random-walk price series shaped into
valid OHLCV bars (``low <= open/close <= high``) on a regular UTC grid. No
network or API keys required, so the whole data->signal->backtest path can
be validated offline.
"""

from __future__ import annotations

import numpy as np
import pandas as pd


def synthetic_ohlcv(
    bars: int = 1500,
    *,
    start: str = "2024-01-01",
    freq: str = "5min",
    start_price: float = 30_000.0,
    drift: float = 0.0002,
    volatility: float = 0.004,
    seed: int = 7,
) -> pd.DataFrame:
    """Generate a reproducible OHLCV frame.

    Args:
        bars: Number of candles to generate.
        start: First bar's UTC open time.
        freq: Pandas offset alias for the bar spacing (e.g. ``"5min"``).
        start_price: Initial close price.
        drift: Per-bar log-return drift; a small positive value creates a
            gentle uptrend so the reference strategy actually trades.
        volatility: Per-bar log-return standard deviation.
        seed: RNG seed for reproducibility.

    Returns:
        A UTC-indexed float DataFrame with ``open/high/low/close/volume``.
    """
    if bars <= 0:
        raise ValueError("bars must be positive")

    rng = np.random.default_rng(seed)
    index = pd.date_range(start=start, periods=bars, freq=freq, tz="UTC", name="timestamp")

    # Trending regime for the first half, mean-reverting chop for the second,
    # so the crossover strategy sees both winning and losing conditions.
    log_returns = rng.normal(loc=drift, scale=volatility, size=bars)
    half = bars // 2
    log_returns[half:] -= drift  # remove drift in the second half
    log_returns[half:] += np.sin(np.arange(bars - half) / 8.0) * volatility * 0.5

    close = start_price * np.exp(np.cumsum(log_returns))
    prev_close = np.concatenate(([start_price], close[:-1]))
    open_ = prev_close

    # Intrabar range as a fraction of price.
    spread = np.abs(rng.normal(0.0, volatility, size=bars)) * close
    high = np.maximum(open_, close) + spread
    low = np.minimum(open_, close) - spread
    low = np.clip(low, a_min=1e-8, a_max=None)
    volume = rng.uniform(10.0, 100.0, size=bars)

    return pd.DataFrame(
        {"open": open_, "high": high, "low": low, "close": close, "volume": volume},
        index=index,
    ).astype("float64")
