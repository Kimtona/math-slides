/**
 * Spreadsheet clipboard text (Excel / Google Sheets / Numbers `text/plain`): tab-separated columns, newline-separated rows.
 * A cell wrapped in double quotes may contain tabs, newlines and doubled quotes (`""`); quotes in the middle of an unquoted cell are literal.
 * The newline that spreadsheets append after the last row is not an extra row.
 */
export function parseTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false, atFieldStart = true, sawAny = false;
  const endField = () => { row.push(field); field = ''; atFieldStart = true; };
  const endRow = () => { endField(); rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    sawAny = true;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { quoted = false; }
      } else field += ch;
      continue;
    }
    if (ch === '"' && atFieldStart) { quoted = true; atFieldStart = false; continue; }
    if (ch === '\t') { endField(); continue; }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      endRow();
      continue;
    }
    field += ch;
    atFieldStart = false;
  }
  // A final row without a trailing newline (or an open quote) still counts; a trailing newline does not add an empty row.
  if (!sawAny) return [['']];
  if (field !== '' || row.length || quoted || !/[\r\n]$/.test(text)) endRow();
  return rows;
}

/** More than one cell (a real grid), as opposed to ordinary text that merely has no tabs or newlines. */
export const isGrid = (rows: string[][]) => rows.length > 1 || rows[0].length > 1;
