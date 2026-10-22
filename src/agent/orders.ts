// The agent's payment tools: create_order, get_order, capture_order. the model decides when to call them; the server decides whether
// a call is allowed. create_order must carry exactly the buyer's selected item ids (prices come from the stored cards), and
// capture_order runs the guarded finishOrder (fresh PayPal read, APPROVED and same amount, else no capture). If the model is
// unavailable or does not call the tool, the same server functions run directly, so a model outage can never block or alter a payment.
import { getOrder } from '../adapters/paypal.ts';
import { addTrace, finishOrder, loadOrder, priceOrder, startCheckout, type CheckoutResult } from '../commerce.ts';
import type { Svc } from '../lib/http.ts';
import { fmtCents } from '../lib/util.ts';
import type { OrderRecord, Session } from '../types.ts';
import { runLoop, ToolError, toolSpec, type Tool } from './loop.ts';

const CHECKOUT_SYSTEM = `[task:checkout]
You are the payment step of Tasteloom's gift agent (PayPal sandbox, no real money).
Call create_order exactly once, with item_ids equal to selected_item_ids from the user message. Do not add, drop or change ids. Then reply DONE.`;

const RETURN_SYSTEM = `[task:return]
The buyer came back from PayPal. Call get_order for the order_id in the user message.
If its status is APPROVED, call capture_order. Otherwise do not capture. Then reply DONE.`;

const sameIds = (a: unknown, b: string[]) => Array.isArray(a) && [...new Set(a.map(String))].sort().join('|') === b.join('|');

/** Create the PayPal order for the buyer's selection, through the agent when a model is available. */
export async function agentCheckout(svc: Svc, session: Session, itemIds: unknown, urls: { returnUrl: string; cancelUrl: string }): Promise<CheckoutResult> {
  const { lines } = priceOrder(session, itemIds, svc.cfg.limits); // throws OrderError before any model call
  const ids = lines.map((l) => l.id).sort();
  let result: CheckoutResult | undefined;
  let orderErr: unknown;
  const tool: Tool = {
    spec: toolSpec('create_order', 'Create the PayPal sandbox order for the buyer’s selected items. item_ids must equal selected_item_ids.', { item_ids: { type: 'array', items: { type: 'string' } } }, ['item_ids']),
    run: async (a) => {
      if (!sameIds(a.item_ids, ids)) throw new ToolError('item_ids must be exactly selected_item_ids');
      try {
        result = await startCheckout(svc, session, ids, urls);
      } catch (e) {
        orderErr = e; // limit, cap or PayPal failure: reported to the buyer below, not hidden behind the model
        throw new ToolError('the order could not be created');
      }
      return { order_id: result.order.id, status: 'CREATED', total_usd: fmtCents(result.order.total_cents) };
    },
  };
  let viaAgent = false;
  try {
    await runLoop(svc, { model: svc.cfg.models.agent, system: CHECKOUT_SYSTEM, user: { selected_item_ids: ids }, tools: [tool], maxTurns: 2, stopAfter: ['create_order'], timeoutMs: 10000 });
    viaAgent = !!result;
  } catch {
    // model unavailable: fall through to the direct call
  }
  if (orderErr) throw orderErr;
  if (!result) result = await startCheckout(svc, session, ids, urls);
  if (!result.reused) {
    await addTrace(svc, result.order.id, viaAgent ? `The model called create_order: CREATED, total $${fmtCents(result.order.total_cents)}` : `Server created the order directly (the agent did not): total $${fmtCents(result.order.total_cents)}`);
  }
  return result;
}

/** After the buyer returns from PayPal: get_order, then capture_order only if APPROVED. Always ends with a guarded server check. */
export async function agentReturn(svc: Svc, orderId: string): Promise<OrderRecord | null> {
  const order = await loadOrder(svc, orderId);
  if (!order) return null;
  if (order.status === 'COMPLETED' || order.status === 'CANCELLED') return order;
  let finished: OrderRecord | null = null;
  const lines: string[] = [];
  const own = (a: Record<string, unknown>) => {
    if (a.order_id !== orderId) throw new ToolError('unknown order_id');
  };
  const tools: Tool[] = [
    {
      spec: toolSpec('get_order', 'Read the PayPal sandbox order: status and amount.', { order_id: { type: 'string' } }, ['order_id']),
      run: async (a) => {
        own(a);
        const v = await getOrder(svc, orderId);
        lines.push(`The model called get_order: ${v.status}`);
        return { status: v.status, total_usd: v.total_cents === null ? null : fmtCents(v.total_cents), currency: v.currency };
      },
    },
    {
      spec: toolSpec('capture_order', 'Capture the payment. Only valid when get_order reported APPROVED; the server re-checks before capturing.', { order_id: { type: 'string' } }, ['order_id']),
      run: async (a) => {
        own(a);
        finished = await finishOrder(svc, orderId);
        lines.push(`The model called capture_order: ${finished?.status ?? 'unknown'}`);
        return { status: finished?.status };
      },
    },
  ];
  try {
    await runLoop(svc, { model: svc.cfg.models.agent, system: RETURN_SYSTEM, user: { order_id: orderId }, tools, maxTurns: 4, stopAfter: ['capture_order'], timeoutMs: 10000 });
  } catch {
    // model or PayPal read failed inside the loop: the guarded server check below decides
  }
  if (!finished) {
    finished = await finishOrder(svc, orderId);
    lines.push(`Server checked the order and finished it: ${finished?.status ?? 'unknown'}`);
  }
  await addTrace(svc, orderId, ...lines);
  return (await loadOrder(svc, orderId)) ?? finished;
}
