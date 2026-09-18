import type { LocationField } from '../types/flow.ts';

const fieldCodes = { locationId: 'l', fromLocationId: 'f', toLocationId: 't' } as const;
const fieldsByCode = { l: 'locationId', f: 'fromLocationId', t: 'toLocationId' } as const;

export function encodeLocationCallback(pendingActionId: string, field: LocationField, locationShortId: string): string {
  const value = `da:${pendingActionId}:${fieldCodes[field]}:${locationShortId}`;
  if (new TextEncoder().encode(value).length > 64) throw new Error('Telegram callback_data exceeds 64 bytes');
  return value;
}

export function decodeLocationCallback(value: string): { pendingActionId: string; field: LocationField; locationShortId: string } | null {
  const match = /^da:([^:]+):([lft]):([^:]+)$/.exec(value);
  if (!match) return null;
  return { pendingActionId: match[1], field: fieldsByCode[match[2] as keyof typeof fieldsByCode], locationShortId: match[3] };
}
