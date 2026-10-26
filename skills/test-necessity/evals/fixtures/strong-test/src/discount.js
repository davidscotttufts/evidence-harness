export function discount(price, rate) {
  if (rate < 0 || rate > 1) throw new RangeError('rate');
  return Math.round(price * (1 - rate) * 100) / 100;
}
