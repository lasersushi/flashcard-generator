# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
node generate.js                    # cards.csv -> out/print.html, out/study.html
node generate.js --help             # full flag list
node generate.js --input x.csv --outdir /tmp/x --rows 2 --cols 2 --flip short
open out/print.html                 # then Cmd-P to print/PDF
```

There is no package.json, no dependency install step, no test suite, and no linter. The
only build is running the script. To verify a change, regenerate into a scratch dir and
diff or open the HTML — do not write into `out/` when checking something, it's the user's
print target (and gitignored).

## Architecture

`generate.js` is the whole program: a single zero-dependency Node script, sectioned by
banner comments (CLI → CSV → layout → HTML → main). The pipeline is

```
parseArgs → readCards (parseCSV) → paginate → mirrorSheet → buildPrintHTML / buildStudyHTML → fs.writeFileSync
```

A card is a flat object `{ number, term, definition, page, connection }`; `number` is
assigned at parse time and is what ties a front to its back visually.

### The duplex mirroring invariant

This is the load-bearing part of the program and the thing most likely to be broken by an
innocent-looking edit.

- `paginate()` pads the last sheet with `null` slots up to `rows * cols` **before**
  `mirrorSheet()` runs. Mirroring a short array shifts every card on that sheet's back.
  Never "optimize away" the padding.
- The page is portrait, so its long edge is vertical: `--flip long` mirrors left↔right
  (`(r, cols-1-c)`), `--flip short` mirrors top↔bottom (`(rows-1-r, c)`).
- `buildPrintHTML` emits sheets strictly alternating front, back, front, back… Anything
  that changes that ordering, or emits an odd number of sections, misaligns the print job.
- The small corner numbers are the user's alignment check (hold the sheet to a light).
  They are not decoration — `--no-numbers` exists but the default matters.

### HTML generation

Both outputs are built by string concatenation into template literals; CSS lives inline in
the `PRINT_CSS(rows, cols)` and `STUDY_CSS` constants. Every value that came from the CSV
must pass through `esc()`.

Two coupled details in the print CSS:

- `.sheet` is hardcoded `7.7in × 10.1in` — US Letter minus the `@page` margin of `0.4in` on
  each side. Change one and you must change the other.
- The `AUTOFIT` inline script shrinks any `.fit` block until it stops overflowing. It
  depends on `.card { overflow: hidden }` and `.fit { flex: 1; min-height: 0 }`; loosen
  either and long definitions silently overflow the card instead of shrinking.

### Errors

`die()` writes to stderr and calls `process.exit(1)` — failures are not thrown or caught.
Error messages name the offending CSV row and the expected columns; keep that style.

## CSV input

Columns are positional: `term, definition, page, connection`. A header row is skipped only
if its first line contains one of the words in `HEADER_WORDS`. `term` is required; `page`
and `connection` are optional and their sections are omitted from the card when blank.
`parseCSV` is a hand-rolled RFC-4180 reader (quoted fields, embedded commas/newlines, `""`
escapes) — there is deliberately no CSV dependency.
