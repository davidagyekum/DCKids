/* ===== DC Kids Brand — App Logic (All 83 Images) ===== */

// ── Product Catalogue — every image from TikTok mapped ──
// Image key (from original filenames sorted alphabetically):
// 1=logo, 2-7=accessories/sunglasses, 8=baby essentials collage, 9=baby bedding/bottles,
// 10=baby gear, 11=xmas sale flyer, 12=valentine flyer, 13-27=baby shoes (15 images),
// 28=new year promo, 29-35=school bags/backpacks (7 images), 36=school essentials flyer,
// 37=school gear ready, 38-51=wholesale kids clothing (14 images), 52=valentine flyer,
// 53-54=newborn essentials, 55=ghana independence, 56-64=new arrivals clothing (9 images),
// 65=store promo, 66-77=kids shoes/sneakers (12 images), 78=china sourcing flyer,
// 79=store promo, 80=whatsapp link, 81-82=store clothing, 83=china pre-order flyer

let products = [];
let searchQuery = '';

// Promotional/brand images used elsewhere (not product cards):
// product_1.jpg  = Logo
// product_11.jpg = Xmas Discount Sales flyer
// product_12.jpg = Valentine's Day flyer
// product_28.jpg = Happy New Year promo
// product_36.jpg = School Essentials flyer
// product_37.jpg = "We are ready" school gear flyer
// product_52.jpg = Valentine's Day flyer
// product_53.jpg = Social media "Follow Us" promo (repurposed as newborn essentials)

// ── State ──
let siteConfig = {};
let storeMode = localStorage.getItem('storeMode') || 'retail';
let currentStock = 'available';
let currentCategory = 'all';

// ── DOM Refs ──
const btnRetail     = document.getElementById('btnRetail');
const btnWholesale  = document.getElementById('btnWholesale');
const menuBtn      = document.getElementById('menuBtn');
const navDrawer     = document.getElementById('navDrawer');
const navOverlay    = document.getElementById('navOverlay');
const header        = document.getElementById('header');
const closeBanner   = document.getElementById('closeBanner');
const urgencyBanner = document.getElementById('urgencyBanner');
const dynamicSections = document.getElementById('dynamicSections');
const preorderGrid  = document.getElementById('preorderGrid');
const preorderSec   = document.getElementById('preorderSection');
const categoryPills = document.getElementById('categoryPills');
const inventoryBtns = document.querySelectorAll('.inventory-toggle__btn');
let navItems        = document.querySelectorAll('.nav-drawer__item[data-category]');

// ── WhatsApp URL builder (Legacy) ──
function waUrl(productName) {
  const num = siteConfig.whatsapp_number || '233549193805';
  const msg = encodeURIComponent(`Hi DC Kids Brand! I'm interested in: ${productName}. Is it available?`);
  return `https://wa.me/${num}?text=${msg}`;
}

// Static wa.me links (nav, header, footer) carry their own message text —
// only swap the number, so admin changes reach them without clobbering each
// link's wording. The floating button is mode-aware (see updateFloatingWaBtn)
// and isn't part of this set.
function applyWhatsAppNumber() {
  const num = siteConfig.whatsapp_number || '233549193805';
  document.querySelectorAll('[data-wa-link]').forEach(el => {
    el.href = el.href.replace(/wa\.me\/\d+/, 'wa.me/' + num);
  });
}

// The floating button is the one WhatsApp touchpoint that survived removing
// the per-card wholesale button, so its message should match what the
// shopper is actually browsing instead of staying generic.
function updateFloatingWaBtn() {
  const btn = document.getElementById('floatingWaBtn');
  if (!btn) return;
  const num = siteConfig.whatsapp_number || '233549193805';
  const msg = storeMode === 'wholesale'
    ? 'Hi DC Kids! I have a question about a wholesale order.'
    : 'Hi DC Kids! I have a question about a product.';
  btn.href = 'https://wa.me/' + num + '?text=' + encodeURIComponent(msg);
}

// ── Size → Price modifier (GHC markup per age tier) ──
function getPriceModifier(sizeLabel) {
  const s = sizeLabel.toString().trim();
  // Newborn / tiny baby
  if (/^(0-3M|3-6M|6-9M|9-12M|12-18M|0M|3M|6M|9M|12M|14|15|16|17|18|19|20|21)$/i.test(s)) return 0;
  // Baby–Toddler
  if (/^(18M|24M|1Y|2Y|22|23|24|25|26|27)$/i.test(s)) return 5;
  // Toddler–Child
  if (/^(3Y|4Y|28|29|30|31|32|33|34)$/i.test(s)) return 10;
  // Child
  if (/^(5Y|6Y|7Y|35|36)$/i.test(s)) return 15;
  // Older child
  if (/^(8Y|9Y|10Y|11Y|12Y)$/i.test(s)) return 20;
  return 0;
}

// ── Helper to parse size string into array of options ──
function parseSize(str) {
  if (!str) return ["One Size"];
  // Shoe size range e.g. "Size 25–35"
  let m = str.match(/Size\s*(\d+)\s*[-–]\s*(\d+)/i);
  if (m) {
    let s = parseInt(m[1]), e = parseInt(m[2]), arr = [];
    for (let i = s; i <= e; i++) arr.push(`${i}`);
    return arr;
  }
  // Year range e.g. "2Y – 8Y"
  m = str.match(/(\d+)Y\s*[-–]\s*(\d+)Y/i);
  if (m) {
    let s = parseInt(m[1]), e = parseInt(m[2]), arr = [];
    for (let i = s; i <= e; i++) arr.push(`${i}Y`);
    return arr;
  }
  // "0 – 12M" or "0 – 18M" ranges
  m = str.match(/0\s*[-–]\s*(\d+)M/i);
  if (m) {
    const e = parseInt(m[1]);
    if (e <= 12) return ["0-3M", "3-6M", "6-9M", "9-12M"];
    return ["0-3M", "3-6M", "6-9M", "9-12M", "12-18M"];
  }
  // Month range e.g. "6M – 24M"
  m = str.match(/(\d+)M\s*[-–]\s*(\d+)M/i);
  if (m) {
    const months = [3, 6, 9, 12, 18, 24];
    const s = parseInt(m[1]), e = parseInt(m[2]);
    return months.filter(mo => mo >= s && mo <= e).map(mo => `${mo}M`);
  }
  return [str];
}

// ── Get live PER-UNIT price for a card (with wholesale discount applied if active) ──
// Admin-managed size variants: array of {label, price} or null. When present
// it is authoritative for the storefront (matches the server's order pricing).
function getManagedSizes(p) {
  if (!p || !p.sizes) return null;
  try {
    const a = typeof p.sizes === 'string' ? JSON.parse(p.sizes) : p.sizes;
    return (Array.isArray(a) && a.length) ? a : null;
  } catch (e) { return null; }
}

// Every price renders with 2 decimals (GH₵ 180.00).
function gh(n) { return (Number(n) || 0).toFixed(2); }

function getCardPrice(productId) {
  const product = products.find(p => p.id === productId);
  if (!product) return null;
  const selectEl = document.getElementById(`size-select-${productId}`);
  const selectedSize = selectEl ? selectEl.value : '';
  const managed = getManagedSizes(product);
  let unitPrice;
  if (managed) {
    const m = managed.find(s => s.label === selectedSize) || managed[0];
    unitPrice = (m && m.price != null) ? Number(m.price) : (product.price || 0);
    if (!unitPrice) return null; // no per-size price and no base → ask for price
  } else {
    if (!product.price) return null;
    unitPrice = product.price + getPriceModifier(selectedSize);
  }
  const isWholesale = (storeMode === 'wholesale');
  const discount = siteConfig.wholesale_discount || 0;
  if (isWholesale && discount > 0) {
    unitPrice = unitPrice * (1 - (discount / 100));
  }
  return Math.round(unitPrice * 100) / 100; // 2 decimals, fixes float precision
}

