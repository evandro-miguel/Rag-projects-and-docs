const TAX_RATE = 0.12;

export function computeOrderTotal(subtotal: number): number {
  return subtotal + subtotal * TAX_RATE;
}
