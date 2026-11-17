/**
 * Shared inventory ledger.
 *
 * One physical pool per SKU, shared by every channel. Two-stage reservation:
 *   - a soft hold is created when the order is placed (expires after a TTL),
 *   - a firm commitment is created when the order is paid.
 * A cancellation releases the hold; a return puts a committed unit back on the
 * shelf. Every mutation emits an event through `onEvent`, so the unified event
 * log (and therefore the UI) can reconstruct each unit's journey.
 */

import { makeRng, randInt } from './rng.js';

export function inventoryEvent({ type, day, hour = null, channelId = null, orderId = null, qty, reason, note = '' }) {
  return { type, day, hour, channelId, orderId, qty, reason, note };
}

export class Inventory {
  constructor({ sku, openingUnits, returnRate = 0.08, holdTtlDays = 2, seed = 'inventory', onEvent = null }) {
    this.sku = sku;
    this.openingUnits = openingUnits;
    this.returnRate = returnRate;
    this.holdTtlDays = holdTtlDays;
    this.seed = seed;
    this.onEvent = onEvent;
    this.localEvents = [];
    this.units = {
      available: openingUnits,
      held: 0,
      committed: 0,
      cancelledReleased: 0,
      returned: 0,
      restocked: 0,
    };
    this.holds = [];
    this.holdCounter = 0;
  }

  record(event) {
    if (this.onEvent) this.onEvent(event);
    else this.localEvents.push(event);
  }

  get events() {
    return this.localEvents;
  }

  get onHand() {
    return this.units.available + this.units.held + this.units.committed;
  }

  nextHoldId() {
    this.holdCounter += 1;
    return `H-${String(this.holdCounter).padStart(4, '0')}`;
  }

  placeHold({ day, hour = null, channelId, orderId, priceCents }) {
    if (this.units.available <= 0) return null;
    this.units.available -= 1;
    this.units.held += 1;
    const hold = {
      id: this.nextHoldId(),
      orderId,
      channelId,
      priceCents,
      createdAtDay: day,
      expiresAtDay: day + this.holdTtlDays,
      state: 'held',
      releasedReason: null,
    };
    this.holds.push(hold);
    this.record(
      inventoryEvent({
        type: 'inventory_hold',
        day,
        hour,
        channelId,
        orderId,
        qty: -1,
        reason: 'order_placed',
        note: hold.id,
      }),
    );
    return hold;
  }

  findHold(orderId) {
    for (let i = this.holds.length - 1; i >= 0; i -= 1) {
      if (this.holds[i].orderId === orderId && this.holds[i].state === 'held') return this.holds[i];
    }
    return null;
  }

  commitHold(hold, day, hour = null) {
    if (!hold || hold.state !== 'held') return false;
    hold.state = 'committed';
    this.units.held -= 1;
    this.units.committed += 1;
    this.record(
      inventoryEvent({
        type: 'inventory_commit',
        day,
        hour,
        channelId: hold.channelId,
        orderId: hold.orderId,
        qty: 0,
        reason: 'payment_captured',
        note: hold.id,
      }),
    );
    return true;
  }

  releaseHold(hold, day, reason, hour = null) {
    if (!hold || hold.state !== 'held') return false;
    hold.state = 'released';
    hold.releasedReason = reason;
    this.units.held -= 1;
    this.units.available += 1;
    this.units.cancelledReleased += 1;
    this.record(
      inventoryEvent({
        type: 'inventory_release',
        day,
        hour,
        channelId: hold.channelId,
        orderId: hold.orderId,
        qty: 1,
        reason,
        note: hold.id,
      }),
    );
    return true;
  }

  returnCommitted(hold, day, hour = null, reason = 'customer_return') {
    if (!hold || hold.state !== 'committed') return false;
    hold.state = 'returned';
    this.units.committed -= 1;
    this.units.available += 1;
    this.units.returned += 1;
    this.record(
      inventoryEvent({
        type: 'inventory_return',
        day,
        hour,
        channelId: hold.channelId,
        orderId: hold.orderId,
        qty: 1,
        reason,
        note: hold.id,
      }),
    );
    return true;
  }

  expireHolds(day, hour = null) {
    const expired = [];
    for (const hold of this.holds) {
      if (hold.state !== 'held') continue;
      if (hold.expiresAtDay > day) continue;
      this.releaseHold(hold, day, 'hold_expired', hour);
      expired.push(hold);
    }
    return expired;
  }

  restock(units, day, hour = null, reason = 'manual_restock') {
    if (!Number.isFinite(units) || units <= 0) return false;
    const amount = Math.floor(units);
    this.units.available += amount;
    this.openingUnits += amount;
    this.units.restocked += amount;
    this.record(
      inventoryEvent({
        type: 'inventory_restock',
        day,
        hour,
        channelId: null,
        orderId: null,
        qty: amount,
        reason,
      }),
    );
    return true;
  }

  willReturn(orderId) {
    return makeRng(this.seed, 'return', orderId)() < this.returnRate;
  }

  randomReturnDelay(orderId, maxDays = 4) {
    return randInt(makeRng(this.seed, 'return-delay', orderId), 1, maxDays);
  }

  snapshot() {
    return {
      sku: this.sku,
      openingUnits: this.openingUnits,
      available: this.units.available,
      held: this.units.held,
      committed: this.units.committed,
      onHand: this.onHand,
      cancelledReleased: this.units.cancelledReleased,
      returned: this.units.returned,
      restocked: this.units.restocked,
      heldOrders: this.holds.filter((h) => h.state === 'held').length,
    };
  }

  checkInvariant() {
    const total = this.units.available + this.units.held + this.units.committed;
    const negative = Object.values(this.units).some((v) => v < 0);
    return {
      ok: total === this.openingUnits && !negative,
      total,
      openingUnits: this.openingUnits,
      negative,
    };
  }

  toJSON() {
    return {
      sku: this.sku,
      openingUnits: this.openingUnits,
      returnRate: this.returnRate,
      holdTtlDays: this.holdTtlDays,
      seed: this.seed,
      units: { ...this.units },
      holds: this.holds.map((h) => ({ ...h })),
      holdCounter: this.holdCounter,
    };
  }

  static fromJSON(data) {
    const inventory = new Inventory({
      sku: data.sku,
      openingUnits: data.openingUnits,
      returnRate: data.returnRate,
      holdTtlDays: data.holdTtlDays,
      seed: data.seed,
    });
    inventory.units = { ...data.units };
    inventory.holds = data.holds.map((h) => ({ ...h }));
    inventory.holdCounter = data.holdCounter;
    inventory.localEvents = [];
    return inventory;
  }
}
