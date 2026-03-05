// ─────────────────────────────────────────────
// OrderBuddy — Easebuzz Payment Gateway
// Replaces Razorpay. Cheaper, India-first.
//
// ENV vars needed:
//   EASEBUZZ_KEY     → your merchant key from Easebuzz dashboard
//   EASEBUZZ_SALT    → your salt from Easebuzz dashboard
//   EASEBUZZ_ENV     → 'test' or 'production'
//   BASE_URL         → your server public URL e.g. https://yourdomain.com
// ─────────────────────────────────────────────

const crypto  = require('crypto');
const fetch   = require('node-fetch');   // npm install node-fetch@2
const db      = require('../database/db');
const billSvc = require('../services/billing');
const whatsapp = require('../services/whatsapp');
const { notificationQueue } = require('../queue/setup');

const EB_KEY  = process.env.EASEBUZZ_KEY;
const EB_SALT = process.env.EASEBUZZ_SALT;
const EB_ENV  = process.env.EASEBUZZ_ENV || 'production';

// Easebuzz base URLs
const EB_BASE     = EB_ENV === 'test' ? 'https://testpay.easebuzz.in' : 'https://pay.easebuzz.in';
const EB_API_BASE = EB_ENV === 'test' ? 'https://testdashboard.easebuzz.in' : 'https://dashboard.easebuzz.in';

// ─────────────────────────────────────────────
// HASH HELPERS
// ─────────────────────────────────────────────

/**
 * Payment initiation hash
 * Format: key|txnid|amount|productinfo|firstname|email|udf1-10|SALT
 */
function buildPaymentHash({ txnid, amount, productinfo, firstname, email,
  udf1='', udf2='', udf3='', udf4='', udf5='',
  udf6='', udf7='', udf8='', udf9='', udf10='' }) {
  const str = `${EB_KEY}|${txnid}|${amount}|${productinfo}|${firstname}|${email}|${udf1}|${udf2}|${udf3}|${udf4}|${udf5}|${udf6}|${udf7}|${udf8}|${udf9}|${udf10}|${EB_SALT}`;
  return crypto.createHash('sha512').update(str).digest('hex');
}

/**
 * Webhook response verification hash (reverse)
 * Format: SALT|status|udf10-1|email|firstname|productinfo|amount|txnid|key
 */
function buildReverseHash({ status, txnid, amount, productinfo, firstname, email,
  udf1='', udf2='', udf3='', udf4='', udf5='',
  udf6='', udf7='', udf8='', udf9='', udf10='' }) {
  const str = `${EB_SALT}|${status}|${udf10}|${udf9}|${udf8}|${udf7}|${udf6}|${udf5}|${udf4}|${udf3}|${udf2}|${udf1}|${email}|${firstname}|${productinfo}|${amount}|${txnid}|${EB_KEY}`;
  return crypto.createHash('sha512').update(str).digest('hex');
}

/**
 * Refund API hash
 * Format: key|txnid|amount|SALT
 */
function buildRefundHash({ txnid, amount }) {
  const str = `${EB_KEY}|${txnid}|${amount}|${EB_SALT}`;
  return crypto.createHash('sha512').update(str).digest('hex');
}

// ─────────────────────────────────────────────
// POST /payment/create
// Creates Easebuzz payment link → sends to customer via WhatsApp
// ─────────────────────────────────────────────
async function createPayment(req, reply) {
  try {
    const { sessionId } = req.body;

    const session = await db.queryOne('SELECT * FROM sessions WHERE id = $1', [sessionId]);
    if (!session) return reply.status(404).send({ error: 'Session not found' });

    // Generate bill
    const bill = await billSvc.generateBill(session);

    // Build unique txnid using bill number (safe, unique)
    const txnid     = `OB-${bill.bill_number}-${Date.now()}`.replace(/[^a-zA-Z0-9-_]/g, '');
    const amount    = bill.grand_total.toFixed(2);
    const firstname = (session.customer_name || 'Customer').split(' ')[0];
    const email     = `${session.customer_phone}@orderbuddy.in`; // Easebuzz requires email
    const phone     = session.customer_phone.replace(/\D/g, '').slice(-10);

    const productinfo = `Order ${bill.bill_number}`;

    // Store session_id in udf1, bill_id in udf2 for webhook lookup
    const udf1 = session.id;
    const udf2 = bill.id;

    const hash = buildPaymentHash({ txnid, amount, productinfo, firstname, email, udf1, udf2 });

    // Call Easebuzz initiate payment API
    const formData = new URLSearchParams({
      key:         EB_KEY,
      txnid,
      amount,
      productinfo,
      firstname,
      email,
      phone,
      udf1, udf2,
      udf3: '', udf4: '', udf5: '',
      udf6: '', udf7: '', udf8: '', udf9: '', udf10: '',
      hash,
      surl: `${process.env.BASE_URL}/payment/success`,
      furl: `${process.env.BASE_URL}/payment/failure`,
    });

    const initRes = await fetch(`${EB_BASE}/payment/initiateLink`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    formData.toString(),
    });

    const initData = await initRes.json();

    if (initData.status !== 1) {
      console.error('Easebuzz initiate failed:', initData);
      return reply.status(500).send({ error: initData.data || 'Payment init failed' });
    }

    const paymentUrl = initData.data; // short payment URL

    // Save txnid to bill for future refunds
    await db.query(
      `UPDATE bills
       SET easebuzz_txnid = $1, easebuzz_status = 'initiated', updated_at = NOW()
       WHERE id = $2`,
      [txnid, bill.id]
    );

    // Send payment link to customer via WhatsApp
    const discountNote = bill.discount_pct > 0
      ? `🎉 ${bill.discount_pct}% discount applied — you save ₹${bill.discount_amount}!`
      : null;

    const msg = whatsapp.notifications.paymentLink
      ? whatsapp.notifications.paymentLink(bill.grand_total, paymentUrl, discountNote)
      : `💳 Your bill is ₹${bill.grand_total}.\n\nPay here: ${paymentUrl}\n\nBill: ${bill.bill_number}`;

    await notificationQueue.add('payment-link', {
      to:      session.customer_phone,
      message: msg,
      type:    'text',
    });

    console.log(`💳 Payment link created — ${bill.bill_number} — ₹${bill.grand_total} — ${paymentUrl}`);

    return reply.send({
      success:     true,
      paymentUrl,
      amount:      bill.grand_total,
      billNumber:  bill.bill_number,
      txnid,
    });

  } catch (err) {
    console.error('Payment creation error:', err);
    return reply.status(500).send({ error: err.message });
  }
}

