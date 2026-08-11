(function () {
  'use strict';

  const PENDING_KEY = 'dcKidsPendingPaystackCheckout';
  const CART_KEY = 'dcKidsCart';
  const params = new URLSearchParams(window.location.search);
  let pending = null;
  try { pending = JSON.parse(localStorage.getItem(PENDING_KEY) || 'null'); } catch (error) { pending = null; }
  const reference = params.get('reference') || params.get('trxref') || (pending && pending.reference) || '';
  const title = document.getElementById('paymentResultTitle');
  const message = document.getElementById('paymentResultMessage');
  const icon = document.getElementById('paymentResultIcon');
  const details = document.getElementById('paymentResultDetails');
  const order = document.getElementById('paymentResultOrder');
  const status = document.getElementById('paymentResultStatus');

  function removePurchasedItems(items) {
    let cart = [];
    try { cart = JSON.parse(localStorage.getItem(CART_KEY) || '[]'); } catch (error) { cart = []; }
    (items || []).forEach((purchased) => {
      const match = cart.find((item) => Number(item.id) === Number(purchased.id) &&
        String(item.size || '') === String(purchased.size || '') && Number(item.ws || 0) === Number(purchased.ws || 0));
      if (match) match.qty = Math.max(0, Number(match.qty || 0) - Number(purchased.qty || 0));
    });
    localStorage.setItem(CART_KEY, JSON.stringify(cart.filter((item) => Number(item.qty || 0) > 0)));
  }

  function showState(kind, heading, copy, data) {
    document.body.dataset.paymentState = kind;
    title.textContent = heading;
    message.textContent = copy;
    icon.innerHTML = kind === 'paid'
      ? '<svg viewBox="0 0 24 24"><path d="m5 12 4 4L19 6"/></svg>'
      : kind === 'failed'
        ? '<svg viewBox="0 0 24 24"><path d="M12 8v5M12 17h.01"/><circle cx="12" cy="12" r="9"/></svg>'
        : '<span class="payment-result-spinner"></span>';
    if (data) {
      details.hidden = false;
      order.textContent = data.order_number || (pending && pending.order_number) || '—';
      status.textContent = String(data.order_status || data.payment_status || 'pending').replace(/_/g, ' ');
    }
  }

  async function confirmPayment(attempt) {
    if (!/^DCK-[0-9]+-[a-f0-9]{20}$/i.test(reference)) {
      showState('failed', 'We could not find this payment', 'Return to the shop and try again. Your cart has not been changed.');
      return;
    }
    try {
      const response = await fetch('/api/payments/paystack/status/' + encodeURIComponent(reference), { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Payment status is unavailable');
      if (data.payment_status === 'paid' || data.order_status === 'paid') {
        if (pending && pending.reference === reference) removePurchasedItems(pending.items || []);
        localStorage.removeItem(PENDING_KEY);
        showState('paid', 'Payment confirmed', 'Thank you. Your order is paid and has been sent to DC Kids for fulfilment.', data);
        return;
      }
      if (['failed', 'review'].includes(data.payment_status) || ['payment_failed', 'payment_review'].includes(data.order_status)) {
        localStorage.removeItem(PENDING_KEY);
        showState('failed', 'Payment needs attention', 'Your cart is still intact. Please return to the shop or contact DC Kids before trying again.', data);
        return;
      }
      if (attempt < 5) {
        window.setTimeout(() => confirmPayment(attempt + 1), 2000);
      } else {
        showState('pending', 'Payment is still being confirmed', 'The order remains pending. You can safely return later; we will not clear your cart until payment is verified.', data);
      }
    } catch (error) {
      if (attempt < 2) return window.setTimeout(() => confirmPayment(attempt + 1), 2000);
      showState('pending', 'Confirmation is taking longer than expected', 'Your cart is safe. Check your account later or contact DC Kids with your Paystack reference.');
    }
  }

  confirmPayment(0);
})();
