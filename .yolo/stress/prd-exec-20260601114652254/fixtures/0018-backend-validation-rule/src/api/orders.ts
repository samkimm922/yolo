export function validateOrder(input) {
  if (!input.customerId) return { ok: false, error: 'customer required' };
  return { ok: true };
}