// ─────────────────────────────────────────────
// POST /payment/webhook
// Easebuzz calls this after payment is completed/failed
// Configure this URL in Easebuzz dashboard → Settings → Webhook
// ─────────────────────────────────────────────
async function paymentWebhook(req, reply) {
  try {
    const p = req.body;

    console.log('💳 Easebuzz webhook:', p.status, p.txnid, p.amount);

    // ── 1. Verify signature ──
    const expectedHash = buildReverseHash({
      status:      p.status,
      txnid:       p.txnid,
      amount:      p.amount,
      productinfo: p.productinfo,
      firstname:   p.firstname,
      email:       p.email,
      udf1:  p.udf1  || '',
      udf2:  p.udf2  || '',
      udf3:  p.udf3  || '',
      udf4:  p.udf4  || '',
      udf5:  p.udf5  || '',
      udf6:  p.udf6  || '',
      udf7:  p.udf7  || '',
      udf8:  p.udf8  || '',
      udf9:  p.udf9  || '',
      udf10: p.udf10 || '',
    });

    if (p.hash !== expectedHash) {
      console.error('❌ Easebuzz webhook hash mismatch');
      console.error('Received:', p.hash);
      console.error('Expected:', expectedHash);
      return reply.status(400).send('Invalid hash');
    }

    // ── 2. Handle success ──
    if (p.status === 'success') {
      const sessionId = p.udf1;
      const billId    = p.udf2;

      // Mark bill as paid
      const bill = await db.queryOne(
        `UPDATE bills
         SET status = 'paid',
             easebuzz_txnid = $1,
             easebuzz_status = 'success',
             easebuzz_payment_id = $2,
             payment_method = $3,
             paid_at = NOW()
         WHERE id = $4
         RETURNING *`,
        [p.txnid, p.easepayid || p.txnid, p.mode || 'upi', billId]
      );

      if (!bill) {
        console.error('Bill not found for txnid:', p.txnid);
        return reply.status(200).send('OK');
      }

      // Mark session as paid
      await db.query(
        "UPDATE sessions SET status = 'paid' WHERE id = $1",
        [sessionId]
      );

      // Notify customer
      const session = await db.queryOne(
        'SELECT customer_phone FROM sessions WHERE id = $1',
        [sessionId]
      );

      if (session) {
        const msg = whatsapp.notifications.paymentReceived
          ? whatsapp.notifications.paymentReceived(bill.grand_total, bill.bill_number)
          : `✅ Payment of ₹${bill.grand_total} received!\nBill: ${bill.bill_number}\nThank you! 🙏`;

        await notificationQueue.add('payment-confirmed', {
          to:      session.customer_phone,
          message: msg,
          type:    'text',
        });
      }

      console.log(`✅ Payment confirmed — ${bill.bill_number} — ₹${bill.grand_total}`);

    } else if (p.status === 'failure' || p.status === 'dropped') {
      // Mark as failed
      await db.query(
        `UPDATE bills
         SET easebuzz_txnid = $1, easebuzz_status = $2
         WHERE id = $3`,
        [p.txnid, p.status, p.udf2]
      );

      console.log(`❌ Payment ${p.status} — txnid: ${p.txnid}`);
    }

    return reply.status(200).send('OK');

  } catch (err) {
    console.error('Payment webhook error:', err);
    return reply.status(500).send('Error');
  }
}

