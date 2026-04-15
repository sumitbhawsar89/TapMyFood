// ─────────────────────────────────────────────
// OrderBuddy — Paytm PG Adapter
// src/services/adapters/paytm-adapter.js
//
// Implements common adapter interface:
//   initiate(params)      → { payment_url, gateway_order_id, txn_token }
//   handleWebhook(body)   → normalized result
//
// ENV VARS (set in .env when MID received):
//   PAYTM_ENV=test           'test' or 'production'
//
// Config from restaurant_settings.payment_gateway_config:
//   mid        Merchant ID
//   key        Merchant secret key
//   website    DEFAULT (prod) or WEBSTAGING (test)
//   vpa        Restaurant Paytm UPI ID (for split settlement)
//
// Split settlement (Paytm Route):
//   Platform fee (₹3) → BazaarAI Paytm account
//   Rest → restaurant's Paytm account
//   Requires Paytm Route enabled on merchant account
//   Optional — works without it (manual invoice fallback)
// ─────────────────────────────────────────────
const https  = require('https');
const PAYTM_ENV = process.env.PAYTM_ENV || 'test';
const BAZAARAI_VPA = process.env.PAYTM_BAZAARAI_VPA; // our platform fee VPA

const PAYTM_HOST = PAYTM_ENV === 'production'
  ? 'securegw.paytm.in'
  : 'securegw-stage.paytm.in';

// ─────────────────────────────────────────────
// Initiate Paytm transaction
// ─────────────────────────────────────────────
async function initiate({ config, orderId, amount, customerPhone, callbackUrl, sessionId, billId }) {
  const { mid, key, website = 'WEBSTAGING' } = config;

  if (!mid || !key) {
    throw new Error('Paytm MID not configured. Add mid and key to payment_gateway_config.');
  }

  const PaytmChecksum = require('paytmchecksum');
  const amountStr = (amount / 100).toFixed(2); // paise → rupees

  const paytmParams = {
    body: {
      requestType:   'Payment',
      mid,
      websiteName:   website,
      orderId,
      callbackUrl,
      txnAmount: {
        value:    amountStr,
        currency: 'INR',
      },
      userInfo: {
        custId: customerPhone,
        mobile: customerPhone.replace(/\D/g, '').slice(-10),
      },
      extendInfo: {
        udf1: sessionId,
        udf2: billId,
      },
    }
  };

  // Add Paytm Route split if both VPAs are configured
  // Platform fee = ₹3 (300 paise)
  if (BAZAARAI_VPA && config.vpa && amount > 300) {
    const platformFeeRupees = '3.00';
    const restaurantRupees  = ((amount - 300) / 100).toFixed(2);

    paytmParams.body.splitSettlementInfo = {
      splitType: 'AMOUNT',
      splitList: [
        {
          vpa:            config.vpa,         // restaurant VPA
          amount:         restaurantRupees,
          settlementType: 'NET_DEBIT',
        },
        {
          vpa:            BAZAARAI_VPA,        // BazaarAI platform fee
          amount:         platformFeeRupees,
          settlementType: 'NET_DEBIT',
        }
      ]
    };
  }

  // Generate checksum
  const checksum = await PaytmChecksum.generateSignature(
    JSON.stringify(paytmParams.body),
    key
  );
  paytmParams.head = { signature: checksum };

  // Call Paytm initiate API
  const response = await callPaytmAPI(
    `/theia/api/v1/initiateTransaction?mid=${mid}&orderId=${orderId}`,
    paytmParams
  );

  if (!response?.body?.txnToken) {
    throw new Error(`Paytm initiation failed: ${JSON.stringify(response?.body)}`);
  }

  const payment_url = `https://${PAYTM_HOST}/theia/api/v1/showPaymentPage?mid=${mid}&orderId=${orderId}`;

  return {
    payment_url,
    gateway_order_id: orderId,
    txn_token:        response.body.txnToken,
  };
}

// ─────────────────────────────────────────────
// Handle Paytm webhook
// Returns normalized result
// ─────────────────────────────────────────────
async function handleWebhook(body) {
  const { ORDERID, STATUS, TXNAMOUNT, TXNID, CHECKSUMHASH, PAYMENTMODE } = body;

  if (!ORDERID || !STATUS) {
    return null;
  }

  // Verify checksum
  // Need the merchant key for this restaurant
  // Look up by gateway_order_id
  const db = require('../database/db');
  const bill = await db.queryOne(
    `SELECT b.restaurant_id FROM bills b
     WHERE b.gateway_order_id = $1`,
    [ORDERID]
  );

  if (bill) {
    const configRow = await db.queryOne(
      `SELECT value FROM restaurant_settings
       WHERE restaurant_id = $1 AND key = 'payment_gateway_config'`,
      [bill.restaurant_id]
    );

    if (configRow?.value) {
      try {
        const config = JSON.parse(configRow.value);
        if (config.key) {
          const PaytmChecksum = require('paytmchecksum');
          const isValid = await PaytmChecksum.verifySignature(
            JSON.stringify(body),
            config.key,
            CHECKSUMHASH
          );
          if (!isValid) {
            console.error('❌ Paytm webhook checksum mismatch for order:', ORDERID);
            return null;
          }
        }
      } catch {}
    }
  }

  // Normalize payment method
  const methodMap = {
    'UPI':         'upi',
    'CC':          'card',
    'DC':          'card',
    'NB':          'netbanking',
    'PPI':         'wallet',
    'PAYTMDIGITAL': 'wallet',
  };

  return {
    gateway_order_id: ORDERID,
    gateway_txn_id:   TXNID || null,
    amount:           parseFloat(TXNAMOUNT || 0),
    status:           STATUS === 'TXN_SUCCESS' ? 'success'
                    : STATUS === 'TXN_FAILURE' ? 'failed'
                    : 'pending',
    method:           methodMap[PAYMENTMODE] || 'upi',
    raw:              body,
  };
}

// ─────────────────────────────────────────────
// Helper: call Paytm HTTPS API
// ─────────────────────────────────────────────
function callPaytmAPI(path, params) {
  return new Promise((resolve, reject) => {
    const post_data = JSON.stringify(params);
    const options = {
      hostname: PAYTM_HOST,
      port:     443,
      path,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(post_data),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try   { resolve(JSON.parse(data)); }
        catch { reject(new Error('Paytm API parse error: ' + data)); }
      });
    });
    req.on('error', reject);
    req.write(post_data);
    req.end();
  });
}

module.exports = { initiate, handleWebhook };

