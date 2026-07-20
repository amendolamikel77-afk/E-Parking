"""Order execution over a shared CCXT client.

Responsibilities:

* Honour the safety posture: in ``dry_run`` mode orders are only logged.
* Suppress new entries when :class:`~crypto_trading.risk.RiskState` is halted.
* Round amounts/prices to market precision and validate ``minNotional``.
* Derive ``clientOrderId`` deterministically from the bar timestamp + intent
  so a restart within the same bar cannot place a duplicate order.
* Place and (best-effort) monitor stop-loss/take-profit orders, using OCO
  where the exchange advertises support.
"""

from __future__ import annotations

import hashlib
import logging
from dataclasses import dataclass
from typing import Any, Protocol

from .config import ExecutionConfig
from .risk import ProtectiveLevels, RiskState

logger = logging.getLogger(__name__)


class CCXTClient(Protocol):
    """Structural type for the CCXT methods the executor relies on."""

    has: dict[str, Any]
    markets: dict[str, Any]

    def market(self, symbol: str) -> dict[str, Any]: ...
    def amount_to_precision(self, symbol: str, amount: float) -> str: ...
    def price_to_precision(self, symbol: str, price: float) -> str: ...
    def fetch_balance(self, params: dict[str, Any] = ...) -> dict[str, Any]: ...
    def create_order(
        self,
        symbol: str,
        type: str,
        side: str,
        amount: float,
        price: float | None = ...,
        params: dict[str, Any] = ...,
    ) -> dict[str, Any]: ...
    def cancel_order(self, id: str, symbol: str = ..., params: dict[str, Any] = ...) -> Any: ...
    def fetch_order(self, id: str, symbol: str = ..., params: dict[str, Any] = ...) -> dict[str, Any]: ...


@dataclass(frozen=True, slots=True)
class OrderResult:
    """Outcome of an order request (real or simulated)."""

    client_order_id: str
    symbol: str
    side: str
    amount: float
    price: float | None
    dry_run: bool
    accepted: bool
    reason: str = ""
    raw: dict[str, Any] | None = None


def make_client_order_id(prefix: str, symbol: str, bar_ms: int, intent: str) -> str:
    """Deterministically derive a clientOrderId.

    The same ``(symbol, bar_ms, intent)`` always yields the same id, so a
    crash-and-restart within one bar re-submits an idempotent order rather
    than a duplicate. The digest keeps it within exchange length limits.

    Args:
        prefix: Short namespace (e.g. ``"ct"``).
        symbol: Market symbol.
        bar_ms: Open timestamp of the decision bar in epoch ms.
        intent: Order intent tag (``"entry"``, ``"exit"``, ``"sl"``, ...).

    Returns:
        An alphanumeric id such as ``ct-entry-1a2b3c4d5e6f``.
    """
    digest = hashlib.sha1(f"{symbol}|{bar_ms}|{intent}".encode()).hexdigest()[:12]
    return f"{prefix}-{intent}-{digest}"


