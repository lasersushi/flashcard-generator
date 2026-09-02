#!/usr/bin/env node
'use strict';

/**
 * Flashcard editor.
 *
 * A small local web server that puts a form in front of cards.csv, so cards can
 * be written without hand-quoting CSV fields. The CSV stays the source of
 * truth: `node generate.js` still works exactly as it always has.
 *
 * Zero dependencies. Listens on localhost only, because it writes files.
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const { execFile } = require('child_process');

const gen = require('./generate.js');

// ---------------------------------------------------------------- CLI

const DEFAULTS = Object.assign({}, gen.DEFAULTS, {
  port: 5173,
  open: true,
});

const USAGE = `
Usage: node edit.js [options]

  --input <file>    CSV of cards to edit     (default: cards.csv)
  --outdir <dir>    where sheets are written (default: out)
  --rows <n>        card rows per sheet      (default: 3)
  --cols <n>        card columns per sheet   (default: 2)
  --flip <long|short>
                    which edge your printer flips on (default: long)
  --title <text>    heading on the study sheet
  --port <n>        port to listen on        (default: 5173)
  --no-open         don't open a browser
  --help

Opens a card editor at http://localhost:<port>. Saving rewrites the CSV.
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
      case '--port': opts.port = int(next(), arg); break;
      case '--no-open': opts.open = false; break;
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

// ---------------------------------------------------------------- responses

const EDITOR_HTML = path.join(__dirname, 'editor.html');

function send(res, status, type, body) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

function sendJSON(res, status, value) {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(value));
}

/** Collect a request body, with a ceiling so a bad client can't exhaust memory. */
function readBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------- cards

/**
 * Read the CSV, treating "no file yet" and "empty file" as an empty deck rather
 * than an error - starting a new set of cards from nothing is a normal thing to
 * want. Anything else (a malformed row) is still a real error worth showing.
 */
function loadCards(file) {
  if (!fs.existsSync(file)) return [];
  try {
    return gen.readCards(file);
  } catch (err) {
    if (/has no cards|has a header but no cards/.test(err.message)) return [];
    throw err;
  }
}

/**
 * Accept only what the generator can read back: an array whose every card has a
 * term. Checking here means we never write a cards.csv that `node generate.js`
 * would go on to reject - the same rule readCards enforces.
 */
function normalizeCards(payload) {
  if (!Array.isArray(payload)) throw new Error('expected an array of cards');
  return payload.map((card, i) => {
    const field = (name) => {
      const value = card == null ? '' : card[name];
      return value == null ? '' : String(value).trim();
    };
    const term = field('term');
    if (!term) throw new Error(`card ${i + 1} has no term`);
    return {
      term,
      definition: field('definition'),
      page: field('page'),
      connection: field('connection'),
    };
  });
}

// ---------------------------------------------------------------- preview

/** A card's true printed size, derived from the same numbers the sheet uses. */
function cardSize(opts) {
  return {
    width: gen.SHEET.width / opts.cols,
    height: gen.SHEET.height / opts.rows,
  };
}

/**
 * The real print stylesheet plus a short override that stands a single card on
 * its own, at its true printed size. Reusing PRINT_CSS is the point: the
 * preview cannot drift away from what actually comes out of the printer.
 */
function previewCSS(opts) {
  const { width, height } = cardSize(opts);
  return `${gen.PRINT_CSS(opts.rows, opts.cols)}

/* --- preview only: one card, no sheet around it --- */
html, body { background: transparent; }
body { padding: 0; }
.card {
  width: ${width.toFixed(4)}in;
  height: ${height.toFixed(4)}in;
  background: #fff;
  box-shadow: 0 1px 6px rgba(0, 0, 0, 0.13);
}
.stack { display: flex; flex-direction: column; gap: 0.18in; transform-origin: top left; }
.tag {
  font-size: 9px;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  color: #a1a1aa;
  margin-bottom: 0.05in;
}
`;
}

// ---------------------------------------------------------------- routes

async function handle(req, res, opts) {
  const url = new URL(req.url, 'http://localhost');
  const route = `${req.method} ${url.pathname}`;

  switch (route) {
    case 'GET /':
      // Read from disk per request, so editing editor.html just needs a reload.
      return send(res, 200, 'text/html; charset=utf-8', fs.readFileSync(EDITOR_HTML));

    case 'GET /api/cards':
      return sendJSON(res, 200, {
        cards: loadCards(opts.input),
        file: opts.input,
        card: cardSize(opts),
      });

    case 'PUT /api/cards': {
      const cards = normalizeCards(JSON.parse(await readBody(req)));
      fs.writeFileSync(opts.input, gen.cardsToCSV(cards));
      return sendJSON(res, 200, { saved: cards.length, file: opts.input });
    }

    case 'POST /api/generate': {
      // The same work main() does in generate.js, driven from a button.
      const cards = gen.readCards(opts.input);
      fs.mkdirSync(opts.outdir, { recursive: true });
      const printPath = path.join(opts.outdir, 'print.html');
      const studyPath = path.join(opts.outdir, 'study.html');
      fs.writeFileSync(printPath, gen.buildPrintHTML(cards, opts));
      fs.writeFileSync(studyPath, gen.buildStudyHTML(cards, opts));
      const perSheet = opts.rows * opts.cols;
      const sheets = Math.ceil(cards.length / perSheet);
      // sheets = pieces of paper; pages = sides printed, which is twice that.
      return sendJSON(res, 200, { cards: cards.length, sheets, pages: sheets * 2, perSheet });
    }

    // Fixed filenames, so there is nothing here for a path to traverse into.
    case 'GET /out/print.html':
    case 'GET /out/study.html': {
      const name = path.basename(url.pathname);
      const file = path.join(opts.outdir, name);
      if (!fs.existsSync(file)) {
        return sendJSON(res, 404, { error: `${name} has not been generated yet` });
      }
      return send(res, 200, 'text/html; charset=utf-8', fs.readFileSync(file));
    }

    case 'GET /preview.css':
      return send(res, 200, 'text/css; charset=utf-8', previewCSS(opts));

    case 'GET /preview.js':
      // The generator's own shrink-to-fit, so the preview shrinks identically.
      return send(res, 200, 'text/javascript; charset=utf-8', gen.AUTOFIT);

    default:
      return sendJSON(res, 404, { error: `no route for ${route}` });
  }
}

// ---------------------------------------------------------------- main

function openBrowser(url) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : ['xdg-open', [url]];
  execFile(cmd, args, (err) => {
    if (err) process.stdout.write(`  (couldn't open a browser: ${err.message})\n`);
  });
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  const server = http.createServer((req, res) => {
    handle(req, res, opts).catch((err) => sendJSON(res, 400, { error: err.message }));
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      die(`port ${opts.port} is already in use - try --port ${opts.port + 1}`);
    }
    die(err.message);
  });

  // 127.0.0.1 rather than 0.0.0.0: this server writes files, so it has no
  // business being reachable from the rest of the network.
  server.listen(opts.port, '127.0.0.1', () => {
    const url = `http://localhost:${opts.port}`;
    process.stdout.write(`flashcard editor -> ${url}\n  editing ${opts.input}\n  Ctrl-C to stop\n`);
    if (opts.open) openBrowser(url);
  });
}

main();
