const bcrypt = require('bcryptjs');

const { getPasswordHash } = require('../models/userModel');
const model = require('../models/payoutModel');
const rules = require('../utils/payoutRules');
const directory = require('../utils/bankDirectory');
const { notifyAdminOfWithdrawal, notifySellerOfSettlement } = require('../utils/payoutAlert');

const STATUSES = ['pending', 'approved', 'processing', 'paid', 'rejected', 'failed'];
const naira = n => '\u20A6' + Number(n).toLocaleString('en-NG');
const bad = (res, message, code = 400) => res.status(code).json({ success: false, message });

const currentRules = () => ({ feePercent: rules.feePercent(), holdDays: rules.holdDays(), minWithdrawal: rules.minWithdrawal() });

// Money actions are written to the server log (visible with `fly logs`).
function log(action, who, extra) {
  console.log(JSON.stringify({ payout: true, at: new Date().toISOString(), action, by: who, ...extra }));
}

function formatWithdrawal(w, { admin = false } = {}) {
  const out = {
    id: Number(w.id),
    amount: Number(w.amount),
    status: w.status,
    bank: { name: w.bank_name, accountName: w.account_name, accountNumber: admin ? w.account_number : rules.maskAccount(w.account_number) },
    note: w.admin_note || null,
    reference: w.payment_reference || null,
    requestedAt: w.requested_at,
    reviewedAt: w.reviewed_at || null,
    paidAt: w.paid_at || null
  };
  if (admin) {
    out.bank.code = w.bank_code || null;
    out.seller = {
      id: Number(w.seller_id),
      store: w.store_name || null,
      name: `${w.first_name || ''} ${w.last_name || ''}`.trim(),
      email: w.seller_email || null,
      phone: w.seller_phone || null
    };
    if (Array.isArray(w.events)) out.events = w.events.map(e => ({ status: e.status, note: e.note || null, at: e.created_at }));
  }
  return out;
}

/* ---------------- seller ---------------- */

async function myPayouts(req, res) {
  try {
    const r = currentRules();
    const s = await model.getSummary(req.user.id, r);
    const { pendingKobo, availableKobo, ...balances } = s.balances;
    return res.json({
      success: true,
      balances,
      bank: s.bank ? { bankName: s.bank.bank_name, accountName: s.bank.account_name, accountNumber: rules.maskAccount(s.bank.account_number), verified: !!s.bank.bank_code } : null,
      withdrawals: s.withdrawals.map(w => formatWithdrawal(w)),
      rules: r
    });
  } catch (e) {
    console.error('Payout summary error:', e);
    return bad(res, 'Unable to load your earnings', 500);
  }
}

// Returns an error message, or null when the password is right.
async function passwordProblem(userId, password) {
  if (typeof password !== 'string' || !password) return 'Please enter your password to confirm this change.';
  const hash = await getPasswordHash(userId);
  if (!hash || !(await bcrypt.compare(password, hash))) return 'Your password is incorrect.';
  return null;
}

// GET /api/sellers/me/bank/list: banks for the dropdown. If Paystack cannot answer we say so (200), and the page falls back to typing.
async function bankList(req, res) {
  try {
    return res.json({ success: true, banks: await directory.getBanks() });
  } catch (e) {
    console.error('Bank list error:', e && e.message);
    return res.json({ success: true, banks: [], unavailable: true });
  }
}