class Executor:
    """Places entry/exit and protective orders subject to safety checks."""

    def __init__(self, client: CCXTClient, config: ExecutionConfig) -> None:
        self._client = client
        self._config = config

    # -- account -------------------------------------------------------
    def fetch_balance(self) -> dict[str, Any]:
        """Return the raw CCXT balance structure."""
        return self._client.fetch_balance()

    def free_base_balance(self, symbol: str) -> float:
        """Free balance of ``symbol``'s base currency (e.g. BTC)."""
        base = symbol.split("/")[0]
        balance = self._client.fetch_balance()
        free = balance.get("free", {}) or {}
        return float(free.get(base, 0.0) or 0.0)

    def free_quote_balance(self, symbol: str) -> float:
        """Free balance of ``symbol``'s quote currency (e.g. USDT)."""
        quote = symbol.split("/")[1]
        balance = self._client.fetch_balance()
        free = balance.get("free", {}) or {}
        return float(free.get(quote, 0.0) or 0.0)

    # -- precision / validation ---------------------------------------
    def _round_amount(self, symbol: str, amount: float) -> float:
        return float(self._client.amount_to_precision(symbol, amount))

    def _round_price(self, symbol: str, price: float) -> float:
        return float(self._client.price_to_precision(symbol, price))

    def _min_notional(self, symbol: str) -> float:
        market = self._client.market(symbol)
        limits = market.get("limits", {}) or {}
        cost = (limits.get("cost", {}) or {}).get("min")
        return float(cost) if cost is not None else 0.0

    def _min_amount(self, symbol: str) -> float:
        market = self._client.market(symbol)
        limits = market.get("limits", {}) or {}
        amount = (limits.get("amount", {}) or {}).get("min")
        return float(amount) if amount is not None else 0.0

    def validate_order(self, symbol: str, amount: float, price: float) -> tuple[bool, str]:
        """Check a rounded order against exchange minimums.

        Returns:
            ``(ok, reason)`` where ``reason`` explains any rejection.
        """
        if amount <= 0.0:
            return False, "amount rounded to zero"
        min_amount = self._min_amount(symbol)
        if min_amount and amount < min_amount:
            return False, f"amount {amount} < minAmount {min_amount}"
        min_notional = self._min_notional(symbol)
        if min_notional and amount * price < min_notional:
            return False, f"notional {amount * price:.4f} < minNotional {min_notional}"
        return True, ""

    # -- order placement ----------------------------------------------
    def place_entry(
        self,
        symbol: str,
        amount: float,
        price: float,
        bar_ms: int,
        risk_state: RiskState,
    ) -> OrderResult:
        """Place (or simulate) a long entry, respecting the kill switch.

        Args:
            symbol: Market symbol.
            amount: Desired base-currency quantity (pre-rounding).
            price: Reference price for validation/limit orders.
            bar_ms: Decision-bar open timestamp (epoch ms).
            risk_state: If halted, the entry is suppressed.

        Returns:
            An :class:`OrderResult` describing what happened.
        """
        coid = make_client_order_id(self._config.client_order_prefix, symbol, bar_ms, "entry")
        if risk_state.halted:
            logger.warning("Kill switch active; suppressing entry %s", coid)
            return OrderResult(coid, symbol, "buy", amount, price, self._config.dry_run, False, "halted")

        rounded = self._round_amount(symbol, amount)
        ref_price = self._round_price(symbol, price)
        ok, reason = self.validate_order(symbol, rounded, ref_price)
        if not ok:
            logger.warning("Entry rejected (%s): %s", coid, reason)
            return OrderResult(coid, symbol, "buy", rounded, ref_price, self._config.dry_run, False, reason)

        return self._submit(symbol, "buy", rounded, ref_price, coid)

    def place_exit(self, symbol: str, amount: float, price: float, bar_ms: int) -> OrderResult:
        """Place (or simulate) a long exit (market/limit sell)."""
        coid = make_client_order_id(self._config.client_order_prefix, symbol, bar_ms, "exit")
        rounded = self._round_amount(symbol, amount)
        ref_price = self._round_price(symbol, price)
        if rounded <= 0.0:
            return OrderResult(coid, symbol, "sell", rounded, ref_price, self._config.dry_run, False, "nothing to sell")
        return self._submit(symbol, "sell", rounded, ref_price, coid)

    def place_protective(
        self,
        symbol: str,
        amount: float,
        levels: ProtectiveLevels,
        bar_ms: int,
    ) -> list[OrderResult]:
        """Place stop-loss and take-profit orders (OCO where supported).

        Args:
            symbol: Market symbol.
            amount: Position size to protect.
            levels: Stop-loss / take-profit price levels.
            bar_ms: Decision-bar timestamp for deterministic ids.

        Returns:
            One :class:`OrderResult` per protective order placed.
        """
        rounded = self._round_amount(symbol, amount)
        stop = self._round_price(symbol, levels.stop_loss)
        take = self._round_price(symbol, levels.take_profit)
        if rounded <= 0.0:
            return []

        supports_oco = bool(self._client.has.get("createOrderWithTakeProfitAndStopLoss")) or bool(
            self._client.has.get("createOCOOrder")
        )
        if supports_oco:
            coid = make_client_order_id(self._config.client_order_prefix, symbol, bar_ms, "oco")
            params = {
                "stopLossPrice": stop,
                "takeProfitPrice": take,
                "clientOrderId": coid,
                "reduceOnly": True,
            }
            if self._config.dry_run:
                logger.info("[DRY-RUN] OCO sell %s amt=%s sl=%s tp=%s", symbol, rounded, stop, take)
                return [OrderResult(coid, symbol, "sell", rounded, None, True, True, "dry-run oco")]
            raw = self._client.create_order(symbol, "market", "sell", rounded, None, params)
            return [OrderResult(coid, symbol, "sell", rounded, None, False, True, "oco", raw)]

        # Fall back to two independent reduce-only orders.
        results: list[OrderResult] = []
        sl_coid = make_client_order_id(self._config.client_order_prefix, symbol, bar_ms, "sl")
        tp_coid = make_client_order_id(self._config.client_order_prefix, symbol, bar_ms, "tp")
        results.append(
            self._submit(
                symbol, "sell", rounded, stop, sl_coid,
                order_type="stop", extra={"stopPrice": stop, "reduceOnly": True},
            )
        )
        results.append(
            self._submit(
                symbol, "sell", rounded, take, tp_coid,
                order_type="limit", extra={"reduceOnly": True},
            )
        )
        return results

    def monitor_order(self, order_id: str, symbol: str) -> dict[str, Any] | None:
        """Fetch the current status of a resting order (best effort)."""
        if self._config.dry_run:
            return None
        try:
            return self._client.fetch_order(order_id, symbol)
        except Exception as exc:  # pragma: no cover - network dependent
            logger.warning("Could not fetch order %s: %s", order_id, exc)
            return None

    def cancel_order(self, order_id: str, symbol: str) -> None:
        """Cancel a resting order (no-op in dry-run)."""
        if self._config.dry_run:
            logger.info("[DRY-RUN] cancel %s %s", order_id, symbol)
            return
        try:
            self._client.cancel_order(order_id, symbol)
        except Exception as exc:  # pragma: no cover - network dependent
            logger.warning("Could not cancel order %s: %s", order_id, exc)

    # -- internal ------------------------------------------------------
    def _submit(
        self,
        symbol: str,
        side: str,
        amount: float,
        price: float,
        client_order_id: str,
        *,
        order_type: str | None = None,
        extra: dict[str, Any] | None = None,
    ) -> OrderResult:
        """Send one order, or log it in dry-run mode."""
        otype = order_type or self._config.order_type
        params: dict[str, Any] = {"clientOrderId": client_order_id}
        if extra:
            params.update(extra)
        limit_price = None if otype == "market" else price

        if self._config.dry_run:
            logger.info(
                "[DRY-RUN] %s %s %s amt=%s price=%s id=%s",
                otype, side, symbol, amount, limit_price, client_order_id,
            )
            return OrderResult(client_order_id, symbol, side, amount, limit_price, True, True, "dry-run")

        try:
            raw = self._client.create_order(symbol, otype, side, amount, limit_price, params)
        except Exception as exc:  # pragma: no cover - network dependent
            logger.error("Order %s failed: %s", client_order_id, exc)
            return OrderResult(client_order_id, symbol, side, amount, limit_price, False, False, str(exc))
        return OrderResult(client_order_id, symbol, side, amount, limit_price, False, True, "submitted", raw)
