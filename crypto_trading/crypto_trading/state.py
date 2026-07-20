"""Durable position state and startup reconciliation.

The bot must survive restarts without losing track of an open position or
duplicating orders. :class:`PositionState` is a small JSON-serialisable
record persisted atomically to disk. On startup it is reconciled against the
exchange's actual balance so the in-memory view matches reality.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
from dataclasses import asdict, dataclass, field
from typing import Any

logger = logging.getLogger(__name__)


@dataclass(slots=True)
class PositionState:
    """Persisted view of the current position and protective orders.

    Attributes:
        symbol: Market the position is in.
        quantity: Base-currency units held (0 means flat).
        entry_price: Average entry price (0 when flat).
        entry_bar_ms: Open timestamp (epoch ms) of the entry bar; used to
            derive deterministic clientOrderIds.
        stop_order_id: Exchange order id of the resting stop, if any.
        take_profit_order_id: Exchange order id of the resting TP, if any.
    """

    symbol: str
    quantity: float = 0.0
    entry_price: float = 0.0
    entry_bar_ms: int = 0
    stop_order_id: str | None = None
    take_profit_order_id: str | None = None

    @property
    def is_long(self) -> bool:
        """True when a non-trivial long position is held."""
        return self.quantity > 0.0

    def to_flat(self) -> None:
        """Reset to a flat position, clearing protective-order references."""
        self.quantity = 0.0
        self.entry_price = 0.0
        self.entry_bar_ms = 0
        self.stop_order_id = None
        self.take_profit_order_id = None


class StateStore:
    """Atomic JSON persistence for :class:`PositionState`."""

    def __init__(self, path: str) -> None:
        self._path = path

    @property
    def path(self) -> str:
        return self._path

    def load(self, symbol: str) -> PositionState:
        """Load persisted state, or return a fresh flat state.

        Args:
            symbol: Expected market symbol; a mismatch or missing file
                yields a fresh flat state for ``symbol``.
        """
        if not os.path.exists(self._path):
            return PositionState(symbol=symbol)
        try:
            with open(self._path, "r", encoding="utf-8") as handle:
                data: dict[str, Any] = json.load(handle)
        except (json.JSONDecodeError, OSError) as exc:
            logger.warning("Could not read state file %s: %s; starting flat", self._path, exc)
            return PositionState(symbol=symbol)
        if data.get("symbol") != symbol:
            logger.warning(
                "State symbol %s != configured %s; starting flat",
                data.get("symbol"),
                symbol,
            )
            return PositionState(symbol=symbol)
        known = PositionState.__slots__  # type: ignore[attr-defined]
        return PositionState(**{k: v for k, v in data.items() if k in known})

    def save(self, state: PositionState) -> None:
        """Persist ``state`` atomically (write-temp-then-rename)."""
        directory = os.path.dirname(os.path.abspath(self._path))
        os.makedirs(directory, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=directory, suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(asdict(state), handle, indent=2, sort_keys=True)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(tmp, self._path)
        except BaseException:
            if os.path.exists(tmp):
                os.unlink(tmp)
            raise


def reconcile_with_balance(
    state: PositionState,
    base_free: float,
    *,
    dust_threshold: float = 1e-8,
) -> PositionState:
    """Reconcile persisted state against the exchange's real base balance.

    This guards against divergence caused by manual trades, partial fills,
    or a crash between order and persistence.

    Args:
        state: The state loaded from disk.
        base_free: Free balance of the base currency reported by the
            exchange (e.g. BTC units for ``BTC/USDT``).
        dust_threshold: Balances at/below this are treated as flat.

    Returns:
        The (possibly mutated) reconciled state.
    """
    exchange_flat = base_free <= dust_threshold
    if state.is_long and exchange_flat:
        logger.warning(
            "State shows long %.8f but exchange is flat; resetting to flat",
            state.quantity,
        )
        state.to_flat()
    elif not state.is_long and not exchange_flat:
        logger.warning(
            "State shows flat but exchange holds %.8f base; adopting balance",
            base_free,
        )
        state.quantity = base_free
        # Entry price is unknown; leave at 0 and let protective logic re-arm.
    elif state.is_long and not exchange_flat:
        # Both agree there is a position; trust exchange size if it drifted.
        if abs(state.quantity - base_free) > dust_threshold:
            logger.info(
                "Adjusting stored qty %.8f -> exchange %.8f",
                state.quantity,
                base_free,
            )
            state.quantity = base_free
    return state
