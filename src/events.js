/**
 * Event factory and event-type registry.
 *
 * Every observation the analysis layer is allowed to use is written here first.
 * Events carry `tick`, `day`, `hour` and a monotonically increasing `seq` that
 * the engine assigns, so a backtest can replay decisions using only events with
 * a seq at or below its cutoff. Event objects never carry latent demand.
 */

export const EVENT_TYPES = {
  EXPOSURE: 'exposure',
  STOCKOUT: 'stockout',
  ORDER_PLACED: 'order_placed',
  ORDER_PAID: 'order_paid',
  ORDER_CANCELLED: 'order_cancelled',
  ORDER_EXPIRED: 'order_expired',
  ORDER_RETURNED: 'order_returned',
  PRICE_CHANGED: 'price_changed',
  PLAN_CONFIRMED: 'plan_confirmed',
  PLAN_SUPERSEDED: 'plan_superseded',
  TICK: 'tick',
  DAY_CLOSED: 'day_closed',
};

export const EVENT_LABELS = {
  exposure: '曝光',
  stockout: '缺货',
  order_placed: '下单',
  order_paid: '支付',
  order_cancelled: '取消',
  order_expired: '预留过期',
  order_returned: '退货',
  price_changed: '调价',
  plan_confirmed: '方案上线',
  plan_superseded: '方案被取代',
  tick: '时钟',
  day_closed: '日结',
};

export function exposureEvent({
  tick,
  day,
  hour,
  channelId,
  priceCents,
  planId,
  planRevision,
  impressions,
  clicks,
  availableAtStart,
  orders,
  stockout,
}) {
  return {
    type: EVENT_TYPES.EXPOSURE,
    tick,
    day,
    hour,
    channelId,
    priceCents,
    planId,
    planRevision,
    impressions,
    clicks,
    availableAtStart,
    orders,
    stockout,
  };
}

/**
 * A stockout records that the shared pool hit zero while demand was arriving.
 * It deliberately does not record how many customers wanted units: that number
 * is unobservable in a real system, and the replay must not hand it to the
 * analyser for free.
 */
export function stockoutEvent({ tick, day, hour, channelId, served, atStart }) {
  return {
    type: EVENT_TYPES.STOCKOUT,
    tick,
    day,
    hour,
    channelId,
    served,
    atStart: Boolean(atStart),
  };
}

export function orderEvent({ type, tick, day, hour, channelId, orderId, priceCents, planId, reason = null }) {
  return {
    type,
    tick,
    day,
    hour,
    channelId,
    orderId,
    priceCents,
    planId,
    reason,
  };
}

export function priceChangedEvent({ tick, day, hour, planId, from, to, kind }) {
  return { type: EVENT_TYPES.PRICE_CHANGED, tick, day, hour, planId, from, to, kind };
}

export function planEvent({ type, tick, day, planId, name, rulesSnapshot, byPlanId = null }) {
  return { type, tick, day, planId, name, rulesSnapshot, byPlanId };
}

export function tickEvent({ tick, day, hour, label }) {
  return { type: EVENT_TYPES.TICK, tick, day, hour, label };
}

export function dayClosedEvent({ tick, day, inventory, revenueCents, refundsCents, orders, stockouts }) {
  return { type: EVENT_TYPES.DAY_CLOSED, tick, day, inventory, revenueCents, refundsCents, orders, stockouts };
}
