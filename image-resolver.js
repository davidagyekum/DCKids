(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.DCImageResolver = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const CATEGORY_IMAGES = Object.freeze({
    newborn: 'images/category-fallbacks/newborn.webp',
    clothing: 'images/category-fallbacks/clothing.webp',
    shoes: 'images/category-fallbacks/shoes.webp',
    footwear: 'images/category-fallbacks/shoes.webp',
    feeding: 'images/category-fallbacks/feeding.webp',
    gear: 'images/category-fallbacks/gear.webp',
    bathcare: 'images/category-fallbacks/bathcare.webp',
    essentials: 'images/category-fallbacks/essentials.webp',
    accessories: 'images/category-fallbacks/accessories.webp',
    bedding: 'images/category-fallbacks/bedding.webp'
  });
  const PLACEHOLDER = 'images/placeholder.svg';

  function normalizePath(value) {
    return String(value || '').trim().replace(/\\/g, '/').toLowerCase().split(/[?#]/)[0];
  }

  function isCategoryImage(img) {
    const value = normalizePath(img);
    return Object.values(CATEGORY_IMAGES).some((path) => normalizePath(path) === value);
  }

  function isKnownLogoPlaceholder(img) {
    const value = normalizePath(img);
    return /(^|\/)product_(?:1|5\d|6\d|7\d|8[0-3])\.jpg$/.test(value);
  }

  function isGenuineImage(img) {
    const value = normalizePath(img);
    if (!value) return false;
    return !isCategoryImage(value) &&
      !/(^|\/)placeholder\.(svg|png|jpe?g|webp)$/.test(value) &&
      !isKnownLogoPlaceholder(value);
  }

  function resolve(product) {
    const item = product || {};
    if (isCategoryImage(item.img)) return { src: item.img, isCategoryFallback: true };
    if (isGenuineImage(item.img)) return { src: item.img, isCategoryFallback: false };
    const categoryImage = CATEGORY_IMAGES[String(item.cat || '').toLowerCase()];
    return { src: categoryImage || PLACEHOLDER, isCategoryFallback: !!categoryImage };
  }

  return { CATEGORY_IMAGES, PLACEHOLDER, normalizePath, isCategoryImage, isKnownLogoPlaceholder, isGenuineImage, resolve };
});
