export function resolveThreshold(locationOverride: number | null, itemDefault: number | null): number | null {
  return locationOverride ?? itemDefault;
}
