import { NodeError } from '@pulseflow/engine';

/** RFC 4180 parser: quoted fields, escaped quotes, embedded newlines, CRLF/LF, optional BOM. */
export function parseCsv(input: string, delimiter = ','): string[][] {
  if (delimiter.length !== 1) throw new NodeError('INVALID_DELIMITER', 'Delimiter must be a single character');
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === '') {
      inQuotes = true;
      i++;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
      i++;
    } else if (ch === '\n' || ch === '\r') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
    } else {
      field += ch;
      i++;
    }
  }
  if (inQuotes) throw new NodeError('CSV_PARSE_ERROR', 'Unterminated quoted field');
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

export function csvToObjects(input: string, delimiter = ','): Record<string, string>[] {
  const rows = parseCsv(input, delimiter);
  const header = rows.shift();
  if (!header) return [];
  const names = header.map((h, i) => h.trim() || `column${i + 1}`);
  return rows.map((r) => {
    const obj: Record<string, string> = {};
    names.forEach((n, i) => {
      if (n === '__proto__' || n === 'constructor' || n === 'prototype') return;
      obj[n] = r[i] ?? '';
    });
    return obj;
  });
}

function cell(v: unknown, delimiter: string, escapeFormulas: boolean): string {
  let s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  // Spreadsheet formula injection guard (=, +, -, @ at the start of a cell).
  if (escapeFormulas && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /["\r\n]/.test(s) || s.includes(delimiter) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function objectsToCsv(rows: Record<string, unknown>[], options: { delimiter?: string; columns?: string[]; escapeFormulas?: boolean } = {}): string {
  const delimiter = options.delimiter ?? ',';
  const columns = options.columns?.length ? options.columns : [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const lines = [columns.map((c) => cell(c, delimiter, false)).join(delimiter)];
  for (const r of rows) lines.push(columns.map((c) => cell(r[c], delimiter, options.escapeFormulas ?? false)).join(delimiter));
  return `${lines.join('\r\n')}\r\n`;
}

/** Flattens nested objects to dotted keys: {a:{b:1}} → {"a.b":1}. Arrays become JSON text. */
export function flatten(obj: Record<string, unknown>, prefix = '', out: Record<string, unknown> = {}): Record<string, unknown> {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v as Record<string, unknown>, key, out);
    else out[key] = Array.isArray(v) ? JSON.stringify(v) : v;
  }
  return out;
}
