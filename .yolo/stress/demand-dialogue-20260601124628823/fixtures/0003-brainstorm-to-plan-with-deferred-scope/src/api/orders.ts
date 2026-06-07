export function validateOrder(input) {
  if (!input.customerId) return { ok: false, error: 'customer required' };
  const lines = Array.isArray(input.lines) ? input.lines : [];
  return { ok: true, lines };
}
