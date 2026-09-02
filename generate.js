#!/usr/bin/env node
'use strict';

/**
 * Flashcard sheet generator.
 *
 * Reads a CSV of cards and writes two printable HTML files:
 *   print.html  - alternating front/back sheets, backs mirrored for duplex printing
 *   study.html  - every card's front and back content side by side, one page flow
 *
 * Zero dependencies. Print to PDF from the browser (Cmd-P).
 */

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------- CLI

const DEFAULTS = {
  input: 'cards.csv',
  outdir: 'out',
  rows: 3,
  cols: 2,
  flip: 'long',
  title: 'Flashcards',
  numbers: true,
};

const USAGE = `
Usage: node generate.js [options]

  --input <file>    CSV of cards            (default: cards.csv)
  --outdir <dir>    where to write HTML     (default: out)
  --rows <n>        card rows per sheet     (default: 3)
  --cols <n>        card columns per sheet  (default: 2)
  --flip <long|short>
                    which edge your printer flips on (default: long)
  --title <text>    heading on the study sheet
  --no-numbers      hide the small card numbers
  --help

CSV columns: term, definition, page, connection
`;

function parseArgs(argv) {
  const opts = Object.assign({}, DEFAULTS);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) die(`Missing value after ${arg}`);
      return v;
    };
    switch (arg) {
      case '--input': opts.input = next(); break;
      case '--outdir': opts.outdir = next(); break;
      case '--rows': opts.rows = int(next(), arg); break;
      case '--cols': opts.cols = int(next(), arg); break;
      case '--flip': opts.flip = next(); break;
      case '--title': opts.title = next(); break;
      case '--no-numbers': opts.numbers = false; break;
      case '--help': case '-h': process.stdout.write(USAGE); process.exit(0); break;
      default: die(`Unknown option: ${arg}\n${USAGE}`);
    }
  }
  if (opts.flip !== 'long' && opts.flip !== 'short') {
    die(`--flip must be "long" or "short", got "${opts.flip}"`);
  }
  if (opts.rows < 1 || opts.cols < 1) die('--rows and --cols must be at least 1');
  return opts;
}

function int(value, flag) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) die(`${flag} expects a number, got "${value}"`);
  return n;
}

function die(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------- CSV

/**
 * Minimal RFC-4180 CSV reader: handles quoted fields, embedded commas and
 * newlines, and "" as an escaped quote. Returns an array of string arrays.
 */
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += ch;
      continue;
    }

    if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch !== '\r') field += ch;
  }
  row.push(field);
  rows.push(row);

  // Drop blank lines so a trailing newline doesn't become an empty card.
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

const HEADER_WORDS = ['term', 'definition', 'page', 'connection'];

function readCards(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`could not read ${file}: ${err.message}`);
  }

  const rows = parseCSV(text);
  if (rows.length === 0) throw new Error(`${file} has no cards in it`);

  // Skip a header row if the first line looks like column names.
  const first = rows[0].map((c) => c.trim().toLowerCase());
  if (first.some((c) => HEADER_WORDS.includes(c))) rows.shift();
  if (rows.length === 0) throw new Error(`${file} has a header but no cards`);

  return rows.map((cells, i) => {
    const card = {
      number: i + 1,
      term: (cells[0] || '').trim(),
      definition: (cells[1] || '').trim(),
      page: (cells[2] || '').trim(),
      connection: (cells[3] || '').trim(),
    };
    if (!card.term) {
      throw new Error(`row ${i + 1} of ${file} has no term (columns: term, definition, page, connection)`);
    }
    return card;
  });
}

/**
 * Quote a field only when it needs it: a comma, a quote mark or a newline
 * inside the text would otherwise break the column structure. A literal quote
 * is escaped by doubling it, which is what parseCSV reads back.
 */
