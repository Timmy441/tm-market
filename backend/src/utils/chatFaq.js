// TM Assistant: written FAQ + simple keyword matching. No AI model, no external service, no cost.
// Every answer below describes what the site really does today. If the site changes, change the answer here.

// The ONLY support channels. The chat window never shows anything that is not listed here.
const SUPPORT = {
  emails: ['tmmarketsupport@gmail.com', 'support@gmail.com'],
  whatsapp: { display: '+234 708 604 9886', link: 'https://wa.me/2347086049886' }
};

const SUPPORT_LINE =
  `You can reach the TM Market team by email at ${SUPPORT.emails.join(' or ')}, ` +
  `or on WhatsApp at ${SUPPORT.whatsapp.display}.`;

const UNKNOWN_REPLY = "I'm not sure about that. Please contact support.";

// Lower-case, drop apostrophes ("can't" -> "cant"), turn other punctuation into spaces.
function normalise(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\u2018\u2019`']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const ORDER_NUMBER_RE = /\bTM-\d{8}-[A-Z2-9]{8}\b/i;

// reply: plain text. support: show the Contact Support button. login: answer needs the person to be logged in.
// live: 'orders' means the answer is built from the person's real orders in the database (see chatController).
const INTENTS = [
  {
    id: 'human',
    patterns: [[/\b(human|real person|live agent|representative|customer care|customer service)\b/, 3], [/talk to (a |an )?(person|someone|human|agent)/, 3]],
    reply: `I'm TM Assistant, an automated helper, not a human. I can answer common questions about accounts, buying, selling and orders. For anything else, ${SUPPORT_LINE}`,
    support: true
  },
  {
    id: 'contact_support',
    patterns: [[/\b(contact|support|helpdesk|help desk|reach)\b/, 2], [/\b(email|whatsapp|phone number|call you|call us)\b/, 2]],
    reply: `${SUPPORT_LINE} Please include your order number if your question is about an order.`,
    support: true,
    suggestions: ['Report a problem', 'Track my order']
  },
  {
    id: 'report_problem',
    patterns: [[/\b(report|complain|complaint|scam|scammer|fraud|fake|abuse)\b/, 3], [/\b(problem|issue) with\b/, 3], [/\b(bug|not working|doesnt work|something went wrong)\b/, 2]],
    reply: `I'm sorry you ran into a problem. Please email the team with what happened: ${SUPPORT.emails.join(' or ')} (or WhatsApp ${SUPPORT.whatsapp.display}). Include your order number or the product name, the seller's store name if it involves a seller, and a screenshot if you can. I can't open or resolve reports from this chat.`,
    support: true
  },
  {
    id: 'create_account',
    patterns: [[/\b(create|open|make|register|sign ?up|join)\b.*\baccount\b/, 3], [/\bhow\b.*\b(register|sign ?up|join)\b/, 3], [/\bnew (user|account)\b/, 2], [/^(register|sign ?up)$/, 3]],
    reply: 'To create an account, tap "Sign Up" at the top of the page, then enter your full name, email, phone number and a password of at least 8 characters. Each email address and each phone number can belong to only one account. Nigerian numbers work in any format, for example 08012345678 or +2348012345678.',
    suggestions: ['I forgot my password', 'How do I buy?']
  },
  {
    id: 'reset_password',
    patterns: [[/\b(forgot|forget|reset|recover|lost)\b.*\bpas{1,2}wor?d\b/, 3], [/\bpas{1,2}wor?d\b.*\b(forgot|reset|recover|lost)\b/, 3], [/\bcant (log ?in|sign ?in)\b/, 1]],
    reply: 'To reset a forgotten password: tap "Login", then "Forgot password?", enter your email and submit. We email you a one-time link that works for 30 minutes and can be used once. If you do not see the email, check your spam folder. You can ask for another link after about a minute.',
    support: false,
    suggestions: ['Change my password', 'Contact support']
  },
  {
    id: 'change_password',
    patterns: [[/\b(change|update|new)\b.*\bpas{1,2}wor?d\b/, 3]],
    reply: 'While logged in, tap your name in the top corner to open "My Profile", then use the "Change password" section: enter your current password, the new one (at least 8 characters), and confirm it. Changing your password signs you out on your other devices.',
    suggestions: ['I forgot my password']
  },
  {
    id: 'login',
    patterns: [[/\b(log ?in|sign ?in)\b/, 2], [/\bcant (log ?in|sign ?in|access)\b/, 3], [/\b(wrong|incorrect) (password|email)\b/, 3]],
    reply: 'To log in, tap "Login" and enter your email and password. If it fails, check for typing mistakes (email capital letters do not matter). If you forgot your password, tap "Forgot password?" on the login form to get a reset link by email. Too many failed attempts in a short time will pause logins for a few minutes.',
    suggestions: ['I forgot my password', 'My account is suspended']
  },
  {
    id: 'suspended',
    patterns: [[/\b(suspend|suspended|deactivated|disabled|banned|blocked)\b/, 3], [/account (is )?(inactive|locked)/, 3]],
    reply: `If your account was suspended or made inactive, only the TM Market team can look into it. ${SUPPORT_LINE} Please send the email address you registered with.`,
    support: true
  },
  {
    id: 'payment_failed',
    patterns: [[/\b(payment|pay|paid|transaction)\b.*\b(fail|failed|declined|pending|stuck|error)\b/, 4], [/\b(debited|deducted|charged|money (was )?(taken|gone))\b/, 4], [/\bnot (go|going|went) through\b/, 3]],
    reply: `Payments are processed by Paystack, and our server confirms each payment with Paystack before an order is marked as paid, which can take a short while. Please do not pay twice. Open "My orders" on the home page: if the order is still "pending", you can tap "Pay now" to try again. If you were charged but the order does not update, contact support with your order number and the Paystack reference from your bank alert or email. ${SUPPORT_LINE}`,
    support: true,
    suggestions: ['Track my order']
  },
  {
    id: 'checkout',
    patterns: [[/\b(checkout|check out|paystack|pay for|how (do i|to|can i) pay|payment (method|option)s?)\b/, 3], [/\b(card|bank transfer|ussd)\b/, 2], [/\bpay(ment)?\b/, 1]],
    reply: 'To pay: add items to your bag, open the bag, tap "Checkout", enter your delivery details, and you will be taken to Paystack to complete payment. If your bag has items from several sellers, you get one order per seller and pay for them one after another. If you leave before paying, tap "Resume pending payment" in your bag, or "Pay now" on the order in "My orders".',
    testNote: true,
    suggestions: ['Payment failed', 'Track my order']
  },
  {
    id: 'buy',
    patterns: [[/\bhow\b.*\b(buy|order|purchase|shop)\b/, 3], [/\b(place|make) an order\b/, 3], [/\badd to (bag|cart)\b/, 3], [/\bwant to buy\b/, 3]],
    reply: 'To buy: log in (or sign up), browse the marketplace or the Shop page, open a product to see its details, and add it to your bag. Then open your bag and tap "Checkout", enter your delivery details and pay through Paystack. After payment, follow your order under "My orders" on the home page.',
    testNote: true,
    suggestions: ['How do I pay?', 'Track my order']
  },
  {
    id: 'contact_seller',
    patterns: [[/\b(contact|chat|message|talk|speak|reach)\b.*\bseller\b/, 4], [/\bseller\b.*\b(whatsapp|number|contact)\b/, 4], [/\b(negotiate|bargain)\b/, 3]],
    reply: 'Open a product to see its details, then tap "Chat with seller on WhatsApp". You need to be logged in, and the seller must have added a WhatsApp number. If a seller has not added one, you will see a message saying so.',
    suggestions: ['How do I buy?']
  },
  {
    id: 'add_product',
    patterns: [[/\b(add|post|list|upload|create|publish)\b.*\b(product|item|listing|goods|ad)\b/, 4], [/\bhow\b.*\b(list|upload)\b/, 3], [/\bsell (my|an?) /, 2]],
    reply: 'Go to the "Sell" page while logged in. If you have not opened a store yet, fill in your store name, location and an optional WhatsApp number first. Then use the "Add a product" form: product name, price, category, location, quantity available, a description, and up to 5 photos (JPG, PNG or WebP, max 5 MB each). Depending on how the marketplace is set up, a new listing may go live straight away or may wait for admin approval, and the page tells you which happened.',
    suggestions: ['Edit or delete a listing', 'How do I get paid?']
  },
  {
    id: 'edit_listing',
    patterns: [[/\b(edit|update|change|delete|remove|mark)\b.*\b(product|listing|item|sold)\b/, 4], [/\bmark (it )?(as )?sold\b/, 4]],
    reply: 'On the "Sell" page you can see your own listings. Use the buttons on each one to edit it, mark it as sold, or delete it. You can only manage your own listings.',
    suggestions: ['How do I add a product?']
  },
  {
    id: 'get_paid',
    patterns: [[/\b(get paid|payout|payouts|my money|withdraw|receive payment|seller payment)\b/, 4]],
    reply: `Seller payouts are currently handled manually by the TM Market team and there is no automatic payout button yet. For questions about a payout, please contact support. ${SUPPORT_LINE}`,
    support: true
  },
  {
    id: 'sell',
    patterns: [[/\b(sell|selling)\b/, 2], [/\b(seller|vendor|store)\b/, 1], [/\b(be|become) a (seller|vendor)\b/, 3], [/\bopen (a |my )?(store|shop)\b/, 4]],
    reply: 'To sell on TM Market, log in, go to the "Sell" page and open your store by entering your store name, location and an optional WhatsApp number. After that you can add products, manage your listings, and see paid orders for your products in the "Orders" tab, where you can set delivery dates and mark orders as shipped.',
    suggestions: ['How do I add a product?', 'How do I get paid?']
  },
  {
    id: 'change_phone',
    patterns: [[/\b(change|update|new|edit)\b.*\b(phone|number|mobile)\b/, 4], [/\bphone\b.*\b(already|used|exists|taken)\b/, 4]],
    reply: 'While logged in, tap your name in the top corner to open "My Profile", change the "Phone Number" and tap "Save Changes". Your phone number identifies your account, so each number can belong to only one account. If the number is already used by another account, you will see a message saying so and it cannot be saved.',
    suggestions: ['Edit my profile']
  },
  {
    id: 'address',
    patterns: [[/\b(delivery|shipping|home) address\b/, 4], [/\b(change|update|edit|add|save)\b.*\baddress\b/, 4]],
    reply: 'Open "My Profile" (tap your name in the top corner), enter your "Delivery Address" and tap "Save Changes". You also enter your delivery details at checkout for each purchase. Saved details only change future checkouts, not orders you already placed.',
    suggestions: ['How do I pay?']
  },
  {
    id: 'profile',
    patterns: [[/\bprofile\b/, 3], [/\b(change|update|edit)\b.*\b(name|picture|photo|avatar|details|info)\b/, 3], [/\b(profile|display) (picture|photo)\b/, 4]],
    reply: 'While logged in, tap your name in the top corner to open "My Profile". There you can change your name, phone number, delivery address and profile picture (tap the camera icon), then tap "Save Changes". Your email address cannot be changed there.',
    suggestions: ['Change my phone number', 'Change my password']
  },
  {
    id: 'refund',
    patterns: [[/\b(refund|refunded|money back|reimburse|reimbursement|chargeback)\b/, 4], [/\b(return|returns)\b.*\b(item|product|order)\b/, 3]],
    reply: `Refunds are handled by the TM Market team, not automatically and not by this chat, and I cannot start, approve or confirm a refund. If you need one, contact support with your order number and the email you used to pay. ${SUPPORT_LINE}`,
    support: true,
    suggestions: ['Cancel my order']
  },
  {
    id: 'cancel',
    patterns: [[/\bcancel\b/, 4], [/\bcancellation\b/, 4]],
    reply: `You can cancel an order yourself only while it is still unpaid ("pending"): open "My orders" on the home page and tap "Cancel order". Once an order is paid, it cannot be cancelled from the site, so please contact support. I cannot cancel an order for you from this chat. ${SUPPORT_LINE}`,
    support: true,
    suggestions: ['Track my order', 'Refunds']
  },
  {
    id: 'confirm_delivered',
    patterns: [[/\b(received|got) (my|the) (order|item|package|parcel)\b/, 4], [/\bconfirm\b.*\bdeliver/, 4], [/\bmark\b.*\bdelivered\b/, 4]],
    reply: 'When your order has been shipped, a button "I have received this order" appears on it under "My orders" on the home page. Tap it once your parcel has arrived to confirm delivery.',
    suggestions: ['Track my order']
  },
  {
    id: 'delivery_time',
    patterns: [[/\bhow long\b/, 3], [/\bwhen will\b.*\b(arrive|come|deliver|reach)\b/, 4], [/\b(delivery|arrival) (time|date|window)\b/, 4], [/\b(eta|estimated delivery)\b/, 3]],
    reply: 'Once your order is paid, the delivery date range (for example from one date to another) is shown on the order under "My orders" as soon as it has been set. Until a range is shown, there is no confirmed date yet. Delivery time depends on the seller and where you are, so I cannot promise one. For a specific order, ask me "Track my order" while logged in.',
    suggestions: ['Track my order']
  },
  {
    id: 'order_status',
    live: 'orders',
    patterns: [[/\b(track|tracking|status)\b/, 3], [/\bwhere (is|s|are)\b.*\b(order|package|parcel|item|delivery)\b/, 4], [/\b(has|have|did)\b.*\b(order|it|my)\b.*\b(ship|shipped|arrive|arrived|dispatch|dispatched)\b/, 4], [/\b(my )?latest order\b/, 4], [/\border (number|status|update)\b/, 3], [/\bhas my order\b/, 4], [/\b(shipped|dispatched)\b/, 3], [/\b(not|havent|hasnt|didnt|never)\b.*\b(receive|received|arrive|arrived)\b/, 4]],
    reply: 'Open "My orders" on the home page to see each order with its progress and delivery dates. Log in and ask me again to see the status of your latest orders here.',
    suggestions: ['Contact support']
  },
  {
    id: 'find_orders',
    live: 'orders',
    patterns: [[/\b(where|how)\b.*\b(see|find|view|check|open)\b.*\border/, 4], [/\bmy orders?\b/, 2], [/\border history\b/, 4]],
    reply: 'Log in, then tap "My orders" in the menu on the home page. Each order shows its status, items, total and delivery dates. If you are a seller, orders for your products are in the "Orders" tab on the Sell page.',
    suggestions: ['Track my order']
  },
  {
    id: 'change_email',
    patterns: [[/\b(change|update|edit|wrong|new)\b.*\bemail\b/, 4]],
    reply: `Your email address is shown in "My Profile" but cannot be edited there. If you need it changed, contact support from the address you registered with. ${SUPPORT_LINE}`,
    support: true
  },
  {
    id: 'about',
    patterns: [[/\b(who|what) are you\b/, 4], [/\bwhat can you (do|help)\b/, 4], [/\bare you (a )?(bot|robot|ai|human)\b/, 4]],
    reply: 'I am TM Assistant, an automated helper on TM Market (not a human). I answer common questions about accounts, buying, selling, payments and orders, and when you are logged in I can show the real status of your own orders. For anything else I will point you to the support team.',
    suggestions: ['How do I buy?', 'How do I sell?', 'Track my order']
  },
  {
    id: 'help',
    patterns: [[/^(i )?(need |want )?(some )?(help|assistance)( please| me)?$/, 4], [/^(please )?help( me)?( please)?$/, 4]],
    reply: 'Happy to help. I can answer questions about creating an account, logging in or resetting your password, buying and paying, selling and listing products, your profile, and tracking your orders. What would you like to know?',
    suggestions: ['How do I buy?', 'How do I sell?', 'Track my order', 'Contact support']
  },
  {
    id: 'greeting',
    patterns: [[/^(hi|hello|hey|hiya|howdy|good (morning|afternoon|evening)|sup|yo)( there| tm| assistant)?$/, 5]],
    reply: 'Hello! I am TM Assistant. I can help with accounts, buying, selling, payments and orders. What would you like to know?',
    suggestions: ['How do I buy?', 'How do I sell?', 'Track my order']
  },
  {
    id: 'thanks',
    patterns: [[/\b(thanks|thank you|thankyou|thx|appreciate)\b/, 4]],
    reply: "You're welcome! Is there anything else I can help with?"
  },
  {
    id: 'bye',
    patterns: [[/^(bye|goodbye|see you|cya|good night)\b/, 4]],
    reply: 'Goodbye! Come back any time you need help.'
  }
];

// Returns the best matching intent, or null when nothing matches well enough.
function matchIntent(message) {
  const text = normalise(message);
  if (!text) return null;

  let best = null;
  let bestScore = 0;

  for (const intent of INTENTS) {
    let score = 0;
    for (const [re, weight] of intent.patterns) {
      if (re.test(text)) score += weight;
    }
    if (score > bestScore) { best = intent; bestScore = score; }
  }
  return bestScore >= 2 ? best : null;
}

module.exports = { SUPPORT, SUPPORT_LINE, UNKNOWN_REPLY, INTENTS, ORDER_NUMBER_RE, normalise, matchIntent };