// ── Render product card HTML ──
function renderCard(p, index) {
  // escName goes inside an onclick JS string literal, so it needs BOTH the JS
  // single-quote escape and HTML escaping; nameHtml/imgHtml cover plain markup.
  const escName = escapeStr((p.name || '').replace(/'/g, "\\'"));
  const nameHtml = escapeStr(p.name || '');
  const imgHtml = escapeStr(p.img || '');
  let badgeHTML = '';
  let isSoldOut = false;
  if (p.stock === 0) {
    badgeHTML = '<span class="product-card__badge product-card__badge--hot" style="background-color: #ef4444;"><svg width="14" height="14" style="vertical-align: middle; margin-right: 4px; margin-top: -2px;" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg> Sold Out</span>';
    isSoldOut = true;
  } else if (p.badge) {
    badgeHTML = '<span class="product-card__badge product-card__badge--' + p.badge + '">' +
        (p.badge === 'new' ? '<svg width="14" height="14" style="vertical-align: middle; margin-right: 4px; margin-top: -2px;" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3l1.9 5.8 1.9-5.8a2 2 0 0 1 1.3-1.3l5.8-1.9-5.8-1.9a2 2 0 0 1-1.3-1.3L12 3Z"></path></svg> New' : 
         p.badge === 'hot' ? '<svg width="14" height="14" style="vertical-align: middle; margin-right: 4px; margin-top: -2px;" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"></path></svg> Hot' : 
         '<svg width="14" height="14" style="vertical-align: middle; margin-right: 4px; margin-top: -2px;" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"></circle><path d="M2 12h20"></path><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg> Pre-Order') +
      '</span>';
  }

  // Genuine low-stock urgency only — never faked. Retail only (wholesale sells in bulk),
  // and not for pre-orders (their stock isn't on-hand).
  // Overlaid on the image (not in the card body) so cards with and without
  // the chip keep identical body heights and the grid stays aligned.
  let lowStockHTML = '';
  if (!isSoldOut && p.fulfillment_type !== 'preorder' && typeof p.stock === 'number' && p.stock > 0 && p.stock <= 5) {
    lowStockHTML = '<div class="product-card__lowstock" style="position:absolute;left:8px;bottom:8px;z-index:2;display:inline-flex;align-items:center;gap:5px;background:rgba(255,255,255,0.95);color:#B91C1C;font-size:11px;font-weight:700;padding:3px 9px;border-radius:999px;box-shadow:0 1px 4px rgba(0,0,0,0.12);"><span style="width:6px;height:6px;border-radius:50%;background:#EF4444;display:inline-block;"></span>Only ' + p.stock + ' left</div>';
  }

  const isWholesale = (storeMode === 'wholesale');
  const moq = siteConfig.wholesale_moq || 10;
  const discount = siteConfig.wholesale_discount || 0;

  // Managed sizes (admin-set, with absolute per-size prices) win; otherwise
  // fall back to the legacy free-text size string + per-tier modifier.
  const managed = getManagedSizes(p);
  const sizeOptions = managed ? managed.map(s => s.label) : parseSize(p.size);
  const hasVariants = sizeOptions.length > 1;

  // Per-unit retail price for a given size label (before wholesale discount).
  const baseFor = (label) => {
    if (managed) {
      const m = managed.find(s => s.label === label) || managed[0];
      return (m && m.price != null) ? Number(m.price) : (p.price || 0);
    }
    return (p.price || 0) + getPriceModifier(label);
  };
  const applyDisc = (v) => (isWholesale && discount > 0) ? v * (1 - (discount / 100)) : v;
  // Whether this product has any real price (else it's "ask for price").
  const hasPrice = managed ? (managed.some(s => s.price != null) || (p.price || 0) > 0) : ((p.price || 0) > 0);

  const isPreorder = p.fulfillment_type === 'preorder';
  const cardClass = isPreorder ? 'product-card product-card--preorder' : 'product-card';

  // Initial display: for wholesale show total for MOQ; for retail show single-unit price
  const initialUnit = Math.round(applyDisc(baseFor(sizeOptions[0])) * 100) / 100;
  const initialQty  = isWholesale ? moq : 1;
  const initialTotal = Math.round(initialUnit * initialQty * 100) / 100;
  const initialPrice = hasPrice
    ? `GH₵ ${gh(initialTotal)}` + (isWholesale ? ` <span style="font-size:11px;color:#888;font-weight:400;">(${initialQty} pcs @ GH₵ ${gh(initialUnit)})</span>` : '')
    : (isPreorder ? '<svg width="14" height="14" style="vertical-align: middle; margin-right: 4px; margin-top: -2px;" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"></circle><path d="M2 12h20"></path><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg> Price on request' : 'Ask for price');

  let sizeHTML = '';
  if (hasVariants) {
    const firstSize = sizeOptions[0];
    const firstUnit = Math.round(applyDisc(baseFor(firstSize)) * 100) / 100;
    const firstLabel = (hasPrice && firstUnit > 0) ? firstSize + ' — GH₵ ' + gh(firstUnit) : firstSize;
    const optionsHTML = sizeOptions.map((s, i) => {
      const sUnit = Math.round(applyDisc(baseFor(s)) * 100) / 100;
      const label = (hasPrice && sUnit > 0) ? s + ' — GH₵ ' + gh(sUnit) : s;
      return '<div class="premium-selector__option' + (i === 0 ? ' premium-selector__option--selected' : '') + '" data-value="' + s + '" onclick="premiumSelect(this)" role="option" tabindex="0">' +
        '<span class="premium-selector__radio"></span>' +
        '<span class="premium-selector__option-text">' + label + '</span>' +
      '</div>';
    }).join('');
    sizeHTML = '<div class="premium-selector' + (isSoldOut ? ' premium-selector--disabled' : '') + '" data-product-id="' + p.id + '" data-type="size">' +
      '<input type="hidden" id="size-select-' + p.id + '" value="' + firstSize + '" class="premium-selector__native">' +
      '<div class="premium-selector__trigger" onclick="togglePremiumSelector(this)" role="combobox" tabindex="0" aria-expanded="false">' +
        '<span class="premium-selector__label">' + firstLabel + '</span>' +
        '<svg class="premium-selector__arrow" viewBox="0 0 16 16" fill="none"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
      '</div>' +
      '<div class="premium-selector__dropdown" role="listbox">' + optionsHTML + '</div>' +
    '</div>';
  } else {
    const singleLabel = sizeOptions[0] || p.size || 'One Size';
    sizeHTML = '<div class="product-card__size">' + singleLabel + '</div>' +
                '<input type="hidden" id="size-select-' + p.id + '" value="' + singleLabel + '">';
  }

  // Bulk quantity selector (wholesale only)
  let bulkQtyHTML = '';
  if (isWholesale && !isSoldOut) {
    const multiples = [1, 2, 3, 5, 10];
    const firstBulk = multiples[0] * moq;
    const firstBulkLabel = firstBulk + ' pcs (×' + multiples[0] + ' MOQ)';
    const bulkOptionsHTML = multiples.map((m, i) => {
      const val = m * moq;
      const label = val + ' pcs (×' + m + ' MOQ)';
      return '<div class="premium-selector__option' + (i === 0 ? ' premium-selector__option--selected' : '') + '" data-value="' + val + '" onclick="premiumSelect(this)" role="option" tabindex="0">' +
        '<span class="premium-selector__radio"></span>' +
        '<span class="premium-selector__option-text">' + label + '</span>' +
      '</div>';
    }).join('');
    bulkQtyHTML = '<div class="premium-selector" data-product-id="' + p.id + '" data-type="bulk" style="margin-top:6px;">' +
      '<input type="hidden" id="bulk-qty-' + p.id + '" value="' + firstBulk + '" class="premium-selector__native">' +
      '<div class="premium-selector__trigger" onclick="togglePremiumSelector(this)" role="combobox" tabindex="0" aria-expanded="false">' +
        '<span class="premium-selector__label">' + firstBulkLabel + '</span>' +
        '<svg class="premium-selector__arrow" viewBox="0 0 16 16" fill="none"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
      '</div>' +
      '<div class="premium-selector__dropdown" role="listbox">' + bulkOptionsHTML + '</div>' +
    '</div>';
  }

  let ctaHTML = '';
  if (isSoldOut) {
    ctaHTML = `<button disabled class="product-card__cta" style="background-color: #ccc; cursor: not-allowed; color: #666; border: none;">Out of Stock</button>`;
  } else if (isWholesale) {
    ctaHTML = `<button onclick="addToCart(${p.id})" class="product-card__cta" style="display:flex;align-items:center;justify-content:center;gap:6px;">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><circle cx="9" cy="21" r="1"></circle><circle cx="20" cy="21" r="1"></circle><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"></path></svg>
        Add Bulk to Cart
      </button>`;
  } else if (isPreorder) {
    ctaHTML = p.price
        ? `<button onclick="addToCart(${p.id})" class="product-card__cta">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="21" r="1"></circle><circle cx="20" cy="21" r="1"></circle><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"></path><path d="M12 10h6"></path><path d="M15 7v6"></path></svg>
            Add to Cart
          </button>`
        : `<a href="${waUrl(p.name)}" target="_blank" class="product-card__cta product-card__cta--ask" style="text-decoration:none;display:flex;align-items:center;justify-content:center;gap:6px;">
            <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51a12.8 12.8 0 0 0-.57-.01c-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.82 9.82 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.81 11.81 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.88 11.88 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.82 11.82 0 0 0-3.48-8.413z"/></svg>
            Ask for Price
          </a>`;
  } else {
    ctaHTML = `<button onclick="addToCart(${p.id})" class="product-card__cta">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="21" r="1"></circle><circle cx="20" cy="21" r="1"></circle><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"></path><path d="M12 10h6"></path><path d="M15 7v6"></path></svg>
        Add to Cart
      </button>`;
  }

  let moqHTML = isWholesale ? `<div class="product-card__moq">MOQ: ${moq}</div>` : '';

  return `
    <article class="${cardClass}" data-category="${escapeStr(p.cat || '')}" data-product-id="${p.id}" style="animation-delay: ${index * 0.04}s">
      <div class="product-card__img-wrap">
        <img class="product-card__img" src="${imgHtml}" alt="${nameHtml}" loading="lazy" onerror="this.onerror=null;this.src='images/placeholder.svg';">
        ${badgeHTML}
        ${lowStockHTML}
        <button type="button" class="wishlist-heart" data-wishlist-id="${p.id}" aria-label="Add to wishlist" onclick="toggleWishlist(event, ${p.id})">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
        </button>
      </div>
      <div class="product-card__body">
        <button type="button" class="product-card__name" onclick="openReviewsModal(${p.id}, '${escName}')" aria-label="View details for ${nameHtml}">${nameHtml}</button>
        <button type="button" class="product-card__rating" data-rating-id="${p.id}" onclick="openReviewsModal(${p.id}, '${escName}')" aria-label="View or write a review for ${nameHtml}" style="display:none;">
          <span class="rating-stars" data-stars-for="${p.id}"></span>
          <span class="rating-count" data-count-for="${p.id}"></span>
        </button>
        ${moqHTML}
        ${sizeHTML}
        ${bulkQtyHTML}
        <div class="product-card__price" id="price-display-${p.id}">${initialPrice}</div>
        ${ctaHTML}
      </div>
    </article>
  `;
}

// ── Live price update when size or bulk-qty dropdown changes ──
function updateCardPrice(productId) {
  const product = products.find(p => p.id === productId);
  if (!product) return;
  const priceEl = document.getElementById(`price-display-${productId}`);
  if (!priceEl) return;
  const unitPrice = getCardPrice(productId);
  if (unitPrice === null) {
    priceEl.innerText = 'Ask for price';
    return;
  }
  const isWholesale = (storeMode === 'wholesale');
  const bulkQtyEl = document.getElementById(`bulk-qty-${productId}`);
  const qty = (isWholesale && bulkQtyEl) ? parseInt(bulkQtyEl.value) : 1;
  const total = Math.round(unitPrice * qty * 100) / 100;
  priceEl.innerHTML = `GH₵ ${gh(total)}` + (isWholesale ? ` <span style="font-size:11px;color:#888;font-weight:400;">(${qty} pcs @ GH₵ ${gh(unitPrice)})</span>` : '');
  priceEl.style.transition = 'color 0.2s';
  priceEl.style.color = 'var(--green-primary)';
}

// ── Render grids (Dynamic Sections for Smooth Scroll) ──
// Preferred display order + pretty labels for KNOWN categories. New categories
// the owner creates in the admin still appear automatically (see getActiveCategories).
const categoryMap = [
  { id: 'newborn', label: 'Newborn' },
  { id: 'clothing', label: 'Kids Clothing' },
  { id: 'shoes', label: 'Footwear' },
  { id: 'feeding', label: 'Feeding & Bottles' },
  { id: 'gear', label: 'Baby Gear' },
  { id: 'bathcare', label: 'Bath & Care' },
  { id: 'essentials', label: 'Baby Essentials' },
  { id: 'accessories', label: 'Bags & Accessories' },
  { id: 'bedding', label: 'Bedding' }
];
const KNOWN_CATEGORY_LABELS = categoryMap.reduce((m, c) => { m[c.id] = c.label; return m; }, {});

// Turn a raw category id into a readable label, e.g. "party-wear" -> "Party Wear".
function humanizeCategory(id) {
  return String(id || '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, ch => ch.toUpperCase());
}

// Owner-managed category list (shared with the admin via same-origin localStorage).
function getStoredCategoryList() {
  try { return JSON.parse(localStorage.getItem('dcKidsCategories')) || []; }
  catch (e) { return []; }
}

// Build the storefront category list from the categories actually present on
// products. Order + labels follow the owner's managed list first, then the
// known defaults, then any remaining new categories (humanized) alphabetically.
function getActiveCategories(items) {
  const present = new Set(
    items.map(p => p.cat).filter(c => c)
  );
  const result = [];
  const seen = new Set();
  const add = (id, label) => {
    if (present.has(id) && !seen.has(id)) {
      seen.add(id);
      result.push({ id, label: label || KNOWN_CATEGORY_LABELS[id] || humanizeCategory(id) });
    }
  };
  getStoredCategoryList().forEach(c => { if (c && c.id) add(c.id, c.label); });
  categoryMap.forEach(c => add(c.id, c.label));
  [...present].filter(id => !seen.has(id)).sort().forEach(id => add(id));
  return result;
}

// ── Storefront pagination (page through products instead of endless scroll) ──
const PRODUCTS_PER_PAGE = 12;
let categoryPages = {};   // catId (or 'all') -> current page (1-based)
let preorderPage = 1;

function renderStorePagination(key, page, totalPages) {
  if (totalPages <= 1) return '';
  return `
    <div class="store-pagination">
      <button class="store-pagination__btn" ${page <= 1 ? 'disabled' : ''} onclick="goToStorePage('${key}', ${page - 1})" aria-label="Previous page">
        <i class="fas fa-chevron-left"></i> Prev
      </button>
      <span class="store-pagination__info">Page ${page} of ${totalPages}</span>
      <button class="store-pagination__btn" ${page >= totalPages ? 'disabled' : ''} onclick="goToStorePage('${key}', ${page + 1})" aria-label="Next page">
        Next <i class="fas fa-chevron-right"></i>
      </button>
    </div>`;
}

function goToStorePage(key, page) {
  if (key === '__preorder__') preorderPage = page; else categoryPages[key] = page;
  (window.renderProducts || renderProducts)();
  const sec = key === '__preorder__' ? document.getElementById('preorderSection') : document.getElementById('productListSection');
  if (sec) window.scrollTo({ top: sec.getBoundingClientRect().top + window.pageYOffset - 90, behavior: 'smooth' });
}

function renderProducts() {
  let filteredProducts = products;

  if (searchQuery) {
      filteredProducts = products.filter(p => {
          const searchStr = searchQuery.toLowerCase();
          const matchName = p.name && p.name.toLowerCase().includes(searchStr);
          const matchCat = p.cat && p.cat.toLowerCase().includes(searchStr);
          const matchSize = p.size && p.size.toLowerCase().includes(searchStr);
          return matchName || matchCat || matchSize;
      });
  }

  // Pre-order items keep their real category, so they show up in their normal
  // category grid too (badged as pre-order) — not just tucked away in a
  // separate section invisible to anyone browsing by category.
  const avail = filteredProducts;
  const pre   = filteredProducts.filter(p => p.fulfillment_type === 'preorder');

  if (dynamicSections) {
    // ONE paginated grid filtered by the active category — shoppers move
    // page-by-page (Prev/Next) instead of scrolling every category at once.
    const cats = getActiveCategories(avail);
    // A category is valid to filter on if it has products OR the owner manages it
    // (so a brand-new empty category like "ROCKS" shows its own grid, not "All").
    const managed = (typeof getStoredCategoryList === 'function' ? getStoredCategoryList() : []);
    const isValidCat = currentCategory && currentCategory !== 'all' && currentCategory !== 'preorder' &&
      (cats.some(c => c.id === currentCategory) || managed.some(c => c && c.id === currentCategory));
    const activeCat = isValidCat ? currentCategory : 'all';
    const list = activeCat === 'all' ? avail : avail.filter(p => p.cat === activeCat);
    const totalPages = Math.max(1, Math.ceil(list.length / PRODUCTS_PER_PAGE));
    let page = categoryPages[activeCat] || 1;
    if (page > totalPages) page = totalPages;
    if (page < 1) page = 1;
    categoryPages[activeCat] = page;
    const start = (page - 1) * PRODUCTS_PER_PAGE;
    const pageProducts = list.slice(start, start + PRODUCTS_PER_PAGE);
    const label = activeCat === 'all'
      ? (searchQuery ? 'Search Results' : 'All Products')
      : ((cats.find(c => c.id === activeCat) || managed.find(c => c && c.id === activeCat) || {}).label || humanizeCategory(activeCat));

    dynamicSections.innerHTML = `
      <section id="productListSection" class="category-section pb-4">
        <div class="section-header flex justify-between items-center mb-4 px-4 md:px-0">
          <h2 class="section-header__title text-lg font-bold text-gray-800 font-sans">${label}</h2>
          <span class="section-header__count text-sm text-gray-500 font-medium">${list.length} item${list.length === 1 ? '' : 's'}</span>
        </div>
        <div class="product-grid">
          ${pageProducts.length ? pageProducts.map((p, i) => renderCard(p, i)).join('') : '<p style="grid-column:1/-1;text-align:center;padding:48px 16px;color:#999;">No products found.</p>'}
        </div>
        ${renderStorePagination(activeCat, page, totalPages)}
      </section>`;
  }

  if (preorderGrid) {
    preorderGrid.innerHTML = pre.map((p,i) => renderCard(p,i)).join('') || '<p style="grid-column:1/-1;text-align:center;padding:40px;color:#999;">No pre-order items available.</p>';
  }
}

// ── Inventory Toggle ──
inventoryBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    inventoryBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentStock = btn.dataset.stock;
    if (currentStock === 'available') {
      if (dynamicSections) dynamicSections.classList.remove('hidden');
      if (preorderSec) preorderSec.classList.add('hidden');
    } else {
      if (dynamicSections) dynamicSections.classList.add('hidden');
      if (preorderSec) preorderSec.classList.remove('hidden');
    }
  });
});

