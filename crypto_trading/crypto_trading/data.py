"""OHLCV ingestion via CCXT, wrapped in an exchange-agnostic feed.

The :class:`DataFeed` normalises raw CCXT candle arrays into a UTC
``DatetimeIndex``-ed float :class:`pandas.DataFrame`. The in-progress final
bar is dropped by default to guarantee that downstream signal generation
never sees a partially-formed candle (no intrabar lookahead).
"""

from __future__ import annotations

import time
from typing import Any, Protocol

import numpy as np
import pandas as pd

from .config import ExchangeConfig

OHLCV_COLUMNS: tuple[str, ...] = ("open", "high", "low", "close", "volume")


class SupportsFetchOHLCV(Protocol):
    """Structural type for the slice of the CCXT client we depend on."""

    def fetch_ohlcv(
        self,
        symbol: str,
        timeframe: str = ...,
        since: int | None = ...,
        limit: int | None = ...,
        params: dict[str, Any] = ...,
    ) -> list[list[float]]:
        ...


def raw_ohlcv_to_frame(rows: list[list[float]]) -> pd.DataFrame:
    """Convert CCXT ``[ts, o, h, l, c, v]`` rows into a typed DataFrame.

    Args:
        rows: CCXT OHLCV payload; timestamps are epoch milliseconds (UTC).

    Returns:
        A DataFrame indexed by a UTC ``DatetimeIndex`` named ``timestamp``
        with float64 ``open/high/low/close/volume`` columns, sorted
        ascending and de-duplicated on timestamp.
    """
    if not rows:
        return pd.DataFrame(
            columns=list(OHLCV_COLUMNS),
            index=pd.DatetimeIndex([], tz="UTC", name="timestamp"),
        ).astype(np.float64)

    arr = np.asarray(rows, dtype=np.float64)
    index = pd.to_datetime(arr[:, 0], unit="ms", utc=True)
    frame = pd.DataFrame(arr[:, 1:6], columns=list(OHLCV_COLUMNS), index=index)
    frame.index.name = "timestamp"
    frame = frame.astype(np.float64)
    # A given timestamp can be re-sent by the exchange; keep the last copy.
    frame = frame[~frame.index.duplicated(keep="last")]
    return frame.sort_index()


def closed_only(frame: pd.DataFrame, timeframe_ms: int, *, now_ms: int | None = None) -> pd.DataFrame:
    """Drop the trailing bar if it has not closed yet.

    A bar opened at ``t`` closes at ``t + timeframe_ms``. If the current
    wall-clock time is before that boundary the bar is still forming and is
    removed to avoid intrabar lookahead.

    Args:
        frame: OHLCV frame as produced by :func:`raw_ohlcv_to_frame`.
        timeframe_ms: Bar duration in milliseconds.
        now_ms: Override for the current epoch-ms time (testing hook).

    Returns:
        The frame with any still-open final bar removed.
    """
    if frame.empty:
        return frame
    current = now_ms if now_ms is not None else int(time.time() * 1000)
    last_open_ms = int(frame.index[-1].value // 1_000_000)
    if last_open_ms + timeframe_ms > current:
        return frame.iloc[:-1]
    return frame


class DataFeed:
    """Exchange-agnostic OHLCV feed over a CCXT-compatible client."""

    def __init__(self, client: SupportsFetchOHLCV, config: ExchangeConfig) -> None:
        """Store the client and derive the timeframe duration once.

        Args:
            client: Any object exposing CCXT's ``fetch_ohlcv`` signature.
            config: Exchange/symbol/timeframe configuration.
        """
        self._client = client
        self._config = config
        self._timeframe_ms = self.timeframe_to_ms(config.timeframe)

    @property
    def timeframe_ms(self) -> int:
        """Bar duration for the configured timeframe, in milliseconds."""
        return self._timeframe_ms

    @staticmethod
    def timeframe_to_ms(timeframe: str) -> int:
        """Parse a CCXT timeframe string (e.g. ``"5m"``) into milliseconds."""
        units = {"s": 1_000, "m": 60_000, "h": 3_600_000, "d": 86_400_000, "w": 604_800_000}
        unit = timeframe[-1]
        if unit not in units:
            raise ValueError(f"Unsupported timeframe unit in {timeframe!r}")
        try:
            magnitude = int(timeframe[:-1])
        except ValueError as exc:  # pragma: no cover - defensive
            raise ValueError(f"Invalid timeframe {timeframe!r}") from exc
        return magnitude * units[unit]

    def fetch_ohlcv(self, limit: int = 500, *, drop_open_bar: bool = True) -> pd.DataFrame:
        """Fetch recent candles as a typed, UTC-indexed DataFrame.

        Args:
            limit: Number of candles to request from the exchange.
            drop_open_bar: When ``True`` (default) the still-forming final
                bar is dropped via :func:`closed_only`.

        Returns:
            A float DataFrame of closed candles (unless ``drop_open_bar`` is
            ``False``), oldest first.
        """
        rows = self._client.fetch_ohlcv(
            self._config.symbol, timeframe=self._config.timeframe, limit=limit
        )
        frame = raw_ohlcv_to_frame(rows)
        if drop_open_bar:
            frame = closed_only(frame, self._timeframe_ms)
        return frame