// POST /api/sellers/me/bank/resolve { bankCode, accountNumber }: shows the account holder's name before saving.
async function resolveBank(req, res) {
  try {
    const b = req.body || {};
    const bankCode = typeof b.bankCode === 'string' ? b.bankCode.trim() : '';
    const accountNumber = typeof b.accountNumber === 'string' ? b.accountNumber.trim() : '';
    if (!/^\d{2,10}$/.test(bankCode)) return bad(res, 'Please choose your bank from the list.');
    if (!/^\d{10}$/.test(accountNumber)) return bad(res, 'Account number must be exactly 10 digits.');

    const v = await directory.verifyAccount(accountNumber, bankCode);
    if (!v.ok && v.reason === 'not_found') return bad(res, 'We could not find an account with that number at this bank. Please check the bank and the number.');
    if (!v.ok) return bad(res, 'We could not check your account right now. Please try again in a few minutes.', 503);
    return res.json({ success: true, accountName: v.accountName });
  } catch (e) {
    console.error('Resolve bank error:', e);
    return bad(res, 'We could not check your account right now. Please try again in a few minutes.', 503);
  }
}

async function saveMyBank(req, res) {
  try {
    const body = req.body || {};
    const code = typeof body.bankCode === 'string' ? body.bankCode.trim() : '';
    let input = body;

    if (code) {
      // Verified path: the bank comes from our list and the account NAME comes from Paystack, never from the browser.
      if (!/^\d{2,10}$/.test(code)) return bad(res, 'Bank code must be digits only.');
      const number = typeof body.accountNumber === 'string' ? body.accountNumber.trim() : '';
      if (!/^\d{10}$/.test(number)) return bad(res, 'Account number must be exactly 10 digits.');
      const problem = await passwordProblem(req.user.id, body.password);
      if (problem) return bad(res, problem);

      const v = await directory.verifyAccount(number, code);
      if (!v.ok && v.reason === 'not_found') return bad(res, 'We could not find an account with that number at this bank. Please check the bank and the number.');
      if (!v.ok) return bad(res, 'We could not check your account right now, so it was not saved. Please try again in a few minutes.', 503);
      const bank = await directory.findBank(code);
      input = { ...body, bankCode: code, accountNumber: number, accountName: v.accountName, bankName: bank ? bank.name : body.bankName };
    }

    const check = rules.validateBank(input);
    if (!check.ok) return bad(res, check.message);

    if (!code) {
      const problem = await passwordProblem(req.user.id, body.password);
      if (problem) return bad(res, problem);
    }

    const result = await model.saveBank(req.user.id, check.value);
    if (result.status === 'open_exists') {
      return bad(res, 'You have a withdrawal waiting to be paid. You can change your bank details after it is settled.', 409);
    }
    log('bank.save', req.user.id, { verified: !!code });
    return res.json({ success: true, verified: !!code, bank: { bankName: check.value.bankName, accountName: check.value.accountName, accountNumber: rules.maskAccount(check.value.accountNumber) } });
  } catch (e) {
    console.error('Save bank error:', e);
    return bad(res, 'Unable to save your bank details', 500);
  }
}

async function requestMyWithdrawal(req, res) {
  try {
    const r = currentRules();
    const amount = rules.parseAmount(req.body && req.body.amount);
    if (amount === null) return bad(res, 'Enter a valid amount in naira, for example 20000.');
    if (amount < r.minWithdrawal) return bad(res, `The minimum withdrawal is ${naira(r.minWithdrawal)}.`);

    const result = await model.requestWithdrawal(req.user.id, amount, r);
    if (result.status === 'no_bank') return bad(res, 'Please add your bank details first.');
    if (result.status === 'open_exists') return bad(res, 'You already have a withdrawal waiting to be paid. Please wait for it to be settled.', 409);
    if (result.status === 'insufficient') return bad(res, `You can withdraw up to ${naira(result.available)} right now.`);
    if (result.status !== 'ok') return bad(res, 'Unable to create your withdrawal request', 500);

    log('withdrawal.request', req.user.id, { withdrawalId: Number(result.withdrawal.id), amount });
    notifyAdminOfWithdrawal(result.withdrawal.id);
    return res.status(201).json({ success: true, withdrawal: formatWithdrawal(result.withdrawal) });
  } catch (e) {
    console.error('Withdrawal request error:', e);
    return bad(res, 'Unable to create your withdrawal request', 500);
  }
}

/* ---------------- admin (routes sit behind requireAdmin) ---------------- */