// ── Category pills → filter the single grid (paginated), not scroll ──
if (categoryPills) {
  categoryPills.querySelectorAll('.category-pill').forEach(pill => {
    pill.addEventListener('click', (e) => {
      e.preventDefault();
      const cat = pill.getAttribute('data-filter') || 'all';
      currentCategory = cat;
      categoryPages[cat] = 1;
      categoryPills.querySelectorAll('.category-pill').forEach(p => p.classList.toggle('active', p === pill));
      if (dynamicSections) dynamicSections.classList.remove('hidden');
      if (preorderSec) preorderSec.classList.add('hidden');
      if (inventoryBtns[1]) inventoryBtns[1].classList.remove('active');
      if (inventoryBtns[0]) inventoryBtns[0].classList.add('active');
      currentStock = 'available';
      (window.renderProducts || renderProducts)();
      const sec = document.getElementById('productListSection');
      if (sec) window.scrollTo({ top: sec.getBoundingClientRect().top + window.pageYOffset - 90, behavior: 'smooth' });
    });
  });
}

// ── Nav Drawer Category / Page Navigation ──
navItems.forEach(item => {
  item.addEventListener('click', (e) => {
    e.preventDefault();
    navItems.forEach(n => n.classList.remove('active'));
    item.classList.add('active');
    currentCategory = item.dataset.category;

    if (categoryPills) {
      categoryPills.querySelectorAll('.category-pill').forEach(p => {
        p.classList.toggle('active', p.dataset.filter === currentCategory);
      });
    }

    if (currentCategory === 'preorder') {
      if(inventoryBtns[0]) inventoryBtns[0].classList.remove('active');
      if(inventoryBtns[1]) inventoryBtns[1].classList.add('active');
      if(dynamicSections) dynamicSections.classList.add('hidden');
      if(preorderSec) preorderSec.classList.remove('hidden');
      currentStock = 'preorder';
    } else {
      if(inventoryBtns[1]) inventoryBtns[1].classList.remove('active');
      if(inventoryBtns[0]) inventoryBtns[0].classList.add('active');
      if(dynamicSections) dynamicSections.classList.remove('hidden');
      if(preorderSec) preorderSec.classList.add('hidden');
      currentStock = 'available';
    }
    
    closeNav();
    if (currentCategory !== 'preorder') {
      categoryPages[currentCategory] = 1;
      (window.renderProducts || renderProducts)();
    }
    const sec = currentCategory === 'preorder'
      ? document.getElementById('preorderSection')
      : document.getElementById('productListSection');
    const y = sec ? sec.getBoundingClientRect().top + window.pageYOffset - 90 : 0;
    window.scrollTo({ top: y, behavior: 'smooth' });
  });
});

// ── Mobile Nav ──
function openNav() {
  navDrawer.classList.add('open');
  navOverlay.classList.add('open');
  menuBtn.classList.add('active');
}
function closeNav() {
  navDrawer.classList.remove('open');
  navOverlay.classList.remove('open');
  menuBtn.classList.remove('active');
}
menuBtn.addEventListener('click', () => navDrawer.classList.contains('open') ? closeNav() : openNav());
navOverlay.addEventListener('click', closeNav);

// ── Sticky Header ──
window.addEventListener('scroll', () => header.classList.toggle('scrolled', window.scrollY > 10), { passive: true });

