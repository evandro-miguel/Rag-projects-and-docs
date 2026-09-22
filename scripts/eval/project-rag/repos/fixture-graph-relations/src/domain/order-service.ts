import { computeOrderTotal } from './price-calculator';

export function createOrder(subtotal: number) {
  const total = computeOrderTotal(subtotal);
  return { total, status: 'created' };
}