const parseId = v => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };

async function adminList(req, res) {
  try {
    const q = req.query || {};
    const status = typeof q.status === 'string' && STATUSES.includes(q.status) ? q.status : null;
    const limit = Math.min(parseId(q.limit) || 20, 50);
    const page = parseId(q.page) || 1;
    const out = await model.adminListWithdrawals({ status, limit, offset: (page - 1) * limit });
    return res.json({ success: true, withdrawals: out.withdrawals.map(w => formatWithdrawal(w, { admin: true })), total: out.total, openCount: out.openCount, page, limit });
  } catch (e) {
    console.error('Admin withdrawals error:', e);
    return bad(res, 'Something went wrong', 500);
  }
}

async function adminDetail(req, res) {
  try {
    const id = parseId(req.params.id);
    if (!id) return bad(res, 'Invalid withdrawal id');
    const w = await model.adminGetWithdrawal(id);
    if (!w) return bad(res, 'Withdrawal not found', 404);
    return res.json({ success: true, withdrawal: formatWithdrawal(w, { admin: true }) });
  } catch (e) {
    console.error('Admin withdrawal detail error:', e);
    return bad(res, 'Something went wrong', 500);
  }
}

async function adminMarkPaid(req, res) {
  try {
    const id = parseId(req.params.id);
    if (!id) return bad(res, 'Invalid withdrawal id');
    const b = req.body || {};

    const reference = typeof b.reference === 'string' ? b.reference.trim() : '';
    if (reference.length < 4 || reference.length > 120 || !/^[\w\-./ ]+$/.test(reference)) {
      return bad(res, 'Enter the Paystack transfer reference or bank transfer reference (4 to 120 letters, numbers or - . / _).');
    }
    const note = typeof b.note === 'string' && b.note.trim() ? b.note.trim() : null;
    if (note && note.length > 200) return bad(res, 'The note is too long (200 characters at most).');

    const w = await model.adminGetWithdrawal(id);
    if (!w) return bad(res, 'Withdrawal not found', 404);

    const result = await model.markPaid(id, req.user.id, reference, note);
    if (result.status === 'duplicate_reference') return bad(res, 'This reference is already recorded on another withdrawal.', 409);
    if (result.status !== 'ok') return bad(res, 'This withdrawal has already been settled.', 409);

    log('withdrawal.paid', req.user.id, { withdrawalId: id, amount: Number(w.amount), reference });
    notifySellerOfSettlement(id);
    return res.json({ success: true, withdrawal: formatWithdrawal(await model.adminGetWithdrawal(id), { admin: true }) });
  } catch (e) {
    console.error('Admin mark paid error:', e);
    return bad(res, 'Something went wrong', 500);
  }
}

async function adminReject(req, res) {
  try {
    const id = parseId(req.params.id);
    if (!id) return bad(res, 'Invalid withdrawal id');

    const note = typeof (req.body && req.body.note) === 'string' ? req.body.note.trim() : '';
    if (note.length < 3 || note.length > 300) return bad(res, 'Please give the seller a short reason (3 to 300 characters).');

    const w = await model.adminGetWithdrawal(id);
    if (!w) return bad(res, 'Withdrawal not found', 404);

    const result = await model.reject(id, req.user.id, note);
    if (result.status !== 'ok') return bad(res, 'This withdrawal has already been settled.', 409);

    log('withdrawal.rejected', req.user.id, { withdrawalId: id, amount: Number(w.amount) });
    notifySellerOfSettlement(id);
    return res.json({ success: true, withdrawal: formatWithdrawal(await model.adminGetWithdrawal(id), { admin: true }) });
  } catch (e) {
    console.error('Admin reject error:', e);
    return bad(res, 'Something went wrong', 500);
  }
}

module.exports = { myPayouts, bankList, resolveBank, saveMyBank, requestMyWithdrawal, adminList, adminDetail, adminMarkPaid, adminReject };