// ── Close Urgency Banner ──
if (closeBanner && urgencyBanner) {
  closeBanner.addEventListener('click', () => {
    urgencyBanner.style.maxHeight = urgencyBanner.scrollHeight + 'px';
    requestAnimationFrame(() => {
      urgencyBanner.style.transition = 'max-height .3s ease, opacity .3s ease, padding .3s ease';
      urgencyBanner.style.maxHeight = '0';
      urgencyBanner.style.opacity = '0';
      urgencyBanner.style.padding = '0 16px';
      urgencyBanner.style.overflow = 'hidden';
    });
  });
}

// ── Promo Carousel ──
(function initCarousel() {
  const track = document.getElementById('promoTrack');
  const dotsContainer = document.getElementById('promoDots');
  if (!track || !dotsContainer) return;
  const slides = track.querySelectorAll('.promo-carousel__slide');
  let current = 0;
  const total = slides.length;
  for (let i = 0; i < total; i++) {
    const dot = document.createElement('button');
    dot.className = 'promo-carousel__dot' + (i === 0 ? ' active' : '');
    dot.setAttribute('aria-label', `Slide ${i + 1}`);
    dot.addEventListener('click', () => goTo(i));
    dotsContainer.appendChild(dot);
  }
  function goTo(index) {
    current = ((index % total) + total) % total;
    track.style.transform = `translateX(-${current * 100}%)`;
    dotsContainer.querySelectorAll('.promo-carousel__dot').forEach((d, i) => d.classList.toggle('active', i === current));
  }
  // Expose carousel control globally for the arrow buttons
  window.__carouselGoTo = function(direction) {
    if (direction === 'prev') goTo(current - 1);
    else if (direction === 'next') goTo(current + 1);
    else if (typeof direction === 'number') goTo(direction);
  };
  setInterval(() => goTo((current + 1) % total), 4000);
  let startX = 0;
  track.addEventListener('touchstart', e => { startX = e.touches[0].clientX; }, { passive: true });
  track.addEventListener('touchend', e => {
    const diff = startX - e.changedTouches[0].clientX;
    if (Math.abs(diff) > 50) goTo(diff > 0 ? Math.min(current + 1, total - 1) : Math.max(current - 1, 0));
  }, { passive: true });
})();

// ── Cart State & LocalStorage ──
let cart = JSON.parse(localStorage.getItem('dcKidsCart')) || [];
function saveCart() { localStorage.setItem('dcKidsCart', JSON.stringify(cart)); }

// ── Cart DOM Refs ──
const cartBtn      = document.getElementById('cartBtn');
const cartDrawer   = document.getElementById('cartDrawer');
const cartOverlay  = document.getElementById('cartOverlay');
const closeCartBtn = document.getElementById('closeCartBtn');
const cartBody     = document.getElementById('cartBody');
const cartSubtotal = document.getElementById('cartSubtotal');
const checkoutBtn  = document.getElementById('checkoutBtn');

function openCart()  { if(cartDrawer) cartDrawer.classList.add('open');    if(cartOverlay) cartOverlay.classList.add('open');    renderCartDrawer(); }
function closeCart() { if(cartDrawer) cartDrawer.classList.remove('open'); if(cartOverlay) cartOverlay.classList.remove('open'); }
if(cartBtn)      cartBtn.addEventListener('click', openCart);
if(closeCartBtn) closeCartBtn.addEventListener('click', closeCart);
if(cartOverlay)  cartOverlay.addEventListener('click', closeCart);

// ── Cart Operations ──
function addToCart(id) {
  const selectEl   = document.getElementById(`size-select-${id}`);
  const product    = products.find(p => p.id === id);
  if (!product) return;
  const size          = selectEl ? selectEl.value : product.size;
  const adjustedPrice = getCardPrice(id) || product.price || 0;
  const isWholesale   = (storeMode === 'wholesale');
  const bulkQtyEl     = document.getElementById(`bulk-qty-${id}`);
  const qtyToAdd      = (isWholesale && bulkQtyEl) ? parseInt(bulkQtyEl.value) : 1;
  const existing      = cart.find(item => item.id === id && item.size === size);
  if (existing) { existing.qty += qtyToAdd; }
  else { cart.push({ id: product.id, name: product.name, size, price: adjustedPrice, qty: qtyToAdd, img: product.img, ws: isWholesale ? 1 : 0 }); }
  saveCart(); renderCartDrawer(); openCart();
}

function updateCartQty(index, change) {
  if (!cart[index]) return;
  // Wholesale lines step by the MOQ (they're bulk pieces, e.g. 10 at a time)
  // and can't drop below it — the server rejects sub-MOQ wholesale items.
  const item = cart[index];
  const moq = (item.ws && siteConfig.wholesale_moq) ? siteConfig.wholesale_moq : 1;
  item.qty += change * moq;
  if (item.qty < moq) cart.splice(index, 1);
  saveCart(); renderCartDrawer();
}

function removeFromCart(index) { cart.splice(index, 1); saveCart(); renderCartDrawer(); }

function renderCartDrawer() {
  if (!cartBody) return;
  const badgeEl = document.querySelector('.cart-badge') || document.querySelector('#cartCount') || document.querySelector('#cartBtn span');
  if (badgeEl) {
    const totalQty = cart.reduce((sum, item) => sum + item.qty, 0);
    badgeEl.innerText = totalQty > 99 ? '99+' : totalQty;
    badgeEl.style.display = totalQty > 0 ? 'flex' : 'none';
  }
  if (cart.length === 0) {
    cartBody.innerHTML = '<div style="padding:32px 24px;text-align:center;color:#999;font-size:15px;">Your cart is empty.<br><br>Add some amazing styles!</div>';
    if (cartSubtotal) cartSubtotal.innerText = 'GH₵ 0.00';
    return;
  }
  let html = '', subtotal = 0;
  cart.forEach((item, index) => {
    const itemTotal = item.price * item.qty;
    subtotal += itemTotal;
    html += `
      <div class="cart-item">
        <img src="${escapeStr(item.img || '')}" alt="${escapeStr(item.name || '')}" class="cart-item__img">
        <div class="cart-item__details">
          <div class="cart-item__title">${escapeStr(item.name || '')}</div>
          <div class="cart-item__size">${escapeStr(item.size || '')}${item.ws ? ' · Wholesale (' + item.qty + ' pcs)' : ''}</div>
          <div class="cart-item__price">GH₵ ${gh(item.price)}${item.ws ? ' <span style="font-size:11px;color:#888;">/pc</span>' : ''}</div>
        </div>
        <div class="cart-item__controls">
          <button class="cart-item__btn" onclick="updateCartQty(${index}, -1)">-</button>
          <span class="cart-item__qty">${item.qty}</span>
          <button class="cart-item__btn" onclick="updateCartQty(${index}, 1)">+</button>
        </div>
        <button class="cart-item__remove" onclick="removeFromCart(${index})">
          <svg viewBox="0 0 24 24"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6"/></svg>
        </button>
      </div>`;
  });
  cartBody.innerHTML = html;
  if (cartSubtotal) cartSubtotal.innerText = `GH₵ ${gh(subtotal)}`;
}

// ── Custom Checkout Modal ──
function showCheckoutModal() {
  return new Promise((resolve, reject) => {
    const modal   = document.getElementById('checkoutModal');
    const step1   = document.getElementById('checkoutStep1');
    const step2   = document.getElementById('checkoutStep2');
    const nameEl  = document.getElementById('checkoutName');
    const phoneEl = document.getElementById('checkoutPhone');
    const areaEl  = document.getElementById('checkoutArea');
    const notesEl = document.getElementById('checkoutNotes');
    const cancelBtn   = document.getElementById('checkoutModalCancel');
    const okBtn       = document.getElementById('checkoutModalOk');
    const continueBtn = document.getElementById('checkoutModalContinue');
    let data = null;

    step1.style.display = 'block';
    step2.style.display = 'none';
    nameEl.value = ''; phoneEl.value = '';
    if (areaEl) areaEl.value = '';
    if (notesEl) notesEl.value = '';
    nameEl.style.borderColor = '#e0e4e8';
    phoneEl.style.borderColor = '#e0e4e8';
    closeCart();
    modal.style.display = 'flex';
    modal.style.pointerEvents = 'auto';
    setTimeout(() => { nameEl.focus(); nameEl.click(); }, 150);

    function closeModal() {
      modal.style.display = 'none';
      cancelBtn.removeEventListener('click', onCancel);
      okBtn.removeEventListener('click', onOk);
      continueBtn.removeEventListener('click', onContinue);
    }
    function onCancel() { closeModal(); reject(); }
    function onOk() {
      const name  = nameEl.value.trim();
      const phone = phoneEl.value.trim();
      if (!name)  { nameEl.style.borderColor  = '#dc2626'; nameEl.focus();  return; }
      if (!phone) { phoneEl.style.borderColor = '#dc2626'; phoneEl.focus(); return; }
      data = {
        customer_name: name,
        customer_phone: phone,
        delivery_area: areaEl ? areaEl.value.trim() : '',
        notes: notesEl ? notesEl.value.trim() : ''
      };
      step1.style.display = 'none';
      step2.style.display = 'block';
    }
    function onContinue() { closeModal(); resolve(data); }

    cancelBtn.addEventListener('click', onCancel);
    okBtn.addEventListener('click', onOk);
    continueBtn.addEventListener('click', onContinue);
    modal.addEventListener('click', e => { if (e.target === modal) onCancel(); }, { once: true });
  });
}

