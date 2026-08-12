(function () {
  'use strict';

  const PENDING_KEY = 'dcKidsPendingPaystackCheckout';
  const CART_KEY = 'dcKidsCart';
  const params = new URLSearchParams(window.location.search);
  let pending = null;
  try { pending = JSON.parse(localStorage.getItem(PENDING_KEY) || 'null'); } catch (error) { pending = null; }
  const reference = params.get('reference') || params.get('trxref') || (pending && pending.reference) || '';
  const card = document.getElementById('paymentResultCard');
  const announcement = document.getElementById('paymentResultAnnouncement');
  const title = document.getElementById('paymentResultTitle');
  const message = document.getElementById('paymentResultMessage');
  const icon = document.getElementById('paymentResultIcon');
  const details = document.getElementById('paymentResultDetails');
  const order = document.getElementById('paymentResultOrder');
  const status = document.getElementById('paymentResultStatus');
  const referenceValue = document.getElementById('paymentResultReference');
  const retryButton = document.getElementById('paymentRetryButton');
  const supportLink = document.getElementById('paymentSupportLink');

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
    card.setAttribute('aria-busy', 'false');
    announcement.setAttribute('role', kind === 'failed' ? 'alert' : 'status');
    announcement.setAttribute('aria-live', kind === 'failed' ? 'assertive' : 'polite');
    title.textContent = heading;
    message.textContent = copy;
    icon.innerHTML = kind === 'paid'
      ? '<svg viewBox="0 0 24 24"><path d="m5 12 4 4L19 6"/></svg>'
      : kind === 'failed'
        ? '<svg viewBox="0 0 24 24"><path d="M12 8v5M12 17h.01"/><circle cx="12" cy="12" r="9"/></svg>'
        : '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
    retryButton.hidden = kind !== 'pending';
    if (data || reference) {
      details.hidden = false;
      order.textContent = (data && data.order_number) || (pending && pending.order_number) || 'Not available';
      status.textContent = String((data && (data.order_status || data.payment_status)) || kind).replace(/_/g, ' ');
      referenceValue.textContent = reference || 'Not available';
    }
    const supportMessage = encodeURIComponent('Hi DC Kids, I need help confirming Paystack payment ' + (reference || '(reference unavailable)') + '.');
    supportLink.href = 'https://wa.me/233549193805?text=' + supportMessage;
    card.focus({ preventScroll: true });
  }

  function showChecking(manual) {
    document.body.dataset.paymentState = 'checking';
    card.setAttribute('aria-busy', 'true');
    announcement.setAttribute('role', 'status');
    announcement.setAttribute('aria-live', 'polite');
    title.textContent = manual ? 'Checking your payment again' : 'Confirming your payment';
    message.textContent = 'Please keep this page open while we securely check the transaction with Paystack.';
    icon.innerHTML = '<span class="payment-result-spinner"></span>';
    retryButton.hidden = true;
  }

  async function confirmPayment(attempt, manual = false) {
    if (!/^DCK-[0-9]+-[a-f0-9]{20}$/i.test(reference)) {
      showState('failed', 'We could not find this payment', 'The Paystack reference is missing or incomplete. Return to the shop or contact support. Your cart has not been changed.');
      return;
    }
    if (attempt === 0) showChecking(manual);
    try {
      const response = await fetch('/api/payments/paystack/status/' + encodeURIComponent(reference), { cache: 'no-store' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const requestError = new Error(data.error || 'Payment status is unavailable');
        requestError.status = response.status;
        throw requestError;
      }
      if (data.payment_status === 'paid' || data.order_status === 'paid') {
        if (pending && pending.reference === reference) removePurchasedItems(pending.items || []);
        localStorage.removeItem(PENDING_KEY);
        showState('paid', 'Payment confirmed', 'Thank you. Your order is paid and has been sent to DC Kids for fulfilment.', data);
        return;
      }
      if (['failed', 'review'].includes(data.payment_status) || ['payment_failed', 'payment_review'].includes(data.order_status)) {
        localStorage.removeItem(PENDING_KEY);
        showState('failed', 'Payment needs attention', 'Your cart is still intact. Contact DC Kids with the reference below before starting another payment.', data);
        return;
      }
      if (!manual && attempt < 5) {
        window.setTimeout(() => confirmPayment(attempt + 1, false), 2000);
      } else {
        showState('pending', 'Payment is still being confirmed', 'The order remains pending. You can safely return later; we will not clear your cart until payment is verified.', data);
      }
    } catch (error) {
      if (!manual && attempt < 2) return window.setTimeout(() => confirmPayment(attempt + 1, false), 2000);
      if (!navigator.onLine || error instanceof TypeError) {
        showState('pending', 'You appear to be offline', 'Reconnect, then use Check again. Your cart remains unchanged until payment is verified.');
      } else if (error.status === 429) {
        showState('pending', 'Payment checks are temporarily limited', 'Wait a moment, then use Check again. Your cart remains safe.');
      } else {
        showState('pending', 'Confirmation is taking longer than expected', 'Your cart is safe. Use Check again, view your account later, or contact DC Kids with the reference below.');
      }
    }
  }

  retryButton.addEventListener('click', () => confirmPayment(0, true));
  window.addEventListener('online', () => {
    if (document.body.dataset.paymentState === 'pending') retryButton.disabled = false;
  });
  window.addEventListener('offline', () => {
    retryButton.disabled = true;
    if (document.body.dataset.paymentState === 'checking') {
      showState('pending', 'You are offline', 'Reconnect, then use Check again. Your cart remains unchanged until payment is verified.');
    }
  });
  confirmPayment(0, false);
})();
