const axios = require('axios');

const BASE_URL        = 'https://graph.facebook.com/v19.0';
const PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID;
const ACCESS_TOKEN    = process.env.META_ACCESS_TOKEN;

async function sendMessage(to, message) {
  try {
    const response = await axios.post(
      `${BASE_URL}/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type:    'individual',
        to,
        type: 'text',
        text: { body: message, preview_url: false }
      },
      { headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' } }
    );
    return response.data;
  } catch (err) {
    const errCode = err.response?.data?.error?.code;
    if (errCode === 131056) {
      console.warn('⚠️ Rate limit hit — retrying in 4s...');
      await new Promise(r => setTimeout(r, 4000));
      try {
        const retry = await axios.post(url, body, { headers });
        return retry.data;
      } catch (retryErr) {
        console.error('WhatsApp retry failed:', retryErr.response?.data || retryErr.message);
        return null;
      }
    }
    console.error('WhatsApp send error:', err.response?.data || err.message);
    throw err;
  }
}

async function sendInteractiveButtons(to, bodyText, buttons) {
  try {
    const response = await axios.post(
      `${BASE_URL}/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type:    'individual',
        to,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: bodyText },
          action: {
            buttons: buttons.slice(0, 3).map(btn => ({
              type:  'reply',
              reply: {
                id:    btn.id,
                title: btn.title.length > 20 ? btn.title.substring(0, 19) + '…' : btn.title
              }
            }))
          }
        }
      },
      { headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' } }
    );
    return response.data;
  } catch (err) {
    const errCode = err.response?.data?.error?.code;
    if (errCode === 131056) {
      console.warn('⚠️ Rate limit (interactive) — retrying in 4s...');
      await new Promise(r => setTimeout(r, 4000));
      try {
        const retry = await axios.post(url, body, { headers });
        return retry.data;
      } catch (retryErr) {
        console.error('WhatsApp interactive retry failed:', retryErr.response?.data || retryErr.message);
        return null;
      }
    }
    console.error('WhatsApp interactive error:', err.response?.data || err.message);
    // Retry with truncated titles (often the root cause)
    try {
      const truncatedButtons = buttons.slice(0, 3).map(btn => ({
        type:  'reply',
        reply: {
          id:    btn.id,
          title: btn.title.substring(0, 20)
        }
      }));
      const retry = await axios.post(
        `${BASE_URL}/${PHONE_NUMBER_ID}/messages`,
        {
          messaging_product: 'whatsapp',
          recipient_type:    'individual',
          to,
          type: 'interactive',
          interactive: {
            type:   'button',
            body:   { text: bodyText.substring(0, 1024) },
            action: { buttons: truncatedButtons }
          }
        },
        { headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' } }
      );
      return retry.data;
    } catch (retryErr) {
      // Last resort: send as plain text only
      await sendMessage(to, bodyText);
    }
  }
}

async function sendOrderConfirmation(to, cartSummary, subtotal) {
  const bodyText =
    `🛒 *Order Summary*\n\n${cartSummary}\n*Subtotal: ₹${subtotal}*\n_(+taxes if applicable)_\n\nReady to place your order?`;

  await sendInteractiveButtons(to, bodyText, [
    { id: 'confirm_order', title: 'Confirm Order' },
    { id: 'cancel_order',  title: 'Cancel'        },
  ]);
}

async function sendAddressRequest(to) {
  await sendMessage(to,
    `📍 *Delivery Address*\n\n` +
    `You can share your address in *2 ways*:\n\n` +
    `*Option 1 — Share Location Pin* 📍 (Recommended)\n` +
    `Tap the 📎 attachment icon → Location → Send Current Location\n` +
    `(Accurate, helps delivery reach you faster!)\n\n` +
    `*Option 2 — Type Address* ✏️\n` +
    `Example: Flat 201, Sunshine Apts, MG Road, Pune 411001`
  );
}

async function sendDocument(to, documentUrl, filename, caption) {
  try {
    const response = await axios.post(
      `${BASE_URL}/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type:    'individual',
        to,
        type: 'document',
        document: { link: documentUrl, filename, caption: caption || '' }
      },
      { headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' } }
    );
    return response.data;
  } catch (err) {
    console.error('WhatsApp document error:', err.response?.data || err.message);
    throw err;
  }
}

const notifications = {
  orderConfirmed:     (name) => `✅ Order confirmed! ${name} is preparing your order!`,
  orderPreparing:     (name) => `🍳 Being prepared at ${name}. Sit tight!`,
  takeawayReady:      (name) => `🍱 Ready for pickup at ${name}!`,
  takeawayHandedOver: ()     => `✅ Enjoy your meal! Thanks for choosing us 🙏`,
  outForDelivery:     ()     => `🛵 Your order is on its way!`,
  delivered:          (name) => `🎉 Delivered! Enjoy your meal from ${name} 😊`,
  paymentReceived: (amount, billNo) =>
    `✅ Payment of ₹${amount} received! Bill No: ${billNo}. Thank you! 🙏`,
  paymentLink: (amount, link, discountNote) => {
    let msg = `💳 *Bill Ready!*\n\nTotal: ₹${amount}\n`;
    if (discountNote) msg += `${discountNote}\n`;
    msg += `\nPay securely 👇\n${link}\n\n_UPI / Card / Net Banking_`;
    return msg;
  },
};

// ── Send WhatsApp List Message (for menus with many items) ──
async function sendListMessage(to, bodyText, buttonLabel, sections) {
  try {
    const response = await axios.post(
      `${BASE_URL}/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type:    'individual',
        to,
        type: 'interactive',
        interactive: {
          type: 'list',
          body: { text: bodyText.substring(0, 1024) },
          action: {
            button:   buttonLabel.substring(0, 20),
            sections: sections.map(section => ({
              title: (section.title || 'Menu').substring(0, 24),
              rows:  section.rows.slice(0, 10).map(row => ({
                id:          row.id.substring(0, 200),
                title:       row.title.substring(0, 24),
                description: (row.description || '').substring(0, 72),
              }))
            }))
          }
        }
      },
      { headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' } }
    );
    return response.data;
  } catch (err) {
    console.error('WhatsApp list message error:', err.response?.data || err.message);
    // Fallback: send as text
    let text = bodyText + '\n\n';
    for (const section of sections) {
      for (const row of section.rows) {
        text += `• ${row.title}${row.description ? ' — ' + row.description : ''}\n`;
      }
    }
    await sendMessage(to, text.trim());
  }
}


module.exports = {
  sendMessage,
  sendInteractiveButtons,
  sendListMessage,
  sendOrderConfirmation,
  sendAddressRequest,
  sendDocument,
  notifications,
};


// Rate limit retry wrapper — auto-applied globally
const _origSend = module.exports.sendMessage?.bind(module.exports);
