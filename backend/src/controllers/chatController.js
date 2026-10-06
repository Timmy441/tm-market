const { recentOrdersForUser, orderByNumberForUser } = require('../models/chatModel');
const { SUPPORT, UNKNOWN_REPLY, INTENTS, ORDER_NUMBER_RE, matchIntent } = require('../utils/chatFaq');

const MAX_MESSAGE = 500;

const GREETING =
  'Hi! I am TM Assistant, an automated helper (not a human). I can answer questions about accounts, buying, selling, payments and orders. What do you need help with?';
const START_SUGGESTIONS = ['How do I buy?', 'How do I sell?', 'Track my order', 'Contact support'];

const naira = n => `₦${Number(n).toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function windowText(o) {
  return o.delivery_window_start && o.delivery_window_end
    ? ` Expected delivery: ${fmtDate(o.delivery_window_start)} to ${fmtDate(o.delivery_window_end)}.`
    : '';
}

// One sentence per status. Nothing is claimed beyond what the database says.
function describeOrder(o) {
  const head = `${o.order_number} (${naira(o.total)}${o.seller_name ? `, from ${o.seller_name}` : ''}): `;
  switch (o.status) {
    case 'pending':
      return `${head}waiting for payment, it has NOT been paid yet. Open "My orders" and tap "Pay now" to pay, or "Cancel order" to cancel it.`;
    case 'confirmed':
      return `${head}payment received. The seller has not shipped it yet.${windowText(o)}`;
    case 'processing':
      return `${head}the seller is preparing it.${windowText(o)}`;
    case 'shipped':
      return `${head}shipped.${windowText(o)} Tap "I have received this order" under "My orders" once it arrives.`;
    case 'delivered':
      return `${head}marked as delivered.`;
    case 'cancelled':
      return `${head}cancelled. If you had paid for it, please contact support about a refund. I cannot see or confirm refunds.`;
    default:
      return `${head}status is "${o.status}".`;
  }
}

function testModeNote() {
  return (process.env.PAYSTACK_SECRET_KEY || '').trim().startsWith('sk_test_')
    ? '\n\nNote: payments are currently in TEST mode, so no real money is charged.'
    : '';
}

async function liveOrdersReply(intent, message, user) {
  if (!user) {
    return {
      reply: `${intent.reply}\n\nTo see the live status of your own orders here, please log in first and ask again.`,
      support: false
    };
  }

  try {
    const m = ORDER_NUMBER_RE.exec(String(message));
    if (m) {
      const order = await orderByNumberForUser(user.id, m[0].toUpperCase());
      if (!order) {
        return { reply: `I could not find an order with that number on your account. Please check the number under "My orders" on the home page.`, support: true };
      }
      return { reply: describeOrder(order), support: false };
    }

    const orders = await recentOrdersForUser(user.id, 3);
    if (!orders.length) {
      return { reply: 'You have no orders yet. When you buy something, you can track it under "My orders" on the home page.', support: false };
    }
    return {
      reply: `Here ${orders.length === 1 ? 'is your order' : 'are your latest orders'}:\n\n${orders.map(describeOrder).join('\n\n')}\n\nOpen "My orders" on the home page for full details.`,
      support: false
    };
  } catch (err) {
    console.error('Chat order lookup error:', err);
    return { reply: 'I could not load your orders right now. Please try again in a moment, or open "My orders" on the home page.', support: true };
  }
}

// GET /api/chat/start (public): greeting, quick replies and the real support channels.
function start(req, res) {
  return res.json({ success: true, greeting: GREETING, suggestions: START_SUGGESTIONS, support: SUPPORT });
}

// POST /api/chat (public; order answers only when a valid login is sent).
async function message(req, res) {
  const raw = req.body && req.body.message;
  if (typeof raw !== 'string' || !raw.trim()) {
    return res.status(400).json({ success: false, message: 'Please type a question.' });
  }
  if (raw.length > MAX_MESSAGE) {
    return res.status(400).json({ success: false, message: `Please keep your message under ${MAX_MESSAGE} characters.` });
  }

  const user = req.user || null;
  let intent = matchIntent(raw);

  // A bare order number means "tell me about this order".
  if (!intent && ORDER_NUMBER_RE.test(raw)) intent = INTENTS.find(i => i.id === 'order_status');

  if (!intent) {
    return res.json({ success: true, reply: UNKNOWN_REPLY, suggestions: ['Contact support', 'How do I buy?'], support: SUPPORT, loggedIn: !!user });
  }

  let reply = intent.reply;
  let showSupport = !!intent.support;
  let suggestions = intent.suggestions || [];

  if (intent.live === 'orders') {
    const out = await liveOrdersReply(intent, raw, user);
    reply = out.reply;
    showSupport = out.support;
  } else if (intent.testNote) {
    reply += testModeNote();
  }

  return res.json({
    success: true,
    reply,
    suggestions,
    support: showSupport ? SUPPORT : null,
    loggedIn: !!user
  });
}

module.exports = { start, message, describeOrder };