// ── Receipt Step (Step 3) ──
function showReceiptStep(orderNumber, totalAmount, customerName, customerPhone, cartItems, whatsappURL) {
  const modal = document.getElementById('checkoutModal');
  const step1 = document.getElementById('checkoutStep1');
  const step2 = document.getElementById('checkoutStep2');
  const step3 = document.getElementById('checkoutStep3');

  // Hide previous steps, show receipt
  step1.style.display = 'none';
  step2.style.display = 'none';
  step3.style.display = 'block';
  modal.style.display = 'flex';
  modal.style.pointerEvents = 'auto';

  // Populate receipt data
  document.getElementById('receiptOrderNum').textContent = orderNumber;
  document.getElementById('receiptDate').textContent = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  document.getElementById('receiptCustomer').textContent = customerName;
  document.getElementById('receiptPhone').textContent = customerPhone;

  // Build items list
  const itemsEl = document.getElementById('receiptItems');
  itemsEl.innerHTML = '';
  cartItems.forEach(c => {
    const prod = products.find(p => p.id === c.id);
    if (!prod) return;
    // Use the price captured when the item was added — it already reflects the
    // chosen size (managed or legacy) and any wholesale discount, and matches
    // the authoritative total the server computed.
    const unitPrice = Math.round((c.price || 0) * 100) / 100;
    const lineTotal = unitPrice * c.qty;
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid #f3f4f6;font-size:13px;';
    row.innerHTML = `
      <div style="flex:1;">
        <div style="font-weight:600;color:#1f2937;">${prod.name}</div>
        <div style="font-size:11px;color:#9ca3af;">Size: ${c.size} &times; ${c.qty}</div>
      </div>
      <div style="font-weight:700;color:#0F4C3A;white-space:nowrap;">GH₵ ${lineTotal.toFixed(2)}</div>
    `;
    itemsEl.appendChild(row);
  });

  // Total
  document.getElementById('receiptTotal').textContent = `GH₵ ${Number(totalAmount).toFixed(2)}`;

  // Wire buttons
  const printBtn = document.getElementById('receiptPrintBtn');
  const waBtn = document.getElementById('receiptWhatsAppBtn');
  const closeBtn = document.getElementById('receiptCloseBtn');

  // Remove old listeners by cloning
  const newPrint = printBtn.cloneNode(true);
  const newWA = waBtn.cloneNode(true);
  const newClose = closeBtn.cloneNode(true);
  printBtn.parentNode.replaceChild(newPrint, printBtn);
  waBtn.parentNode.replaceChild(newWA, waBtn);
  closeBtn.parentNode.replaceChild(newClose, closeBtn);

  newPrint.addEventListener('click', () => window.print());
  newWA.addEventListener('click', () => window.open(whatsappURL, '_blank'));
  newClose.addEventListener('click', () => {
    modal.style.display = 'none';
    step3.style.display = 'none';
    step1.style.display = 'block'; // reset for next use
  });
}

// ── Checkout / Pre-Order API Integration ──
if (checkoutBtn) {
  checkoutBtn.addEventListener('click', async () => {
    if (cart.length === 0) { showToast('Your cart is empty!', 'warning'); return; }

    let customer_name, customer_phone, details;
    try {
      details = await showCheckoutModal();
      customer_name  = details.customer_name;
      customer_phone = details.customer_phone;
    } catch { return; }

    checkoutBtn.disabled = true;
    checkoutBtn.innerHTML = 'Processing...';

    // If any item is a preorder, mark the whole order as a preorder
    const hasPreorder = cart.some(c => {
        const prod = products.find(p => p.id === c.id);
        return prod && prod.fulfillment_type === 'preorder';
    });
    
    const order_type = hasPreorder ? 'preorder' : storeMode;
    const delivery_area = details.delivery_area || '';
    const order_notes = details.notes || '';

    // Snapshot cart for the WhatsApp message before it gets cleared
    const orderedItems = cart.map(c => ({ name: c.name, size: c.size, qty: c.qty, price: c.price }));

    const orderPayload = {
        customer_name,
        customer_phone,
        order_type: order_type,
        delivery_area: delivery_area,
        notes: order_notes,
        items: cart.map(c => ({ id: c.id, size: c.size, quantity: c.qty }))
    };

    try {
        const res = await fetch('/api/orders', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(orderPayload)
        });
        const data = await res.json();
        
        if (data.success) {
            // Build an itemised WhatsApp message
            let message = `Hello DC Kids! I'd like to confirm my order.\n\n`;
            message += `*Order Ref:* ${data.order_number}\n`;
            message += `*Name:* ${customer_name}\n`;
            if (delivery_area) message += `*Delivery area:* ${delivery_area}\n`;
            message += `\n*Items:*\n`;
            orderedItems.forEach(it => {
                message += `• ${it.qty} × ${it.name} (${it.size}) — GH₵ ${gh(it.price * it.qty)}\n`;
            });
            message += `\n*Total:* GH₵ ${gh(data.total_amount)}\n`;
            if (order_notes) message += `*Notes:* ${order_notes}\n`;
            message += `\n`;
            if (order_type === 'preorder') {
                message += `This includes China Pre-Order items. Please let me know the required deposit and next steps.`;
            } else {
                message += `Please let me know how to proceed with payment and delivery. Thank you!`;
            }
            const whatsappNum = siteConfig.whatsapp_number || '233549193805';
            const whatsappURL = `https://wa.me/${whatsappNum}?text=${encodeURIComponent(message)}`;

            // Show receipt (Step 3)
            showReceiptStep(data.order_number, data.total_amount, customer_name, customer_phone, cart, whatsappURL);

            // Clear cart
            cart = [];
            renderCartDrawer();
            closeCart();
        } else {
            showToast('Error submitting order: ' + (data.error || 'Unknown error'), 'error');
        }
    } catch (e) {
        showToast('Could not submit order: ' + e.message, 'error');
    } finally {
        checkoutBtn.disabled = false;
        checkoutBtn.innerHTML = `
          <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51a12.8 12.8 0 0 0-.57-.01c-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.82 9.82 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.81 11.81 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.88 11.88 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.82 11.82 0 0 0-3.48-8.413z"/></svg>
          Checkout via WhatsApp
        `;
    }
  });
}

// ── Initial Setup ──
async function initApp() {
  try {
    // Fetch Settings — always bypass any cache so banner/discount/WhatsApp changes
    // made in admin show up for shoppers on their next load (not a stale cached copy).
    try {
        const settingsRes = await fetch('/api/settings', { cache: 'no-store' });
        if (settingsRes.ok) {
            siteConfig = await settingsRes.json();
        }
    } catch (e) {
        console.warn("Could not load settings:", e);
    }

    const res = await fetch('/api/products');
    const contentType = res.headers.get('content-type') || '';
    if (res.ok && contentType.includes('application/json')) {
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        products = data;
        products.forEach(p => {
          if (p.cat === 'baby') p.cat = 'newborn';
          if (p.cat === 'bags') p.cat = 'accessories';
        });
      } else {
        throw new Error("Empty or invalid product list");
      }
    } else {
      throw new Error("API not returning JSON");
    }
  } catch (err) {
    console.warn("Using local fallback product data:", err.message);
    try {
      const fallbackRes = await fetch('products.json');
      if (fallbackRes.ok) {
        const fallbackData = await fallbackRes.json();
        if (Array.isArray(fallbackData) && fallbackData.length > 0) {
          products = fallbackData;
          products.forEach(p => {
            if (p.cat === 'baby') p.cat = 'newborn';
            if (p.cat === 'bags') p.cat = 'accessories';
          });
        } else { products = []; }
      } else { products = []; }
    } catch (e2) { products = []; }
  }

  // Drop cart lines whose product no longer exists in the catalogue (e.g. a
  // stale cart saved before a catalogue swap). Left in place they render with
  // old names/prices and the server rejects the whole order at checkout.
  if (Array.isArray(products) && products.length && cart.length) {
    const liveIds = new Set(products.map(p => Number(p.id)));
    const beforeCount = cart.length;
    cart = cart.filter(item => liveIds.has(Number(item.id)));
    if (cart.length !== beforeCount) { saveCart(); renderCartDrawer(); }
  }

  // Setup Search
  const storeSearchInput = document.getElementById('storeSearchInput');
  if (storeSearchInput) {
      storeSearchInput.addEventListener('input', (e) => {
          searchQuery = e.target.value;
          // Search spans the whole catalogue — drop any active category filter
          if (searchQuery) {
              currentCategory = 'all';
              if (categoryPills) categoryPills.querySelectorAll('.category-pill').forEach(p => p.classList.toggle('active', p.dataset.filter === 'all'));
          }
          categoryPages = {};
          preorderPage = 1;
          (window.renderProducts || renderProducts)();
      });
  }
  
  // Init Store Mode toggle
  if (storeMode === 'wholesale') {
    if (btnWholesale) btnWholesale.classList.add('active');
    if (btnRetail) btnRetail.classList.remove('active');
    document.body.classList.add('wholesale-theme');
  } else {
    if (btnRetail) btnRetail.classList.add('active');
    if (btnWholesale) btnWholesale.classList.remove('active');
    document.body.classList.remove('wholesale-theme');
  }

  function setStoreMode(mode) {
    storeMode = mode;
    localStorage.setItem('storeMode', mode);
    if (mode === 'wholesale') {
      if (btnWholesale) btnWholesale.classList.add('active');
      if (btnRetail) btnRetail.classList.remove('active');
      document.body.classList.add('wholesale-theme');
    } else {
      if (btnRetail) btnRetail.classList.add('active');
      if (btnWholesale) btnWholesale.classList.remove('active');
      document.body.classList.remove('wholesale-theme');
    }
    updateFloatingWaBtn();
    renderProducts();
  }

  if (btnRetail) btnRetail.addEventListener('click', () => setStoreMode('retail'));
  if (btnWholesale) btnWholesale.addEventListener('click', () => setStoreMode('wholesale'));

  // Apply site configurations
  if (siteConfig) {
      // Only touch the banner when settings actually loaded. If the settings
      // fetch failed (server hiccup / offline), 'banner_enabled' is absent —
      // leave the default HTML banner visible instead of blanking the top of the
      // page on a refresh. This was why the banner "sometimes disappeared".
      if ('banner_enabled' in siteConfig) {
          if (siteConfig.banner_enabled) {
              if (urgencyBanner) {
                  urgencyBanner.style.display = 'block';
                  const tracks = urgencyBanner.querySelectorAll('.banner-track');
                  if (tracks.length > 0 && siteConfig.banner_text) {
                      const content = `<i class="fas fa-bullhorn text-gray-600 text-sm" style="margin-right:8px;"></i> <strong>UPDATE:</strong> ${siteConfig.banner_text} &nbsp;&bull;&nbsp;`;
                      tracks.forEach(t => { t.innerHTML = content; });
                  }
              }
          } else {
              if (urgencyBanner) urgencyBanner.style.display = 'none';
          }
      }

      const storeModeBar = document.querySelector('.store-mode-bar');
      if (storeModeBar) {
          storeModeBar.style.display = siteConfig.wholesale_enabled ? 'flex' : 'none';
      }
      
      // If wholesale is disabled but we are in wholesale mode, force retail
      if (!siteConfig.wholesale_enabled && storeMode === 'wholesale') {
          setStoreMode('retail');
      }
  }
  applyWhatsAppNumber();
  updateFloatingWaBtn();

  renderProducts();
  renderCartDrawer();
  console.log(`DC Kids Brand loaded — ${products.length} products`);
}

