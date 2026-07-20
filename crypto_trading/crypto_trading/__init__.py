"""Modular intraday crypto trading system (research scaffold).

This package is a teaching/research scaffold, NOT a profitable strategy and
NOT financial advice. The bundled reference strategy is a deliberately
simple placeholder. Defaults are intentionally conservative: sandbox mode
and dry-run are both enabled, so deploying real capital requires explicit,
two-flag opt-in.
"""

from __future__ import annotations

from .config import (
    BacktestConfig,
    ExchangeConfig,
    ExecutionConfig,
    RiskConfig,
    StrategyConfig,
    SystemConfig,
    default_config,
)
from .signals import Signal

__all__ = [
    "BacktestConfig",
    "ExchangeConfig",
    "ExecutionConfig",
    "RiskConfig",
    "StrategyConfig",
    "SystemConfig",
    "Signal",
    "default_config",
]

__version__ = "0.1.0"