function csvField(value) {
  const s = value == null ? '' : String(value);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** Serialize cards back to CSV text, header row included. */
function cardsToCSV(cards) {
  const lines = [HEADER_WORDS.join(',')];
  for (const card of cards) {
    lines.push([card.term, card.definition, card.page, card.connection].map(csvField).join(','));
  }
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------- layout

/** Split cards into full sheets, padding the last one with nulls. */
function paginate(cards, perSheet) {
  const sheets = [];
  for (let i = 0; i < cards.length; i += perSheet) {
    const sheet = cards.slice(i, i + perSheet);
    while (sheet.length < perSheet) sheet.push(null);
    sheets.push(sheet);
  }
  return sheets;
}

/**
 * Reorder a sheet so each back lands behind its own front after the printer
 * flips the paper.
 *
 * The page is portrait, so the long edge is vertical and the short edge is
 * horizontal. Flipping on the long edge mirrors left-to-right, which means
 * back position (r, c) has to hold the card that is at front position
 * (r, cols-1-c). Flipping on the short edge mirrors top-to-bottom instead.
 *
 * Padding the sheet to full size first is what keeps the final partial sheet
 * aligned - mirroring a short array would shift every card on the back.
 */
function mirrorSheet(sheet, rows, cols, flip) {
  const out = new Array(rows * cols);
  for (let i = 0; i < rows * cols; i++) {
    const r = Math.floor(i / cols);
    const c = i % cols;
    const source = flip === 'short'
      ? (rows - 1 - r) * cols + c
      : r * cols + (cols - 1 - c);
    out[i] = sheet[source];
  }
  return out;
}

// ---------------------------------------------------------------- HTML

function esc(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Shrinks any .fit block until it stops overflowing its card. Runs once on
// load; the layout is in inches so it does not need to re-run on resize.
const AUTOFIT = `
document.querySelectorAll('.fit').forEach(function (el) {
  var size = parseFloat(getComputedStyle(el).fontSize);
  for (var i = 0; i < 80 && el.scrollHeight > el.clientHeight && size > 7; i++) {
    size -= 0.5;
    el.style.fontSize = size + 'px';
  }
});
`.trim();

// Printable area of a US Letter portrait page inside the @page margins.
const SHEET = { width: 7.7, height: 10.1 };

const PRINT_CSS = (rows, cols) => `
@page { size: letter portrait; margin: 0.4in; }

:root {
  --ink: #111;
  --muted: #8a8a8a;
  --rule: #c9c9c9;
  --accent: #b45309;
}

* { box-sizing: border-box; }

html { background: #f4f4f5; }

body {
  margin: 0;
  padding: 0.4in 0;
  color: var(--ink);
  font-family: ui-sans-serif, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}

.sheet {
  width: ${SHEET.width}in;
  height: ${SHEET.height}in;
  margin: 0 auto 0.4in;
  display: grid;
  grid-template-columns: repeat(${cols}, 1fr);
  grid-template-rows: repeat(${rows}, 1fr);
  background: #fff;
  box-shadow: 0 1px 8px rgba(0, 0, 0, 0.12);
  break-after: page;
}

.sheet:last-child { break-after: auto; }

.card {
  border: 1px dashed var(--rule);
  padding: 0.22in;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.card.blank { border-style: dashed; }

/* Top strip: card number on the left, textbook page on the right. */
.meta {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  font-size: 9px;
  letter-spacing: 0.04em;
  color: var(--muted);
  margin-bottom: 0.08in;
  min-height: 12px;
}

.meta .page { font-weight: 600; color: var(--accent); }

.fit {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

/* --- front --- */

.front .fit {
  align-items: center;
  justify-content: center;
  text-align: center;
}

.term {
  font-size: 26px;
  font-weight: 650;
  line-height: 1.2;
  letter-spacing: -0.01em;
  text-wrap: balance;
}

/* --- back --- */

.definition {
  font-size: 13px;
  line-height: 1.45;
  flex: 1;
  min-height: 0;
}

.connection {
  margin-top: 0.1in;
  padding-top: 0.09in;
  border-top: 1px solid var(--rule);
  font-size: 11.5px;
  line-height: 1.4;
}

.connection .label {
  display: block;
  font-size: 8px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--accent);
  margin-bottom: 0.03in;
}

.side-tag {
  position: fixed;
  top: 8px;
  left: 8px;
  font-size: 10px;
  color: var(--muted);
}

@media print {
  html { background: #fff; }
  body { padding: 0; }
  .sheet { margin: 0; box-shadow: none; }
  .side-tag { display: none; }
}
`.trim();

function renderCardFront(card, showNumbers) {
  if (!card) return '<div class="card blank"></div>';
  const number = showNumbers ? `<span>${card.number}</span>` : '<span></span>';
  return `      <div class="card front">
        <div class="meta">${number}<span></span></div>
        <div class="fit"><div class="term">${esc(card.term)}</div></div>
      </div>`;
}

function renderCardBack(card, showNumbers) {
  if (!card) return '<div class="card blank"></div>';
  const number = showNumbers ? `<span>${card.number}</span>` : '<span></span>';
  const page = card.page ? `<span class="page">p. ${esc(card.page)}</span>` : '<span></span>';
  const definition = card.definition
    ? `<div class="definition">${esc(card.definition)}</div>`
    : '<div class="definition"></div>';
  const connection = card.connection
    ? `<div class="connection"><span class="label">Real-world connection</span>${esc(card.connection)}</div>`
    : '';
  return `      <div class="card back">
        <div class="meta">${number}${page}</div>
        <div class="fit">${definition}${connection}</div>
      </div>`;
}

function buildPrintHTML(cards, opts) {
  const perSheet = opts.rows * opts.cols;
  const sheets = paginate(cards, perSheet);

  const html = [];
  for (const sheet of sheets) {
    const backs = mirrorSheet(sheet, opts.rows, opts.cols, opts.flip);
    html.push(`    <section class="sheet">\n${sheet.map((c) => renderCardFront(c, opts.numbers)).join('\n')}\n    </section>`);
    html.push(`    <section class="sheet">\n${backs.map((c) => renderCardBack(c, opts.numbers)).join('\n')}\n    </section>`);
  }

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(opts.title)} - print</title>
<style>
${PRINT_CSS(opts.rows, opts.cols)}
</style>
</head>
<body>
<div class="side-tag">${cards.length} cards &middot; ${sheets.length} sheet(s) &middot; ${opts.flip}-edge flip &middot; print double-sided</div>
${html.join('\n')}
<script>
${AUTOFIT}
</script>
</body>
</html>
`;
}

const STUDY_CSS = `
@page { size: letter portrait; margin: 0.6in; }

:root {
  --ink: #111;
  --muted: #6b7280;
  --rule: #e5e7eb;
  --accent: #b45309;
}

* { box-sizing: border-box; }

body {
  max-width: 7.3in;
  margin: 0 auto;
  padding: 0.6in 0.4in;
  color: var(--ink);
  font-family: ui-sans-serif, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
  font-size: 12px;
  line-height: 1.5;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}

h1 {
  font-size: 20px;
  font-weight: 650;
  letter-spacing: -0.01em;
  margin: 0 0 0.04in;
}

.count { color: var(--muted); font-size: 11px; margin: 0 0 0.3in; }

.row {
  display: grid;
  grid-template-columns: 1.7in 1fr;
  gap: 0.28in;
  padding: 0.16in 0;
  border-top: 1px solid var(--rule);
  break-inside: avoid;
}

.row:last-child { border-bottom: 1px solid var(--rule); }

.side-a { display: flex; flex-direction: column; gap: 0.04in; }

.num { font-size: 9px; color: var(--muted); letter-spacing: 0.06em; }

.term { font-size: 14px; font-weight: 650; line-height: 1.25; }

.page { font-size: 10px; font-weight: 600; color: var(--accent); }

.definition { margin: 0; }

.connection {
  margin-top: 0.09in;
  padding-left: 0.11in;
  border-left: 2px solid var(--accent);
  color: #3f3f46;
}

.connection .label {
  display: block;
  font-size: 8px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--accent);
  margin-bottom: 0.02in;
}

@media print { body { padding: 0; } }
`.trim();

function buildStudyHTML(cards, opts) {
  const rows = cards.map((card) => {
    const number = opts.numbers ? `<div class="num">${card.number}</div>` : '';
    const page = card.page ? `<div class="page">p. ${esc(card.page)}</div>` : '';
    const connection = card.connection
      ? `<div class="connection"><span class="label">Real-world connection</span>${esc(card.connection)}</div>`
      : '';
    return `  <div class="row">
    <div class="side-a">${number}<div class="term">${esc(card.term)}</div>${page}</div>
    <div class="side-b">
      <p class="definition">${esc(card.definition)}</p>${connection}
    </div>
  </div>`;
  });

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(opts.title)} - study sheet</title>
<style>
${STUDY_CSS}
</style>
</head>
<body>
<h1>${esc(opts.title)}</h1>
<p class="count">${cards.length} cards &middot; both sides on one page</p>
${rows.join('\n')}
</body>
</html>
`;
}

// ---------------------------------------------------------------- main

function main() {
  const opts = parseArgs(process.argv.slice(2));

  let cards;
  try {
    cards = readCards(opts.input);
  } catch (err) {
    die(err.message);
  }

  fs.mkdirSync(opts.outdir, { recursive: true });

  const printPath = path.join(opts.outdir, 'print.html');
  const studyPath = path.join(opts.outdir, 'study.html');

  fs.writeFileSync(printPath, buildPrintHTML(cards, opts));
  fs.writeFileSync(studyPath, buildStudyHTML(cards, opts));

  const perSheet = opts.rows * opts.cols;
  const sheets = Math.ceil(cards.length / perSheet);
  process.stdout.write(
    `${cards.length} cards -> ${sheets} sheet(s) of ${perSheet} (${opts.rows}x${opts.cols}), ${opts.flip}-edge flip\n` +
    `  ${printPath}\n  ${studyPath}\n`
  );
}

if (require.main === module) main();

module.exports = {
  parseCSV,
  readCards,
  cardsToCSV,
  buildPrintHTML,
  buildStudyHTML,
  renderCardFront,
  renderCardBack,
  PRINT_CSS,
  AUTOFIT,
  SHEET,
  DEFAULTS,
};
