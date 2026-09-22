import { createOrder } from '../domain/order-service';

export function submitOrder(subtotal: number) {
  return createOrder(subtotal);
}
