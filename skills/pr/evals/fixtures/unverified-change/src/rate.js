export function applyDiscount(price, pct) {
  return price - price * pct; // changed: pct is now a fraction, was a percentage
}
