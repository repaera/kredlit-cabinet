export type ConfirmClassification = 'CONFIRM' | 'CANCEL' | 'UNCLEAR';

const confirmations = new Set(['ya', 'iya', 'yes', 'ok', 'okay', 'gas', 'confirm']);
const cancellations = new Set(['batal', 'cancel', 'no', 'tidak', 'gajadi', 'ga jadi', 'nggak jadi']);

export function classifyConfirmation(text: string): ConfirmClassification {
  const value = text.trim().toLocaleLowerCase();
  return confirmations.has(value) ? 'CONFIRM' : cancellations.has(value) ? 'CANCEL' : 'UNCLEAR';
}
