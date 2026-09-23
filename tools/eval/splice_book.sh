#!/bin/sh
# Re-splice tools/eval/book_data.js (regenerate via make_book.js first)
# into src/pkjs/pebble-js-app.js between the <KATAGO_BOOK_DATA> markers.
# Usage: sh tools/eval/splice_book.sh   (run from repo root)
set -e
node -e "
const fs = require('fs');
const eng = 'src/pkjs/pebble-js-app.js';
let s = fs.readFileSync(eng, 'utf8');
const book = fs.readFileSync('tools/eval/book_data.js', 'utf8');
const m = book.match(/var KATAGO_BOOK = (\{.*\});/s);
if (!m) { console.error('BOOK PARSE FAIL'); process.exit(1); }
const marker1 = '// (spliced by tools/eval/splice_book.sh';
const i = s.indexOf(marker1);
if (i < 0) { console.error('MARKER MISSING'); process.exit(1); }
const start = s.indexOf('\n', i) + 1;
const endMarker = '// </KATAGO_BOOK_DATA>';
const j = s.indexOf(endMarker);
if (j < 0) { console.error('END MARKER MISSING'); process.exit(1); }
s = s.slice(0, start) + 'var KATAGO_BOOK = ' + m[1] + ';\n' + s.slice(j);
fs.writeFileSync(eng, s);
console.log('spliced ' + m[1].length + ' chars');
"
node --check src/pkjs/pebble-js-app.js && echo SYNTAX-OK