initApp();

// ── Premium Selector Interactions ──
function togglePremiumSelector(triggerEl) {
  const selector = triggerEl.closest('.premium-selector');
  if (!selector) return;
  const wasOpen = selector.classList.contains('premium-selector--open');
  closeAllPremiumSelectors();
  if (!wasOpen) {
    selector.classList.add('premium-selector--open');
    triggerEl.setAttribute('aria-expanded', 'true');
  }
}

function premiumSelect(optionEl) {
  const selector = optionEl.closest('.premium-selector');
  if (!selector) return;
  const value = optionEl.dataset.value;
  const productId = selector.dataset.productId;
  const type = selector.dataset.type;

  selector.querySelectorAll('.premium-selector__option').forEach(o => o.classList.remove('premium-selector__option--selected'));
  optionEl.classList.add('premium-selector__option--selected');

  const hiddenInput = type === 'bulk'
    ? document.getElementById('bulk-qty-' + productId)
    : document.getElementById('size-select-' + productId);
  if (hiddenInput) hiddenInput.value = value;

  const label = selector.querySelector('.premium-selector__label');
  if (label) label.textContent = optionEl.querySelector('.premium-selector__option-text').textContent;

  setTimeout(() => {
    selector.classList.remove('premium-selector--open');
    const trigger = selector.querySelector('.premium-selector__trigger');
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
  }, 150);

  updateCardPrice(parseInt(productId));
}

function closeAllPremiumSelectors() {
  document.querySelectorAll('.premium-selector--open').forEach(s => {
    s.classList.remove('premium-selector--open');
    const trigger = s.querySelector('.premium-selector__trigger');
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
  });
}

document.addEventListener('click', function(e) {
  if (!e.target.closest('.premium-selector')) closeAllPremiumSelectors();
});

document.addEventListener('keydown', function(e) {
  const openSelector = document.querySelector('.premium-selector--open');
  if (!openSelector) {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('premium-selector__trigger')) {
      e.preventDefault();
      togglePremiumSelector(e.target);
    }
    return;
  }
  const options = Array.from(openSelector.querySelectorAll('.premium-selector__option:not(.premium-selector__option--unavailable)'));
  const current = openSelector.querySelector('.premium-selector__option--selected');
  let idx = options.indexOf(current);

  if (e.key === 'Escape') { closeAllPremiumSelectors(); e.preventDefault(); }
  else if (e.key === 'ArrowDown') { idx = Math.min(idx + 1, options.length - 1); premiumSelect(options[idx]); e.preventDefault(); }
  else if (e.key === 'ArrowUp') { idx = Math.max(idx - 1, 0); premiumSelect(options[idx]); e.preventDefault(); }
  else if (e.key === 'Enter' || e.key === ' ') { if (current) premiumSelect(current); e.preventDefault(); }
});

// ── Global Helper: Filter by category (used by "View all" links) ──
function filterByCategory(catId) {
  const pill = document.querySelector('[data-filter="' + catId + '"]');
  if (pill) pill.click();
}

/* ════════════════════════════════════════════════════════════════════════
   WISHLIST + REVIEWS — storefront integration
   ════════════════════════════════════════════════════════════════════════ */

// Local cache of wishlist product IDs (set). Mirrored to server when signed in.
let wishlistSet = new Set();
const WISHLIST_LS_KEY = 'dcKidsGuestWishlist';
const CUSTOMER_TOKEN_KEY = 'dcKidsCustomerToken';

function getCustomerToken() { return localStorage.getItem(CUSTOMER_TOKEN_KEY); }
function isSignedIn() { return !!getCustomerToken(); }

function loadGuestWishlist() {
  try { return new Set(JSON.parse(localStorage.getItem(WISHLIST_LS_KEY)) || []); }
  catch (e) { return new Set(); }
}
function saveGuestWishlist() {
  localStorage.setItem(WISHLIST_LS_KEY, JSON.stringify(Array.from(wishlistSet)));
}

async function syncWishlistState() {
  if (isSignedIn()) {
    try {
      const res = await fetch('/api/wishlist', { headers: { 'Authorization': 'Bearer ' + getCustomerToken() } });
      if (res.ok) {
        const rows = await res.json();
        wishlistSet = new Set(rows.map(r => Number(r.product_id)));
      }
    } catch (e) { /* fall back to guest set */ }
  } else {
    wishlistSet = loadGuestWishlist();
  }
  paintWishlistHearts();
}

function paintWishlistHearts() {
  document.querySelectorAll('.wishlist-heart').forEach(btn => {
    const id = Number(btn.getAttribute('data-wishlist-id'));
    btn.classList.toggle('is-active', wishlistSet.has(id));
  });
  updateWishlistCount();
  const drawer = document.getElementById('wishlistDrawer');
  if (drawer && drawer.classList.contains('open')) renderWishlist();
}

async function toggleWishlist(event, productId) {
  event.preventDefault();
  event.stopPropagation();
  const id = Number(productId);
  const wasActive = wishlistSet.has(id);
  // Optimistic UI
  if (wasActive) wishlistSet.delete(id); else wishlistSet.add(id);
  paintWishlistHearts();

  if (isSignedIn()) {
    try {
      const headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + getCustomerToken() };
      if (wasActive) {
        await fetch('/api/wishlist/' + id, { method: 'DELETE', headers });
      } else {
        await fetch('/api/wishlist', { method: 'POST', headers, body: JSON.stringify({ product_id: id }) });
      }
    } catch (e) {
      // Revert on error
      if (wasActive) wishlistSet.add(id); else wishlistSet.delete(id);
      paintWishlistHearts();
    }
  } else {
    saveGuestWishlist();
    if (!wasActive) showToast('Saved to wishlist', 'success');
  }
}

/* ── Wishlist panel (opened from the hamburger menu) ── */
function updateWishlistCount() {
  const el = document.getElementById('wishlistNavCount');
  if (!el) return;
  const n = wishlistSet.size;
  el.textContent = n;
  el.style.display = n > 0 ? 'inline-flex' : 'none';
}

function openWishlist() {
  closeNav();
  renderWishlist();
  const drawer = document.getElementById('wishlistDrawer');
  const overlay = document.getElementById('wishlistOverlay');
  if (drawer) drawer.classList.add('open');
  if (overlay) overlay.classList.add('open');
}

function closeWishlist() {
  const drawer = document.getElementById('wishlistDrawer');
  const overlay = document.getElementById('wishlistOverlay');
  if (drawer) drawer.classList.remove('open');
  if (overlay) overlay.classList.remove('open');
}

function renderWishlist() {
  const body = document.getElementById('wishlistBody');
  if (!body) return;
  const items = products.filter(p => wishlistSet.has(Number(p.id)));
  if (items.length === 0) {
    body.innerHTML = '<div style="padding:32px 24px;text-align:center;color:#999;font-size:15px;line-height:1.7;">Your wishlist is empty.<br>Tap the ♥ on any product to save it here.</div>';
    return;
  }
  body.innerHTML = items.map(p => `
    <div class="cart-item">
      <img src="${escapeStr(p.img || '')}" alt="${escapeStr(p.name || '')}" class="cart-item__img">
      <div class="cart-item__details">
        <div class="cart-item__title">${escapeStr(p.name || '')}</div>
        <div class="cart-item__price">${p.price ? 'GH₵ ' + gh(p.price) : 'Ask for price'}</div>
        <button type="button" onclick="closeWishlist(); addToCart(${p.id});" style="margin-top:8px;background:#0F4C3A;color:#fff;border:none;border-radius:8px;padding:7px 14px;font-size:13px;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;gap:6px;">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><circle cx="9" cy="21" r="1"></circle><circle cx="20" cy="21" r="1"></circle><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"></path></svg>
          Add to Cart
        </button>
      </div>
      <button class="cart-item__remove" aria-label="Remove from wishlist" onclick="toggleWishlist(event, ${p.id})">
        <svg viewBox="0 0 24 24"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6"/></svg>
      </button>
    </div>`).join('');
}

/* ── Reviews ── */

// Cached review summaries by product id, used to render the star line on cards.
const reviewSummaryCache = new Map();

async function loadReviewSummaries(productIds) {
  // Repaint anything already cached FIRST. The rating row is re-rendered as
  // display:none on every grid rebuild (mode toggle, category filter,
  // pagination, search), so without repainting here the rating silently
  // disappears on any re-render once summaries are cached.
  productIds.forEach(id => { if (reviewSummaryCache.has(id)) paintProductRating(id); });

  // One request for the whole batch — a per-product fetch (267 separate
  // round trips on the full catalog) meant any single slow/failed request
  // left that one card permanently unrated for the page load.
  const ids = productIds.filter(id => !reviewSummaryCache.has(id));
  if (!ids.length) return;
  try {
    const res = await fetch('/api/products/reviews-summary?ids=' + ids.join(','));
    if (res.ok) {
      const data = await res.json();
      ids.forEach(id => {
        reviewSummaryCache.set(id, data[id] || { count: 0, average: 0 });
        paintProductRating(id);
      });
      return;
    }
  } catch (e) { /* fall through to per-product */ }
  // Fallback for a server that predates the batch endpoint (e.g. not yet
  // restarted): fetch each summary individually so ratings still appear.
  await loadReviewSummariesIndividually(ids);
}

