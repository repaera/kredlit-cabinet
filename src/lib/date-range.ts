const DAY = 86_400_000;

export function clampExportRange(dateFrom?: string, dateTo?: string, now = new Date()): { from: string; to: string; clamped: boolean } {
  const to = dateTo ? new Date(`${dateTo}T23:59:59.999Z`) : now;
  if (Number.isNaN(to.valueOf())) throw new Error('Invalid dateTo');
  const earliest = new Date(to.valueOf() - 90 * DAY);
  const requested = dateFrom ? new Date(`${dateFrom}T00:00:00.000Z`) : earliest;
  if (Number.isNaN(requested.valueOf()) || requested > to) throw new Error('Invalid date range');
  const clamped = requested < earliest;
  return { from: (clamped ? earliest : requested).toISOString(), to: to.toISOString(), clamped };
}
