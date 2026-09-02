# flashcard-generator

Turns a CSV of vocab into two printable HTML files:

- **`print.html`** — front/back sheets laid out for double-sided printing, with the backs
  pre-mirrored so every definition lands behind its own term.
- **`study.html`** — every card's front and back content side by side in one list, for
  reviewing on screen without cutting anything up.

No dependencies. Print to PDF straight from the browser.

## Card format

Front is the term. Back is your own definition, the textbook page you found it on, and a
real-world connection.

```
┌──────────────────┐   ┌──────────────────┐
│ 1                │   │ 1          p. 112│
│                  │   │                  │
│                  │   │ The organelle    │
│   Mitochondria   │   │ that breaks down │
│                  │   │ glucose to make  │
│                  │   │ ATP.             │
│                  │   │ ──────────────── │
│                  │   │ REAL-WORLD       │
│                  │   │ Why my legs burn │
└──────────────────┘   └──────────────────┘
        front                   back
```

The small number in the corner is the same on both sides — it's there so you can confirm
the alignment worked before you cut, and re-pair anything you drop on the floor.

## Editing cards

```sh
node edit.js
```

Opens an editor at <http://localhost:5173> — a form for the four fields, a live preview of
the card at its real printed size, and a **Generate & print** button that writes the sheets
and opens them. Saving rewrites `cards.csv`, so the quoting is handled for you: commas,
quote marks and line breaks inside a definition all round-trip correctly.

| Key | |
| --- | --- |
| `⌘S` | save to `cards.csv` |
| `⌘↵` | new card |
| `↑` `↓` | move between cards (when you're not typing in a field) |

Use `↑` `↓` in the toolbar to reorder a card, since order sets the card numbers and decides
which cards share a sheet. The server listens on localhost only.

### Options

```
--input <file>          CSV to edit              (default: cards.csv)
--outdir <dir>          where sheets are written (default: out)
--rows/--cols/--flip/--title
                        same meaning as generate.js
--port <n>              port to listen on        (default: 5173)
--no-open               don't open a browser
```

## Usage without the editor

`cards.csv` is still the source of truth, so hand-editing it works exactly as before:

```sh
node generate.js
open out/print.html   # then Cmd-P
```

### Options

```
--input <file>          CSV of cards            (default: cards.csv)
--outdir <dir>          where to write HTML     (default: out)
--rows <n>              card rows per sheet     (default: 3)
--cols <n>              card columns per sheet  (default: 2)
--flip <long|short>     which edge your printer flips on (default: long)
--title <text>          heading on the study sheet
--no-numbers            hide the small card numbers
```

## The CSV

Four columns: `term, definition, page, connection`. A header row is optional — it's
skipped automatically if the first line looks like column names.

```csv
term,definition,page,connection
Osmosis,"Water moving across a semipermeable membrane.",128,"Salting a driveway pulls water out of the ice."
```

Quote any field that contains a comma. Use `""` for a literal quote mark inside a quoted
field. `page` and `connection` can be left blank and their sections just won't render.

## Printing

1. Open `out/print.html` and hit Cmd-P.
2. Set **Two-Sided** on, and turn **Margins** to Default and **Scale** to 100% — scaling
   will throw off the front/back alignment.
3. Print one sheet first and hold it up to a light. The corner numbers should line up. If
   they're mirrored the wrong way, re-run with the other `--flip` value.

### Which flip does my printer use?

The page is portrait, so its long edge is the vertical one:

- **`--flip long`** (default) — the sheet turns like a page in a notebook. Backs get
  mirrored left-to-right.
- **`--flip short`** — the sheet turns like a page on a legal pad. Backs get mirrored
  top-to-bottom.

Most printers default to long-edge. You only have to figure this out once.

## Layout notes

Sheets are US Letter portrait with a 0.4in margin, so a 3×2 grid gives cards about
3.85in × 3.4in — a bit larger than an index card. Long definitions shrink their own font
to fit rather than overflowing.

If the last sheet isn't full, the empty slots are still reserved before mirroring. That's
what keeps the final partial sheet aligned.