async function loadReviewSummariesIndividually(ids) {
  const queue = ids.slice();
  while (queue.length) {
    const batch = queue.splice(0, 6);
    await Promise.all(batch.map(async (id) => {
      try {
        const res = await fetch('/api/products/' + id + '/reviews');
        if (!res.ok) return;
        const data = await res.json();
        reviewSummaryCache.set(id, data.summary || { count: 0, average: 0 });
        paintProductRating(id);
      } catch (e) { /* silent */ }
    }));
  }
}
function paintProductRating(id) {
  const sum = reviewSummaryCache.get(id);
  const starsEl = document.querySelector('[data-stars-for="' + id + '"]');
  const countEl = document.querySelector('[data-count-for="' + id + '"]');
  if (!starsEl || !countEl || !sum) return;
  const wrap = starsEl.closest('.product-card__rating');
  // Every product accepts reviews, even with zero so far — show a "write a
  // review" invite instead of a fake average rather than hiding the button.
  if (!sum.count) {
    starsEl.textContent = '☆☆☆☆☆';
    starsEl.classList.remove('has-reviews');
    countEl.textContent = 'Write a review';
    if (wrap) wrap.style.display = '';
    return;
  }
  const full = Math.round(sum.average);
  starsEl.textContent = '★★★★★☆☆☆☆☆'.slice(5 - full, 10 - full);
  starsEl.classList.add('has-reviews');
  countEl.textContent = sum.average.toFixed(1) + ' (' + sum.count + ')';
  if (wrap) wrap.style.display = '';
}

/* ── Reviews modal ── */
function ensureReviewsModal() {
  if (document.getElementById('reviews-modal')) return;
  const modal = document.createElement('div');
  modal.id = 'reviews-modal';
  modal.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:9500;align-items:center;justify-content:center;padding:20px;';
  modal.innerHTML = `
    <div style="background:#fff;border-radius:18px;max-width:560px;width:100%;padding:24px;max-height:90vh;overflow-y:auto;font-family:'Inter',sans-serif;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
        <h3 id="rv-modal-title" style="margin:0;font-size:18px;font-weight:700;color:#0F4C3A;font-family:'Playfair Display',serif;">Product</h3>
        <button type="button" id="rv-close" style="background:none;border:none;font-size:24px;cursor:pointer;color:#888;line-height:1;padding:4px;">&times;</button>
      </div>
      <div id="rv-description" style="display:none;font-size:13px;color:#555;line-height:1.6;margin-bottom:16px;"></div>
      <div style="font-size:12px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:0.6px;margin-bottom:8px;">Reviews</div>
      <div id="rv-summary" style="display:flex;align-items:center;gap:12px;padding:12px 14px;background:#FFF5F7;border-radius:12px;margin-bottom:18px;">
        <div id="rv-avg" style="font-size:28px;font-weight:700;color:#fc4c7a;">—</div>
        <div>
          <div id="rv-stars" style="color:#fc4c7a;font-size:16px;letter-spacing:2px;">☆☆☆☆☆</div>
          <div id="rv-count" style="font-size:12px;color:#888;margin-top:2px;">No reviews yet</div>
        </div>
      </div>
      <div id="rv-list" style="max-height:280px;overflow-y:auto;margin-bottom:18px;"></div>
      <details id="rv-write-wrap" style="border-top:1px solid #EEE;padding-top:14px;">
        <summary style="cursor:pointer;font-weight:600;color:#fc4c7a;font-size:14px;">Write a review</summary>
        <form id="rv-form" style="margin-top:12px;">
          <div style="margin-bottom:10px;">
            <label style="font-size:12px;font-weight:600;color:#444;text-transform:uppercase;letter-spacing:0.4px;display:block;margin-bottom:6px;">Your rating</label>
            <div id="rv-rating-input" style="display:flex;gap:4px;font-size:24px;cursor:pointer;color:#DDD;">
              <span data-rate="1">★</span><span data-rate="2">★</span><span data-rate="3">★</span><span data-rate="4">★</span><span data-rate="5">★</span>
            </div>
          </div>
          <div style="margin-bottom:10px;">
            <label style="font-size:12px;font-weight:600;color:#444;text-transform:uppercase;letter-spacing:0.4px;display:block;margin-bottom:6px;">Your name</label>
            <input id="rv-author" type="text" placeholder="Akua" style="width:100%;padding:10px 12px;border:1px solid #DDD;border-radius:10px;font-size:13px;font-family:inherit;">
          </div>
          <div style="margin-bottom:10px;">
            <label style="font-size:12px;font-weight:600;color:#444;text-transform:uppercase;letter-spacing:0.4px;display:block;margin-bottom:6px;">Title (optional)</label>
            <input id="rv-title" type="text" placeholder="Love this!" style="width:100%;padding:10px 12px;border:1px solid #DDD;border-radius:10px;font-size:13px;font-family:inherit;">
          </div>
          <div style="margin-bottom:12px;">
            <label style="font-size:12px;font-weight:600;color:#444;text-transform:uppercase;letter-spacing:0.4px;display:block;margin-bottom:6px;">Your review</label>
            <textarea id="rv-body" required minlength="4" rows="4" placeholder="Tell other parents what you thought…" style="width:100%;padding:10px 12px;border:1px solid #DDD;border-radius:10px;font-size:13px;font-family:inherit;resize:vertical;"></textarea>
          </div>
          <button type="submit" style="width:100%;padding:12px;background:#fc4c7a;color:#fff;border:none;border-radius:12px;font-weight:600;cursor:pointer;font-family:inherit;">Submit review</button>
        </form>
      </details>
    </div>`;
  document.body.appendChild(modal);
  document.getElementById('rv-close').addEventListener('click', () => modal.style.display = 'none');
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.style.display = 'none'; });

  // Star input
  let chosenRating = 0;
  modal.querySelectorAll('#rv-rating-input span').forEach(s => {
    s.addEventListener('click', () => {
      chosenRating = Number(s.getAttribute('data-rate'));
      modal.querySelectorAll('#rv-rating-input span').forEach(x => {
        x.style.color = Number(x.getAttribute('data-rate')) <= chosenRating ? '#fc4c7a' : '#DDD';
      });
    });
  });
  modal.__getRating = () => chosenRating;
  modal.__resetRating = () => { chosenRating = 0; modal.querySelectorAll('#rv-rating-input span').forEach(x => x.style.color = '#DDD'); };

  // Submit
  document.getElementById('rv-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pid = modal.__productId;
    const rating = modal.__getRating();
    if (!rating) { showToast('Please tap a star to rate this product', 'warning'); return; }
    const body = {
      rating,
      author_name: document.getElementById('rv-author').value.trim() || 'Anonymous',
      title: document.getElementById('rv-title').value.trim(),
      body: document.getElementById('rv-body').value.trim()
    };
    const headers = { 'Content-Type': 'application/json' };
    if (isSignedIn()) headers['Authorization'] = 'Bearer ' + getCustomerToken();
    try {
      const res = await fetch('/api/products/' + pid + '/reviews', { method: 'POST', headers, body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to submit');
      showToast('Thank you for your review!', 'success');
      document.getElementById('rv-form').reset();
      modal.__resetRating();
      reviewSummaryCache.delete(Number(pid));
      await loadReviewSummaries([Number(pid)]);
      openReviewsModal(pid, modal.__productName); // refresh
    } catch (err) { showToast(err.message, 'error'); }
  });
}

async function openReviewsModal(productId, productName) {
  ensureReviewsModal();
  const modal = document.getElementById('reviews-modal');
  modal.__productId = productId;
  modal.__productName = productName;
  document.getElementById('rv-modal-title').textContent = productName || 'Product';

  const product = products.find(p => p.id === productId);
  const descEl = document.getElementById('rv-description');
  if (product && product.description) {
    descEl.textContent = product.description;
    descEl.style.display = 'block';
  } else {
    descEl.style.display = 'none';
  }

  document.getElementById('rv-list').innerHTML = '<div style="text-align:center;color:#888;padding:24px;font-size:13px;">Loading…</div>';
  modal.style.display = 'flex';

  try {
    const res = await fetch('/api/products/' + productId + '/reviews');
    const data = await res.json();
    document.getElementById('rv-avg').textContent = data.summary.count ? data.summary.average.toFixed(1) : '—';
    const stars = '★★★★★☆☆☆☆☆'.slice(5 - Math.round(data.summary.average || 0), 10 - Math.round(data.summary.average || 0));
    document.getElementById('rv-stars').textContent = stars;
    document.getElementById('rv-count').textContent = data.summary.count ? data.summary.count + ' review' + (data.summary.count === 1 ? '' : 's') : 'No reviews yet — be the first!';

    const listEl = document.getElementById('rv-list');
    if (!data.reviews.length) {
      listEl.innerHTML = '<div style="text-align:center;color:#888;padding:18px;font-size:13px;">No reviews yet — leave the first one below.</div>';
    } else {
      listEl.innerHTML = data.reviews.map(r => {
        const rstars = '★★★★★☆☆☆☆☆'.slice(5 - r.rating, 10 - r.rating);
        const date = r.created_at ? new Date(r.created_at).toLocaleDateString() : '';
        return `<div style="padding:12px 0;border-bottom:1px solid #F4F4F4;">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <div style="font-weight:700;font-size:13px;color:#222;">${escapeStr(r.author_name)}</div>
            <div style="color:#fc4c7a;font-size:12px;letter-spacing:1.5px;">${rstars}</div>
          </div>
          ${r.title ? '<div style="font-size:13px;font-weight:600;color:#444;margin-top:4px;">' + escapeStr(r.title) + '</div>' : ''}
          <div style="font-size:13px;color:#444;margin-top:4px;line-height:1.5;">${escapeStr(r.body)}</div>
          <div style="font-size:11px;color:#999;margin-top:6px;">${date}</div>
        </div>`;
      }).join('');
    }
  } catch (e) {
    document.getElementById('rv-list').innerHTML = '<div style="text-align:center;color:#dc2626;padding:18px;font-size:13px;">Could not load reviews.</div>';
  }
}

/* ── Hooks: load wishlist/review data whenever the grid re-renders ── */
const _origRenderProducts = typeof renderProducts === 'function' ? renderProducts : null;
if (_origRenderProducts) {
  window.renderProducts = function () {
    const out = _origRenderProducts.apply(this, arguments);
    paintWishlistHearts();
    const ids = Array.from(document.querySelectorAll('[data-rating-id]')).map(el => Number(el.getAttribute('data-rating-id')));
    if (ids.length) loadReviewSummaries(ids);
    return out;
  };
}

