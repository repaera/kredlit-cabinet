export function toBase(quantity: number, conversionToBase: number): number {
  const converted = quantity * conversionToBase;
  if (!Number.isSafeInteger(converted) || converted < 0) throw new Error('Quantity must convert to a whole base-unit amount');
  return converted;
}

export function fromBase(quantity: number, conversionToBase: number): number {
  return quantity / conversionToBase;
}
