"""Position sizing, protective levels, and the daily-loss kill switch.

Sizing is fixed-fractional with a hard notional cap. Stop-loss/take-profit
levels are computed from configured fractional distances. A mutable
:class:`RiskState` tracks intraday PnL so the kill switch can halt new
entries once the daily loss budget is breached.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, timezone

from .config import RiskConfig


@dataclass(frozen=True, slots=True)
class PositionSize:
    """Result of a sizing decision."""

    quantity: float
    notional: float

    @property
    def is_tradeable(self) -> bool:
        """True when the sized position is non-trivial."""
        return self.quantity > 0.0 and self.notional > 0.0


@dataclass(frozen=True, slots=True)
class ProtectiveLevels:
    """Stop-loss and take-profit price levels for a long position."""

    stop_loss: float
    take_profit: float


@dataclass(slots=True)
class RiskState:
    """Mutable intraday risk accounting.

    Attributes:
        day: UTC date the accounting applies to.
        start_equity: Equity recorded at the start of ``day``.
        realized_pnl: Realised PnL accumulated during ``day``.
        halted: When ``True`` new entries are suppressed.
    """

    day: date
    start_equity: float
    realized_pnl: float = 0.0
    halted: bool = False

    @classmethod
    def start_day(cls, equity: float, *, now: datetime | None = None) -> "RiskState":
        """Create fresh state for the current UTC day."""
        moment = now or datetime.now(timezone.utc)
        return cls(day=moment.astimezone(timezone.utc).date(), start_equity=equity)

    def roll_over_if_new_day(self, equity: float, *, now: datetime | None = None) -> None:
        """Reset accounting (and clear the halt) when the UTC day changes."""
        moment = now or datetime.now(timezone.utc)
        today = moment.astimezone(timezone.utc).date()
        if today != self.day:
            self.day = today
            self.start_equity = equity
            self.realized_pnl = 0.0
            self.halted = False

    def register_realized_pnl(self, pnl: float, cfg: RiskConfig, current_equity: float) -> None:
        """Record realised PnL and update the halt flag."""
        self.realized_pnl += pnl
        self.update_halt(cfg, current_equity)

    def update_halt(self, cfg: RiskConfig, current_equity: float) -> bool:
        """Re-evaluate the kill switch against total (realised+unrealised) loss.

        Args:
            cfg: Risk configuration holding the daily loss threshold.
            current_equity: Live equity including unrealised PnL.

        Returns:
            The updated ``halted`` flag.
        """
        loss = self.start_equity - current_equity
        threshold = cfg.daily_max_loss_pct * self.start_equity
        if loss >= threshold:
            self.halted = True
        return self.halted


def size_position(equity: float, price: float, cfg: RiskConfig) -> PositionSize:
    """Fixed-fractional sizing capped by ``max_notional``.

    Args:
        equity: Current account equity in quote currency.
        price: Current asset price (quote per base unit).
        cfg: Risk configuration.

    Returns:
        A :class:`PositionSize`. Quantity is zero if inputs are non-positive.
    """
    if equity <= 0.0 or price <= 0.0:
        return PositionSize(quantity=0.0, notional=0.0)
    notional = min(equity * cfg.risk_fraction, cfg.max_notional)
    quantity = notional / price
    return PositionSize(quantity=quantity, notional=notional)


def protective_levels(entry_price: float, cfg: RiskConfig) -> ProtectiveLevels:
    """Compute stop-loss/take-profit prices for a long entry.

    Args:
        entry_price: Fill price of the long entry.
        cfg: Risk configuration with fractional SL/TP distances.

    Returns:
        The absolute price levels for the protective orders.
    """
    if entry_price <= 0.0:
        raise ValueError("entry_price must be positive")
    return ProtectiveLevels(
        stop_loss=entry_price * (1.0 - cfg.stop_loss_pct),
        take_profit=entry_price * (1.0 + cfg.take_profit_pct),
    )