// Minimal toast for storefront (fallback if not present elsewhere)
function showToast(msg, kind) {
  const el = document.createElement('div');
  el.textContent = msg;
  el.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:' + (kind === 'error' ? '#dc2626' : kind === 'warning' ? '#d97706' : kind === 'info' ? '#0F4C3A' : '#5E9C7E') + ';color:#fff;padding:10px 18px;border-radius:10px;font-size:13px;z-index:9999;box-shadow:0 8px 28px rgba(0,0,0,0.18);font-family:Inter,sans-serif;';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2500);
}
function escapeStr(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]); }

// Boot wishlist sync once on page load (after grid first renders)
window.addEventListener('load', () => { setTimeout(syncWishlistState, 200); });

/* ── Input guards: block wrong character class in fields ──
   number fields: block e/E/+/- (and "." on integer fields);
   tel fields: digits and + - ( ) space only; person-name fields: block digits. */
(function installInputGuards() {
  var LETTERS_ONLY_IDS = ['checkoutName', 'rv-author'];
  function setFiltered(el, cleaned) {
    var caret = el.selectionStart, removed = el.value.length - cleaned.length;
    el.value = cleaned;
    try { el.setSelectionRange(caret - removed, caret - removed); } catch (e) {}
  }
  document.addEventListener('keydown', function (e) {
    var el = e.target;
    if (!el || el.tagName !== 'INPUT' || (el.type || '').toLowerCase() !== 'number') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    var allowsDecimal = /\./.test(el.getAttribute('step') || '') || el.getAttribute('inputmode') === 'decimal';
    if (e.key === 'e' || e.key === 'E' || e.key === '+' || e.key === '-') { e.preventDefault(); return; }
    if (e.key === '.' && !allowsDecimal) { e.preventDefault(); }
  });
  document.addEventListener('input', function (e) {
    var el = e.target;
    if (!el || el.tagName !== 'INPUT') return;
    if ((el.type || '').toLowerCase() === 'tel') {
      var phone = el.value.replace(/[^0-9+\-()\s]/g, '');
      if (phone !== el.value) setFiltered(el, phone);
    } else if (LETTERS_ONLY_IDS.indexOf(el.id) !== -1) {
      var letters = el.value.replace(/[0-9]/g, '');
      if (letters !== el.value) setFiltered(el, letters);
    }
  });
})();

/* ============================================================
   DYNAMIC STOREFRONT CATEGORY NAV
   Rebuilds the category pills + side-drawer from the owner's
   managed category list (shared via same-origin localStorage)
   merged with categories present on products — so categories the
   owner adds (e.g. "ROCKS") appear in the storefront immediately.
   ============================================================ */
(function () {
  'use strict';
  function escH(s){ return String(s==null?'':s).replace(/[&<>"']/g, function(m){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m];}); }

  var PILL_ICON = {
    newborn:'fa-baby', clothing:'fa-tshirt', shoes:'fa-shoe-prints',
    feeding:'fa-bottle-water', gear:'fa-baby-carriage', bathcare:'fa-bath',
    essentials:'fa-hand-holding-heart', accessories:'fa-shopping-bag', bedding:'fa-bed'
  };

  function storefrontCats() {
    var out = [], seen = {};
    function push(id, label){
      if (!id || id === 'preorder' || seen[id]) return;
      seen[id] = 1;
      var lbl = label
        || (typeof KNOWN_CATEGORY_LABELS !== 'undefined' && KNOWN_CATEGORY_LABELS[id])
        || (typeof humanizeCategory === 'function' ? humanizeCategory(id) : id);
      out.push({ id: id, label: lbl });
    }
    var stored = [];
    try { stored = getStoredCategoryList() || []; } catch (e) {}
    if (stored.length) {
      // The owner's managed list is the source of truth (so deletes stick).
      stored.forEach(function (c) { if (c && c.id) push(c.id, c.label); });
    } else {
      // No managed list yet → fall back to built-in defaults.
      try { (categoryMap || []).forEach(function (c) { push(c.id, c.label); }); } catch (e) {}
    }
    // Any category that actually has products always shows — even for shoppers
    // whose browser doesn't have the managed list (it's product data, server-side).
    try { (Array.isArray(products) ? products : []).forEach(function (p) { if (p.cat) push(p.cat); }); } catch (e) {}
    // Hide categories with nothing in them — an empty grid reads as broken to
    // shoppers. Only filter once the catalogue has loaded, so a failed fetch
    // can't blank out the nav.
    if (Array.isArray(products) && products.length) {
      var have = {};
      products.forEach(function (p) { if (p.cat) have[p.cat] = 1; });
      out = out.filter(function (c) { return have[c.id]; });
    }
    return out;
  }

  function selectCategory(cat) {
    try { currentCategory = cat; } catch (e) {}
    try { categoryPages[cat] = 1; } catch (e) {}
    if (typeof inventoryBtns !== 'undefined' && inventoryBtns) {
      if (inventoryBtns[1]) inventoryBtns[1].classList.remove('active');
      if (inventoryBtns[0]) inventoryBtns[0].classList.add('active');
    }
    if (typeof dynamicSections !== 'undefined' && dynamicSections) dynamicSections.classList.remove('hidden');
    if (typeof preorderSec !== 'undefined' && preorderSec) preorderSec.classList.add('hidden');
    try { currentStock = 'available'; } catch (e) {}
    if (categoryPills) categoryPills.querySelectorAll('.category-pill').forEach(function (p) {
      p.classList.toggle('active', (p.getAttribute('data-filter') || 'all') === cat);
    });
    if (navDrawer) navDrawer.querySelectorAll('.nav-drawer__item[data-category]').forEach(function (n) {
      n.classList.toggle('active', (n.getAttribute('data-category') || '') === cat);
    });
    (window.renderProducts || renderProducts)();
    var sec = document.getElementById('productListSection');
    if (sec) window.scrollTo({ top: sec.getBoundingClientRect().top + window.pageYOffset - 90, behavior: 'smooth' });
  }

  function rebuildPills() {
    if (!categoryPills) return;
    var cats = storefrontCats();
    var active = (typeof currentCategory !== 'undefined' && currentCategory) ? currentCategory : 'all';
    var html = '<a href="#all" class="category-pill flex items-center gap-2 px-5 py-2.5 rounded-full border text-sm font-medium transition-all' + (active === 'all' ? ' active' : '') + '" data-filter="all"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.8"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg> All</a>';
    html += cats.map(function (c) {
      var ic = PILL_ICON[c.id] || 'fa-tag';
      return '<a href="#' + escH(c.id) + '" class="category-pill flex items-center gap-2 px-5 py-2.5 rounded-full border bg-white text-gray-600 border-gray-100 hover:bg-gray-50 text-sm font-medium transition-all' + (active === c.id ? ' active' : '') + '" data-filter="' + escH(c.id) + '"><i class="fas ' + ic + ' text-xs opacity-80"></i> ' + escH(c.label) + '</a>';
    }).join('');
    categoryPills.innerHTML = html;
  }

  function rebuildNav() {
    if (!navDrawer) return;
    var cats = storefrontCats();
    // Preserve each category's ORIGINAL glyph icon: snapshot the existing SVG by
    // category id, then drop the originals (so their old click handlers don't
    // double-fire with the delegated one). New categories get a generic tag.
    var iconById = {};
    navDrawer.querySelectorAll('.nav-drawer__item[data-category]').forEach(function (n) {
      var dc = n.getAttribute('data-category');
      if (dc === 'all' || dc === 'preorder') return;
      var svg = n.querySelector('svg');
      if (svg && !iconById[dc]) iconById[dc] = svg.outerHTML;
      n.parentNode.removeChild(n);
    });
    var allItem = navDrawer.querySelector('.nav-drawer__item[data-category="all"]');
    var anchor = allItem ? allItem.nextSibling : null;
    var tagSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="24" height="24"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>';
    cats.forEach(function (c) {
      var a = document.createElement('a');
      a.href = '#' + c.id;
      a.className = 'nav-drawer__item';
      a.setAttribute('data-category', c.id);
      a.innerHTML = (iconById[c.id] || tagSvg) + ' ' + escH(c.label);
      if (allItem) navDrawer.insertBefore(a, anchor); else navDrawer.appendChild(a);
    });
  }

  function wireDelegation() {
    if (categoryPills && !categoryPills.__catDeleg) {
      categoryPills.__catDeleg = true;
      categoryPills.addEventListener('click', function (e) {
        var pill = e.target.closest('.category-pill');
        if (!pill || !categoryPills.contains(pill)) return;
        e.preventDefault();
        selectCategory(pill.getAttribute('data-filter') || 'all');
      });
    }
    if (navDrawer && !navDrawer.__catDeleg) {
      navDrawer.__catDeleg = true;
      navDrawer.addEventListener('click', function (e) {
        var item = e.target.closest('.nav-drawer__item[data-category]');
        if (!item || !navDrawer.contains(item)) return;
        var cat = item.getAttribute('data-category');
        if (cat === 'all' || cat === 'preorder') return; // originals handle these
        e.preventDefault();
        if (typeof closeNav === 'function') closeNav();
        selectCategory(cat);
      });
    }
  }

  function syncCategoryNav() { rebuildPills(); rebuildNav(); wireDelegation(); }
  window.syncCategoryNav = syncCategoryNav;

  // Re-sync the storefront nav + grid whenever the category list changes.
  function resync() {
    try { syncCategoryNav(); } catch (e) {}
    try { (window.renderProducts || renderProducts)(); } catch (e) {}
  }
  // Fires when the admin (another tab, same browser) adds/renames/deletes a category.
  window.addEventListener('storage', function (e) {
    if (!e || e.key === 'dcKidsCategories' || e.key === null) resync();
  });
  // Catch changes made in this same tab (storage event doesn't fire for the writer).
  window.addEventListener('focus', resync);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) resync(); });

  document.addEventListener('DOMContentLoaded', function () {
    setTimeout(syncCategoryNav, 600);
    setTimeout(syncCategoryNav, 1800);
  });
})();

