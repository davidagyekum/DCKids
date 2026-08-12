(function () {
  'use strict';

  const CART_KEY = 'dcKidsCart';
  const WISHLIST_KEY = 'dcKidsGuestWishlist';
  const CATEGORY_LABELS = {
    newborn: 'Newborn', clothing: 'Kids Clothing', shoes: 'Footwear', footwear: 'Footwear',
    feeding: 'Feeding & Bottles', gear: 'Baby Gear', bathcare: 'Bath & Care',
    bedding: 'Bedding', essentials: 'Essentials', accessories: 'Accessories'
  };
  const FALLBACK_DESCRIPTION = 'Product information will be updated soon. Ask us on WhatsApp for fabric and fit details.';

  const state = {
    product: null,
    products: [],
    settings: {},
    reviews: { summary: { count: 0, average: 0 }, reviews: [] },
    selectedSize: '',
    selectedRating: 0,
    mode: localStorage.getItem('storeMode') || 'retail',
    cart: readArray(CART_KEY),
    wishlist: new Set(readArray(WISHLIST_KEY).map(Number)),
    auth: { user: null, customer: null }
  };

  const byId = (id) => document.getElementById(id);
  const escapeHtml = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const money = (value) => `GH₵ ${Number(value || 0).toFixed(2)}`;

  function readArray(key) {
    try {
      const value = JSON.parse(localStorage.getItem(key) || '[]');
      return Array.isArray(value) ? value : [];
    } catch (error) {
      return [];
    }
  }

  function saveCart() {
    localStorage.setItem(CART_KEY, JSON.stringify(state.cart));
    renderCart();
  }

  function showToast(message, kind) {
    const toast = byId('productToast');
    toast.textContent = message;
    toast.classList.toggle('is-error', kind === 'error');
    toast.hidden = false;
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => { toast.hidden = true; }, 2800);
  }

  function categoryLabel(category) {
    return CATEGORY_LABELS[String(category || '').toLowerCase()] || String(category || 'Products').replace(/(^|\s)\S/g, (letter) => letter.toUpperCase());
  }

  function normalizeProduct(product) {
    if (!product) return null;
    const next = Object.assign({}, product);
    if (next.cat === 'baby') next.cat = 'newborn';
    if (next.cat === 'bags') next.cat = 'accessories';
    next.id = Number(next.id);
    next.price = Number(next.price || 0);
    next.stock = Number(next.stock || 0);
    return next;
  }

  function parseSize(value) {
    const input = String(value || '').trim();
    if (!input) return ['One Size'];
    let match = input.match(/Size\s*(\d+)\s*[-–]\s*(\d+)/i);
    if (match) return range(Number(match[1]), Number(match[2])).map(String);
    match = input.match(/(\d+)Y\s*[-–]\s*(\d+)Y/i);
    if (match) return range(Number(match[1]), Number(match[2])).map((size) => `${size}Y`);
    match = input.match(/0\s*[-–]\s*(\d+)M/i);
    if (match) return Number(match[1]) <= 12 ? ['0-3M', '3-6M', '6-9M', '9-12M'] : ['0-3M', '3-6M', '6-9M', '9-12M', '12-18M'];
    match = input.match(/(\d+)M\s*[-–]\s*(\d+)M/i);
    if (match) return [3, 6, 9, 12, 18, 24].filter((month) => month >= Number(match[1]) && month <= Number(match[2])).map((month) => `${month}M`);
    return [input];
  }

  function range(start, end) {
    return Array.from({ length: Math.max(0, end - start + 1) }, (_, index) => start + index);
  }

  function getManagedSizes(product) {
    if (!product || !product.sizes) return null;
    try {
      const sizes = typeof product.sizes === 'string' ? JSON.parse(product.sizes) : product.sizes;
      return Array.isArray(sizes) && sizes.length ? sizes : null;
    } catch (error) {
      return null;
    }
  }

  function getSizes(product) {
    const managed = getManagedSizes(product);
    return managed ? managed.map((size) => String(size.label)) : parseSize(product.size);
  }

  function getPriceModifier(sizeLabel) {
    const size = String(sizeLabel || '').trim();
    if (/^(0-3M|3-6M|6-9M|9-12M|12-18M|0M|3M|6M|9M|12M|14|15|16|17|18|19|20|21)$/i.test(size)) return 0;
    if (/^(18M|24M|1Y|2Y|22|23|24|25|26|27)$/i.test(size)) return 5;
    if (/^(3Y|4Y|28|29|30|31|32|33|34)$/i.test(size)) return 10;
    if (/^(5Y|6Y|7Y|35|36)$/i.test(size)) return 15;
    if (/^(8Y|9Y|10Y|11Y|12Y)$/i.test(size)) return 20;
    return 0;
  }

  function unitPrice(product, sizeLabel) {
    const managed = getManagedSizes(product);
    let price;
    if (managed) {
      const match = managed.find((size) => String(size.label) === String(sizeLabel)) || managed[0];
      price = match && match.price != null ? Number(match.price) : Number(product.price || 0);
    } else {
      price = Number(product.price || 0);
      if (price) price += getPriceModifier(sizeLabel);
    }
    if (state.mode === 'wholesale' && Number(state.settings.wholesale_discount || 0) > 0) {
      price *= 1 - (Number(state.settings.wholesale_discount) / 100);
    }
    return Math.round(price * 100) / 100;
  }

  function resolveImage(product) {
    if (window.DCImageResolver) return window.DCImageResolver.resolve(product);
    return { src: product && product.img ? product.img : 'images/placeholder.svg', isCategoryFallback: false };
  }

  function useFallback(image, category) {
    image.onerror = null;
    const resolved = resolveImage({ img: '', cat: category });
    image.src = resolved.src || 'images/placeholder.svg';
  }

  function starText(rating) {
    const filled = Math.max(0, Math.min(5, Math.round(Number(rating || 0))));
    return '★'.repeat(filled) + '☆'.repeat(5 - filled);
  }

  async function getJson(url, fallback) {
    try {
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) return fallback;
      return await response.json();
    } catch (error) {
      return fallback;
    }
  }

  async function loadProduct(productId) {
    const [settings, detail, catalogue, reviews] = await Promise.all([
      getJson('/api/settings', {}),
      getJson(`/api/products/${productId}`, null),
      getJson('/api/products', null),
      getJson(`/api/products/${productId}/reviews`, { summary: { count: 0, average: 0 }, reviews: [] })
    ]);
    state.settings = settings || {};
    if (!state.settings.wholesale_enabled && state.mode === 'wholesale') state.mode = 'retail';

    let product = detail;
    let products = Array.isArray(catalogue) ? catalogue : [];
    if (!product && products.length) product = products.find((item) => Number(item.id) === productId);
    if (!products.length) {
      products = await getJson('/products.json', []);
      if (!product) product = products.find((item) => Number(item.id) === productId);
    }
    state.product = normalizeProduct(product);
    state.products = products.map(normalizeProduct).filter(Boolean);
    state.reviews = reviews && reviews.summary ? reviews : { summary: { count: 0, average: 0 }, reviews: [] };
  }

  function renderProduct() {
    const product = state.product;
    byId('productMobileBuybar').hidden = false;
    const sizes = getSizes(product);
    state.selectedSize = sizes[0] || 'One Size';
    const category = categoryLabel(product.cat);
    const title = `${product.name} — DC Kids Brand`;
    document.title = title;
    document.querySelector('meta[name="description"]').content = String(product.description || FALLBACK_DESCRIPTION).slice(0, 155);
    const canonical = document.querySelector('link[rel="canonical"]');
    canonical.href = `${window.location.origin}/product.html?id=${encodeURIComponent(product.id)}`;

    byId('productBreadcrumb').innerHTML = `<a href="/index.html#shop">Shop</a> / <a href="/index.html?category=${encodeURIComponent(product.cat || '')}#shop">${escapeHtml(category)}</a>`;
    byId('productName').textContent = product.name;
    byId('productDescription').textContent = String(product.description || '').trim() || FALLBACK_DESCRIPTION;
    byId('productSizes').innerHTML = sizes.map((size, index) => `<button class="product-size-button${index === 0 ? ' is-active' : ''}" type="button" data-size="${escapeHtml(size)}" aria-pressed="${index === 0}">${escapeHtml(size)}</button>`).join('');
    byId('productSizeBlock').hidden = sizes.length === 1 && sizes[0] === 'One Size';
    byId('selectedSizeText').textContent = state.selectedSize;

    renderGallery();
    renderPriceAndStock();
    renderDetails();
    renderReviews();
    renderRelated();
    updateWishlistButtons();
    updateWhatsAppLink();
    installProductJsonLd();
  }

  function renderGallery() {
    const product = state.product;
    const resolved = resolveImage(product);
    const gallery = Array.isArray(product.images) ? product.images : [];
    const images = [resolved.src].concat(gallery.filter(Boolean)).filter((src, index, all) => all.indexOf(src) === index);
    const main = byId('productMainImage');
    main.src = images[0] || 'images/placeholder.svg';
    main.alt = product.name;
    main.onerror = () => useFallback(main, product.cat);
    byId('productImageLabel').hidden = !resolved.isCategoryFallback;
    byId('productThumbnails').innerHTML = images.map((src, index) => `<button class="product-thumbnail${index === 0 ? ' is-active' : ''}" type="button" data-image="${escapeHtml(src)}" aria-label="View image ${index + 1}" aria-pressed="${index === 0}"><img src="${escapeHtml(src)}" alt="" loading="lazy"></button>`).join('');
    byId('productThumbnails').hidden = images.length < 2;
    byId('productThumbnails').querySelectorAll('img').forEach((image) => { image.onerror = () => useFallback(image, product.cat); });
  }

  function renderPriceAndStock() {
    const product = state.product;
    const price = unitPrice(product, state.selectedSize);
    const quantity = validQuantity();
    const total = price * quantity;
    const priceElement = byId('productPrice');
    const addButton = byId('productAddToCart');
    const addLabel = addButton.querySelector('span');
    const mobilePrice = byId('productMobilePrice');
    const mobileAdd = byId('productMobileAdd');
    if (price > 0) {
      priceElement.innerHTML = state.mode === 'wholesale'
        ? `${money(total)}<small>${quantity} pieces at ${money(price)} each · wholesale</small>`
        : money(price);
    } else {
      priceElement.textContent = 'Price on request';
    }

    const isPreorder = product.fulfillment_type === 'preorder';
    const soldOut = !isPreorder && product.stock <= 0;
    const stock = byId('productStock');
    stock.className = 'product-stock';
    if (soldOut) {
      stock.textContent = 'Currently out of stock';
      stock.classList.add('is-out');
    } else if (isPreorder) {
      stock.textContent = 'Available by pre-order';
    } else if (product.stock <= 5) {
      stock.textContent = `Only ${product.stock} left`;
      stock.classList.add('is-low');
    } else {
      stock.textContent = 'In stock';
    }
    byId('assuranceStock').textContent = soldOut ? 'Ask us when this item will return' : (isPreorder ? 'Pre-order item' : 'Available to order');
    addButton.disabled = soldOut || price <= 0;
    addLabel.textContent = soldOut ? 'Out of stock' : (price <= 0 ? 'Ask for price on WhatsApp' : (state.mode === 'wholesale' ? 'Add bulk to cart' : 'Add to cart'));
    mobilePrice.textContent = price > 0 ? money(total) : 'Price on request';
    mobileAdd.disabled = addButton.disabled;
    mobileAdd.textContent = addLabel.textContent;
  }

  function renderDetails() {
    const product = state.product;
    const details = [
      ['SKU', product.sku || 'Not assigned'],
      ['Category', categoryLabel(product.cat)],
      ['Availability', product.fulfillment_type === 'preorder' ? 'Pre-order' : (product.stock > 0 ? `${product.stock} in stock` : 'Out of stock')],
      ['Fulfilment', product.fulfillment_type === 'preorder' ? 'China pre-order' : 'In-stock order']
    ];
    byId('productDetails').innerHTML = details.map(([term, value]) => `<dt>${escapeHtml(term)}</dt><dd>${escapeHtml(value)}</dd>`).join('');
    const moq = Math.max(1, Number(state.settings.wholesale_moq || 10));
    const quantity = byId('productQuantity');
    quantity.min = state.mode === 'wholesale' ? String(moq) : '1';
    quantity.step = state.mode === 'wholesale' ? String(moq) : '1';
    quantity.value = state.mode === 'wholesale' ? String(moq) : '1';
    byId('quantityHint').textContent = state.mode === 'wholesale'
      ? `Wholesale mode · minimum ${moq} pieces${state.settings.wholesale_discount ? ` · ${Number(state.settings.wholesale_discount)}% discount applied` : ''}`
      : '';
  }

  function renderReviews() {
    const summary = state.reviews.summary || { count: 0, average: 0 };
    const reviews = Array.isArray(state.reviews.reviews) ? state.reviews.reviews : [];
    const countLabel = summary.count === 1 ? '1 review' : `${summary.count || 0} reviews`;
    byId('productRatingStars').textContent = starText(summary.average);
    byId('productRatingText').textContent = summary.count ? `${Number(summary.average).toFixed(1)} · ${countLabel}` : 'No reviews yet';
    byId('reviewAverage').textContent = summary.count ? Number(summary.average).toFixed(1) : '—';
    byId('reviewSummaryStars').textContent = starText(summary.average);
    byId('reviewCount').textContent = summary.count ? countLabel : 'No reviews yet';
    byId('reviewList').innerHTML = reviews.length ? reviews.map((review) => {
      const date = review.created_at ? new Date(`${String(review.created_at).replace(' ', 'T')}Z`) : null;
      const dateText = date && !Number.isNaN(date.getTime()) ? date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';
      return `<article class="product-review">
        <div class="product-review__header"><strong>${escapeHtml(review.author_name || 'Anonymous')}</strong><span class="product-stars" aria-label="${Number(review.rating)} out of 5 stars">${starText(review.rating)}</span>${dateText ? `<time>${escapeHtml(dateText)}</time>` : ''}</div>
        ${review.title ? `<h3>${escapeHtml(review.title)}</h3>` : ''}<p>${escapeHtml(review.body || '')}</p>
      </article>`;
    }).join('') : '<p class="product-review-empty">No one has reviewed this item yet. You can be the first to share your experience.</p>';
  }

  function renderRelated() {
    const product = state.product;
    const sameCategory = state.products.filter((item) => item.id !== product.id && item.cat === product.cat);
    const others = state.products.filter((item) => item.id !== product.id && item.cat !== product.cat);
    const related = sameCategory.concat(others).slice(0, 4);
    byId('relatedProducts').innerHTML = related.map((item) => {
      const image = resolveImage(item);
      const firstSize = getSizes(item)[0];
      const price = unitPrice(item, firstSize);
      return `<article class="product-related-card"><a href="/product.html?id=${Number(item.id)}">
        <div class="product-related-card__image"><img src="${escapeHtml(image.src)}" alt="${escapeHtml(item.name)}" loading="lazy" data-category="${escapeHtml(item.cat || '')}"></div>
        <div class="product-related-card__body"><h3>${escapeHtml(item.name)}</h3><p>${price > 0 ? money(price) : 'Price on request'}</p></div>
      </a></article>`;
    }).join('');
    byId('relatedProducts').querySelectorAll('img').forEach((image) => { image.onerror = () => useFallback(image, image.dataset.category); });
  }

  function validQuantity() {
    const input = byId('productQuantity');
    const moq = Math.max(1, Number(state.settings.wholesale_moq || 10));
    const step = state.mode === 'wholesale' ? moq : 1;
    const raw = Math.max(step, Math.min(999, Number.parseInt(input.value, 10) || step));
    const value = state.mode === 'wholesale' ? Math.ceil(raw / moq) * moq : raw;
    input.value = String(value);
    return value;
  }

  function updateWhatsAppLink() {
    if (!state.product) return;
    const quantity = validQuantity();
    const number = String(state.settings.whatsapp_number || '233549193805').replace(/\D/g, '');
    const message = `Hi DC Kids! I would like to ask about ${state.product.name} (${state.selectedSize}, quantity ${quantity}). ${window.location.href}`;
    byId('productWhatsApp').href = `https://wa.me/${number}?text=${encodeURIComponent(message)}`;
  }

  function addToCart() {
    const product = state.product;
    const price = unitPrice(product, state.selectedSize);
    if (!product || price <= 0 || byId('productAddToCart').disabled) return;
    const quantity = validQuantity();
    const wholesale = state.mode === 'wholesale' ? 1 : 0;
    const existing = state.cart.find((item) => Number(item.id) === product.id && String(item.size || '') === state.selectedSize && Number(item.ws || 0) === wholesale);
    if (existing) existing.qty = Number(existing.qty || 0) + quantity;
    else state.cart.push({ id: product.id, name: product.name, size: state.selectedSize, price, qty: quantity, img: product.img, cat: product.cat, ws: wholesale });
    saveCart();
    openCart();
    showToast(`${product.name} added to your cart`);
  }

  function renderCart() {
    const count = state.cart.reduce((total, item) => total + Number(item.qty || 0), 0);
    const countElement = byId('productCartCount');
    countElement.textContent = count > 99 ? '99+' : String(count);
    countElement.hidden = count === 0;
    const items = byId('productCartItems');
    if (!state.cart.length) {
      items.innerHTML = '<p class="product-cart-empty">Your cart is empty.<br>Add a product to keep shopping.</p>';
      byId('productCartSubtotal').textContent = money(0);
      byId('productCheckoutLink').setAttribute('aria-disabled', 'true');
      return;
    }
    byId('productCheckoutLink').removeAttribute('aria-disabled');
    let subtotal = 0;
    items.innerHTML = state.cart.map((item, index) => {
      const product = state.products.find((entry) => entry.id === Number(item.id));
      const image = resolveImage({ img: item.img, cat: item.cat || (product && product.cat) });
      const total = Number(item.price || 0) * Number(item.qty || 0);
      subtotal += total;
      return `<article class="product-cart-item">
        <img src="${escapeHtml(image.src)}" alt="${escapeHtml(item.name || '')}" data-category="${escapeHtml(item.cat || '')}">
        <div><h3>${escapeHtml(item.name || '')}</h3><p>${escapeHtml(item.size || '')}${item.ws ? ' · Wholesale' : ''}</p><strong>${money(total)}</strong></div>
        <div class="product-cart-item__controls"><button type="button" data-cart-minus="${index}" aria-label="Decrease ${escapeHtml(item.name || '')}">−</button><span>${Number(item.qty || 0)}</span><button type="button" data-cart-plus="${index}" aria-label="Increase ${escapeHtml(item.name || '')}">+</button><button type="button" class="product-cart-item__remove" data-cart-remove="${index}">Remove</button></div>
      </article>`;
    }).join('');
    byId('productCartSubtotal').textContent = money(subtotal);
    items.querySelectorAll('img').forEach((image) => { image.onerror = () => useFallback(image, image.dataset.category); });
  }

  function changeCartQuantity(index, direction) {
    const item = state.cart[index];
    if (!item) return;
    const moq = item.ws ? Math.max(1, Number(state.settings.wholesale_moq || 10)) : 1;
    item.qty = Number(item.qty || 0) + (direction * moq);
    if (item.qty < moq) state.cart.splice(index, 1);
    saveCart();
  }

  function openCart() {
    const drawer = byId('productCartDrawer');
    const overlay = byId('productCartOverlay');
    overlay.hidden = false;
    drawer.setAttribute('aria-hidden', 'false');
    byId('productCartButton').setAttribute('aria-expanded', 'true');
    requestAnimationFrame(() => { overlay.classList.add('is-open'); drawer.classList.add('is-open'); });
    document.body.style.overflow = 'hidden';
    byId('closeProductCart').focus();
  }

  function closeCart() {
    const drawer = byId('productCartDrawer');
    const overlay = byId('productCartOverlay');
    overlay.classList.remove('is-open');
    drawer.classList.remove('is-open');
    drawer.setAttribute('aria-hidden', 'true');
    byId('productCartButton').setAttribute('aria-expanded', 'false');
    document.body.style.overflow = '';
    setTimeout(() => { overlay.hidden = true; }, 260);
  }

  function updateWishlistButtons() {
    if (!state.product) return;
    const active = state.wishlist.has(state.product.id);
    const save = byId('productSave');
    save.classList.toggle('is-active', active);
    save.setAttribute('aria-pressed', String(active));
    save.querySelector('span').textContent = active ? 'Saved to wishlist' : 'Save item';
    byId('headerWishlist').classList.toggle('is-active', active);
  }

  function isSignedIn() {
    return !!(state.auth.user && state.auth.user.emailVerified && state.auth.customer && window.DCKidsAuth);
  }

  async function authHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    if (isSignedIn()) headers.Authorization = `Bearer ${await window.DCKidsAuth.getIdToken()}`;
    return headers;
  }

  async function syncWishlist() {
    if (!window.DCKidsAuth) return;
    state.auth = window.DCKidsAuth.getState();
    if (!isSignedIn()) {
      state.wishlist = new Set(readArray(WISHLIST_KEY).map(Number));
      updateWishlistButtons();
      return;
    }
    try {
      const guestIds = readArray(WISHLIST_KEY).map(Number).filter(Number.isInteger);
      if (guestIds.length) {
        const merge = await fetch('/api/wishlist/merge', { method: 'POST', headers: await authHeaders(), body: JSON.stringify({ productIds: guestIds }) });
        if (merge.ok) localStorage.removeItem(WISHLIST_KEY);
      }
      const response = await fetch('/api/wishlist', { headers: await authHeaders(), cache: 'no-store' });
      if (response.ok) {
        const rows = await response.json();
        state.wishlist = new Set(rows.map((row) => Number(row.product_id)));
      }
    } catch (error) {
      state.wishlist = new Set(readArray(WISHLIST_KEY).map(Number));
    }
    updateWishlistButtons();
  }

  async function toggleWishlist() {
    const id = state.product.id;
    const wasActive = state.wishlist.has(id);
    if (wasActive) state.wishlist.delete(id); else state.wishlist.add(id);
    updateWishlistButtons();
    try {
      if (isSignedIn()) {
        const response = await fetch(wasActive ? `/api/wishlist/${id}` : '/api/wishlist', {
          method: wasActive ? 'DELETE' : 'POST',
          headers: await authHeaders(),
          body: wasActive ? undefined : JSON.stringify({ product_id: id })
        });
        if (!response.ok) throw new Error('Wishlist update failed');
      } else {
        localStorage.setItem(WISHLIST_KEY, JSON.stringify(Array.from(state.wishlist)));
      }
      showToast(wasActive ? 'Removed from your wishlist' : 'Saved to your wishlist');
    } catch (error) {
      if (wasActive) state.wishlist.add(id); else state.wishlist.delete(id);
      updateWishlistButtons();
      showToast('Could not update your wishlist. Please try again.', 'error');
    }
  }

  function showReviewForm(show) {
    const form = byId('reviewForm');
    form.hidden = !show;
    byId('reviewList').hidden = show;
    if (show) {
      if (isSignedIn()) {
        byId('reviewAuthor').value = state.auth.customer.name || '';
        byId('reviewAuthor').readOnly = true;
      }
      form.scrollIntoView({ behavior: 'smooth', block: 'center' });
      byId('reviewBody').focus();
    }
  }

  function selectReviewRating(rating) {
    state.selectedRating = Number(rating);
    byId('reviewRatingButtons').querySelectorAll('button').forEach((button) => {
      const active = Number(button.dataset.rating) <= state.selectedRating;
      button.textContent = active ? '★' : '☆';
      button.setAttribute('aria-pressed', String(Number(button.dataset.rating) === state.selectedRating));
    });
  }

  async function submitReview(event) {
    event.preventDefault();
    const message = byId('reviewFormMessage');
    message.className = 'product-form-message';
    if (!state.selectedRating) {
      message.textContent = 'Choose a star rating first.';
      message.classList.add('is-error');
      return;
    }
    const body = byId('reviewBody').value.trim();
    const author = byId('reviewAuthor').value.trim();
    if (body.length < 4 || (!isSignedIn() && !author)) {
      message.textContent = 'Please add your name and a short review.';
      message.classList.add('is-error');
      return;
    }
    const submit = event.submitter;
    submit.disabled = true;
    message.textContent = 'Submitting your review…';
    try {
      const response = await fetch(`/api/products/${state.product.id}/reviews`, {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({ rating: state.selectedRating, author_name: author, title: byId('reviewTitle').value.trim(), body })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Could not submit review');
      event.currentTarget.reset();
      selectReviewRating(0);
      message.textContent = 'Thank you. Your review was submitted for approval.';
      message.classList.add('is-success');
      if (isSignedIn()) byId('reviewAuthor').value = state.auth.customer.name || '';
    } catch (error) {
      message.textContent = error.message;
      message.classList.add('is-error');
    } finally {
      submit.disabled = false;
    }
  }

  function installProductJsonLd() {
    const product = state.product;
    const price = unitPrice(product, state.selectedSize);
    const resolved = resolveImage(product);
    const schema = {
      '@context': 'https://schema.org', '@type': 'Product', name: product.name,
      image: [new URL(resolved.src, window.location.href).href],
      description: String(product.description || '').trim() || FALLBACK_DESCRIPTION,
      sku: product.sku || undefined,
      offers: price > 0 ? { '@type': 'Offer', priceCurrency: 'GHS', price: price.toFixed(2), availability: product.stock > 0 || product.fulfillment_type === 'preorder' ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock', url: window.location.href } : undefined
    };
    if (state.reviews.summary.count) schema.aggregateRating = { '@type': 'AggregateRating', ratingValue: state.reviews.summary.average, reviewCount: state.reviews.summary.count };
    const script = document.createElement('script');
    script.type = 'application/ld+json';
    script.textContent = JSON.stringify(schema);
    document.head.appendChild(script);
  }

  function bindEvents() {
    byId('productSizes').addEventListener('click', (event) => {
      const button = event.target.closest('[data-size]');
      if (!button) return;
      state.selectedSize = button.dataset.size;
      byId('productSizes').querySelectorAll('button').forEach((entry) => { entry.classList.toggle('is-active', entry === button); entry.setAttribute('aria-pressed', String(entry === button)); });
      byId('selectedSizeText').textContent = state.selectedSize;
      renderPriceAndStock();
      updateWhatsAppLink();
    });
    byId('productThumbnails').addEventListener('click', (event) => {
      const button = event.target.closest('[data-image]');
      if (!button) return;
      byId('productMainImage').src = button.dataset.image;
      byId('productThumbnails').querySelectorAll('button').forEach((entry) => { entry.classList.toggle('is-active', entry === button); entry.setAttribute('aria-pressed', String(entry === button)); });
    });
    byId('quantityMinus').addEventListener('click', () => { byId('productQuantity').value = String(validQuantity() - Number(byId('productQuantity').step || 1)); validQuantity(); renderPriceAndStock(); updateWhatsAppLink(); });
    byId('quantityPlus').addEventListener('click', () => { byId('productQuantity').value = String(validQuantity() + Number(byId('productQuantity').step || 1)); validQuantity(); renderPriceAndStock(); updateWhatsAppLink(); });
    byId('productQuantity').addEventListener('change', () => { validQuantity(); renderPriceAndStock(); updateWhatsAppLink(); });
    byId('productAddToCart').addEventListener('click', addToCart);
    byId('productMobileAdd').addEventListener('click', addToCart);
    byId('productSave').addEventListener('click', toggleWishlist);
    byId('headerWishlist').addEventListener('click', toggleWishlist);
    byId('productRatingLink').addEventListener('click', () => byId('productReviews').scrollIntoView({ behavior: 'smooth' }));
    byId('writeReviewButton').addEventListener('click', () => showReviewForm(true));
    byId('cancelReviewButton').addEventListener('click', () => showReviewForm(false));
    byId('reviewRatingButtons').addEventListener('click', (event) => { const button = event.target.closest('[data-rating]'); if (button) selectReviewRating(button.dataset.rating); });
    byId('reviewForm').addEventListener('submit', submitReview);
    byId('productCartButton').addEventListener('click', openCart);
    byId('closeProductCart').addEventListener('click', closeCart);
    byId('productCartOverlay').addEventListener('click', closeCart);
    byId('productCartItems').addEventListener('click', (event) => {
      const minus = event.target.closest('[data-cart-minus]');
      const plus = event.target.closest('[data-cart-plus]');
      const remove = event.target.closest('[data-cart-remove]');
      if (minus) changeCartQuantity(Number(minus.dataset.cartMinus), -1);
      if (plus) changeCartQuantity(Number(plus.dataset.cartPlus), 1);
      if (remove) { state.cart.splice(Number(remove.dataset.cartRemove), 1); saveCart(); }
    });
    byId('productCheckoutLink').addEventListener('click', (event) => { if (!state.cart.length) event.preventDefault(); });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && byId('productCartDrawer').classList.contains('is-open')) closeCart(); });
    window.addEventListener('dckids-auth-change', (event) => { state.auth = event.detail || state.auth; syncWishlist(); });
  }

  async function initializeAuth() {
    if (!window.DCKidsAuth) return;
    try {
      await window.DCKidsAuth.ready;
      state.auth = window.DCKidsAuth.getState();
      window.DCKidsAuth.onChange((next) => { state.auth = next || state.auth; syncWishlist(); });
      await syncWishlist();
    } catch (error) {
      updateWishlistButtons();
    }
  }

  async function init() {
    byId('footerYear').textContent = String(new Date().getFullYear());
    renderCart();
    const id = Number.parseInt(new URLSearchParams(window.location.search).get('id'), 10);
    if (!Number.isInteger(id) || id <= 0) {
      byId('productLoading').hidden = true;
      byId('productError').hidden = false;
      byId('productErrorText').textContent = 'Choose a product from the shop to view its full details.';
      return;
    }
    await loadProduct(id);
    byId('productLoading').hidden = true;
    if (!state.product) {
      byId('productError').hidden = false;
      return;
    }
    renderProduct();
    bindEvents();
    byId('productContent').hidden = false;
    initializeAuth();
  }

  init();
})();
