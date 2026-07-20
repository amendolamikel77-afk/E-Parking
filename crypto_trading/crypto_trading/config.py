"""Immutable configuration objects for the intraday crypto trading system.

All configuration is expressed as frozen dataclasses so that a fully
constructed :class:`SystemConfig` is hashable, side-effect free and safe to
share across modules. Secrets are never stored here -- credentials are read
from the environment at the edge (see :mod:`crypto_trading.execution`).
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from typing import Final

# Rough number of 5-minute bars in a 365-day year, used to annualise Sharpe.
# 24h * 60m / 5m = 288 bars/day; 288 * 365 = 105_120.
BARS_PER_YEAR_5M: Final[int] = 288 * 365


@dataclass(frozen=True, slots=True)
class ExchangeConfig:
    """Connection parameters for a CCXT exchange.

    Attributes:
        exchange_id: CCXT exchange identifier (e.g. ``"binance"``).
        symbol: Unified market symbol to trade (e.g. ``"BTC/USDT"``).
        timeframe: OHLCV timeframe string understood by the exchange.
        sandbox: When ``True`` the client is switched to the exchange's
            test network. Safe default.
        enable_rate_limit: Delegate throttling to CCXT.
    """

    exchange_id: str = "binance"
    symbol: str = "BTC/USDT"
    timeframe: str = "5m"
    sandbox: bool = True
    enable_rate_limit: bool = True


@dataclass(frozen=True, slots=True)
class StrategyConfig:
    """Parameters for the reference MA-crossover-with-RSI-gate strategy.

    Attributes:
        fast_ma: Lookback for the fast simple moving average.
        slow_ma: Lookback for the slow simple moving average.
        rsi_period: Wilder RSI lookback.
        rsi_buy_ceiling: Only allow long entries while RSI is below this
            (avoid buying into overbought conditions).
        rsi_exit_floor: Force a flat exit if RSI collapses below this.
    """

    fast_ma: int = 20
    slow_ma: int = 50
    rsi_period: int = 14
    rsi_buy_ceiling: float = 70.0
    rsi_exit_floor: float = 30.0

    def __post_init__(self) -> None:
        if self.fast_ma >= self.slow_ma:
            raise ValueError("fast_ma must be strictly less than slow_ma")
        if self.rsi_period < 2:
            raise ValueError("rsi_period must be >= 2")

    @property
    def warmup_bars(self) -> int:
        """Minimum bars required before indicators are trustworthy."""
        return max(self.slow_ma, self.rsi_period) + 1


@dataclass(frozen=True, slots=True)
class RiskConfig:
    """Position sizing and loss-control parameters.

    Attributes:
        risk_fraction: Fraction of equity to deploy per position (0-1].
        max_notional: Hard cap on position notional in quote currency.
        stop_loss_pct: Stop distance below entry, as a fraction (e.g. 0.02).
        take_profit_pct: Target distance above entry, as a fraction.
        daily_max_loss_pct: Kill-switch threshold on realised+unrealised
            daily loss, as a fraction of start-of-day equity.
    """

    risk_fraction: float = 0.10
    max_notional: float = 1_000.0
    stop_loss_pct: float = 0.02
    take_profit_pct: float = 0.04
    daily_max_loss_pct: float = 0.05

    def __post_init__(self) -> None:
        if not 0.0 < self.risk_fraction <= 1.0:
            raise ValueError("risk_fraction must be in (0, 1]")
        if self.max_notional <= 0:
            raise ValueError("max_notional must be positive")
        for name in ("stop_loss_pct", "take_profit_pct", "daily_max_loss_pct"):
            if getattr(self, name) <= 0:
                raise ValueError(f"{name} must be positive")


@dataclass(frozen=True, slots=True)
class BacktestConfig:
    """Cost model and horizon for the event-driven backtester.

    Attributes:
        fee_bps: Per-side taker fee in basis points.
        slippage_bps: Per-side slippage assumption in basis points.
        initial_equity: Starting quote-currency balance.
        bars_per_year: Used to annualise the Sharpe ratio.
    """

    fee_bps: float = 10.0
    slippage_bps: float = 5.0
    initial_equity: float = 10_000.0
    bars_per_year: int = BARS_PER_YEAR_5M

    def __post_init__(self) -> None:
        if self.fee_bps < 0 or self.slippage_bps < 0:
            raise ValueError("fee/slippage bps must be non-negative")
        if self.initial_equity <= 0:
            raise ValueError("initial_equity must be positive")


@dataclass(frozen=True, slots=True)
class ExecutionConfig:
    """Live/paper execution behaviour.

    Attributes:
        dry_run: When ``True`` orders are logged but never sent. Safe default.
        poll_interval_s: Seconds to sleep between polling loops.
        order_type: CCXT order type for entries/exits.
        client_order_prefix: Namespace for deterministic clientOrderIds.
        state_path: Where position state is persisted between runs.
        place_protective_orders: Place SL/TP (OCO where supported) after entry.
    """

    dry_run: bool = True
    poll_interval_s: float = 300.0
    order_type: str = "market"
    client_order_prefix: str = "ct"
    state_path: str = "state.json"
    place_protective_orders: bool = True


@dataclass(frozen=True, slots=True)
class SystemConfig:
    """Aggregate configuration passed around the whole system."""

    exchange: ExchangeConfig = field(default_factory=ExchangeConfig)
    strategy: StrategyConfig = field(default_factory=StrategyConfig)
    risk: RiskConfig = field(default_factory=RiskConfig)
    backtest: BacktestConfig = field(default_factory=BacktestConfig)
    execution: ExecutionConfig = field(default_factory=ExecutionConfig)

    @property
    def is_live_capital(self) -> bool:
        """True only when BOTH safety flags have been flipped off."""
        return not self.exchange.sandbox and not self.execution.dry_run

    def with_live_capital(self) -> "SystemConfig":
        """Return a copy with sandbox and dry_run disabled (real money)."""
        return replace(
            self,
            exchange=replace(self.exchange, sandbox=False),
            execution=replace(self.execution, dry_run=False),
        )


def default_config() -> SystemConfig:
    """Return the safe default configuration (sandbox + dry-run)."""
    return SystemConfig()