// ─────────────────────────────────────────────
// POST /payment/success & /payment/failure
// Redirect pages after customer pays (surl/furl)
// Not critical — customer already notified via webhook
// ─────────────────────────────────────────────
async function paymentSuccess(req, reply) {
  return reply.send(`
    <html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#0d0d0d;color:#fff">
      <h1 style="color:#25D366">✅ Payment Successful!</h1>
      <p>Your order is confirmed. You will receive a WhatsApp confirmation shortly.</p>
      <p style="color:#888;font-size:13px">You can close this window.</p>
    </body></html>
  `);
}

async function paymentFailure(req, reply) {
  return reply.send(`
    <html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#0d0d0d;color:#fff">
      <h1 style="color:#ff4757">❌ Payment Failed</h1>
      <p>Please try again or pay at the counter.</p>
      <p style="color:#888;font-size:13px">You can close this window.</p>
    </body></html>
  `);
}

// ─────────────────────────────────────────────
// REFUND — called from dashboard API
// Handles both Easebuzz online refund + offline cash/UPI refund
// ─────────────────────────────────────────────
async function processRefund({ billId, refundAmount, reason, restaurantId }) {

  const bill = await db.queryOne(
    `SELECT b.*, s.customer_phone, s.customer_name
     FROM bills b
     JOIN sessions s ON s.id = b.session_id
     WHERE b.id = $1 AND b.restaurant_id = $2`,
    [billId, restaurantId]
  );

  if (!bill) throw new Error('Bill not found');
  if (bill.status === 'refunded') throw new Error('Already refunded');
  if (bill.status === 'partial_refund') throw new Error('Already partially refunded — contact support for further refund');
  if (bill.status === 'unpaid' && !bill.cash_collected) {
    throw new Error('Bill not yet paid. Mark as cash collected first, then refund.');
  }

  const refAmt = parseInt(refundAmount);
  if (refAmt <= 0 || refAmt > bill.grand_total) {
    throw new Error(`Refund amount must be between ₹1 and ₹${bill.grand_total}`);
  }

  let refundMethod = 'offline'; // default — cash/UPI handled offline
  let easebuzzRefundId = null;

  // ── Try Easebuzz online refund if payment was online ──
  // Takeaway cash payments will have no easebuzz_txnid → handled as offline automatically
  if (bill.easebuzz_txnid && bill.easebuzz_status === 'success') {
    try {
      const hash = buildRefundHash({
        txnid:  bill.easebuzz_txnid,
        amount: refAmt.toFixed(2),
      });

      const formData = new URLSearchParams({
        key:           EB_KEY,
        txnid:         bill.easebuzz_txnid,
        refund_amount: refAmt.toFixed(2),
        amount:        bill.grand_total.toFixed(2),
        email:         `${bill.customer_phone}@orderbuddy.in`,
        phone:         bill.customer_phone.replace(/\D/g, '').slice(-10),
        hash,
      });

      const refundRes = await fetch(`${EB_API_BASE}/transaction/v1/refund`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    formData.toString(),
      });

      const refundData = await refundRes.json();
      console.log('Easebuzz refund response:', refundData);

      if (refundData.status === 1) {
        refundMethod   = 'easebuzz';
        easebuzzRefundId = refundData.data?.refund_id || bill.easebuzz_txnid;
      } else {
        // Easebuzz refund failed — log and fall through to offline
        console.error('Easebuzz refund API failed:', refundData);
        throw new Error(`Easebuzz refund failed: ${refundData.data || 'Unknown error'}. Process manually.`);
      }

    } catch (e) {
      // Re-throw with context
      throw new Error(e.message);
    }
  }

  // ── Update bill in DB ──
  const isFullRefund = refAmt === bill.grand_total;

  await db.query(
    `UPDATE bills
     SET status = $1,
         refund_amount = $2,
         refund_reason = $3,
         refund_method = $4,
         easebuzz_refund_id = $5,
         refunded_at = NOW()
     WHERE id = $6`,
    [
      isFullRefund ? 'refunded' : 'partial_refund',
      refAmt,
      reason || 'Refund initiated by owner',
      refundMethod,
      easebuzzRefundId,
      billId,
    ]
  );

  // ── Notify customer via WhatsApp ──
  if (bill.customer_phone) {
    const timeframe = refundMethod === 'easebuzz'
      ? '5-7 business days to your original payment method'
      : 'at the counter / via UPI (offline)';

    const msg = `💰 *Refund Update — ${bill.bill_number}*\n\n` +
      `Refund of ₹${refAmt} has been ${refundMethod === 'easebuzz' ? 'initiated' : 'approved'}.\n` +
      `Reason: ${reason || 'Order issue'}\n` +
      `You will receive the amount in ${timeframe}.\n\n` +
      `Sorry for the inconvenience! 🙏`;

    await notificationQueue.add('refund-notification', {
      to:      bill.customer_phone,
      message: msg,
      type:    'text',
    });
  }

  return {
    success:      true,
    refundMethod,
    refundAmount: refAmt,
    billNumber:   bill.bill_number,
    message:      refundMethod === 'easebuzz'
      ? `Online refund of ₹${refAmt} initiated. Customer will receive in 5-7 days.`
      : `Offline refund of ₹${refAmt} marked. Please process manually via cash/UPI.`,
  };
}

module.exports = { createPayment, paymentWebhook, paymentSuccess, paymentFailure, processRefund };

