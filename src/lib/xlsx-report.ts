import * as XLSX from 'xlsx';

export interface ReportRow {
  createdAt: string;
  item: string;
  location: string;
  type: string;
  quantity: number;
  source: string;
  externalOrderId: string;
}

export function buildWorkbook(rows: ReportRow[]): Uint8Array {
  const sheet = XLSX.utils.json_to_sheet(rows, { header: ['createdAt', 'item', 'location', 'type', 'quantity', 'source', 'externalOrderId'] });
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Transactions');
  return new Uint8Array(XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }));
}
