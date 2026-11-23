// makefun-site 1.0.0 drop-in, written from the vendor README's prose spec.
// Single-pass build: front matter, Markdown, templates compiled once per case,
// links resolved against the built tree, report sorted code-unit order.
// v2: templates are compiled to JS functions (codegen) instead of interpreted
// per page; inline Markdown jumps between special characters; slug/date
// results are cached; front matter is found by string search, not split/join.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
// Escape & < > " ' for HTML. One manual pass: the regex version paid the
// RegExp engine's setup on every call, and most values hold no special
// character at all, so the scan returns the input untouched.
function esc(s) {
  let out = null;
  let start = 0;
  for (let k = 0; k < s.length; k++) {
    const c = s.charCodeAt(k);
    let ent;
    if (c === 38) ent = '&amp;';
    else if (c === 60) ent = '&lt;';
    else if (c === 62) ent = '&gt;';
    else if (c === 34) ent = '&quot;';
    else if (c === 39) ent = '&#39;';
    else continue;
    if (out === null) out = s.slice(0, k);
    else out += s.slice(start, k);
    out += ent;
    start = k + 1;
  }
  if (out === null) return s;
  if (start < s.length) out += s.slice(start);
  return out;
}
const MARK_RE = /\p{M}/gu;
const KNOWN_KEYS = { title: 1, summary: 1, date: 1, tags: 1, draft: 1, layout: 1, slug: 1 };
// Characters a backslash can escape in inline text.
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const NUM_SEG_RE = /^(0|[1-9][0-9]*)$/;
// Special characters the inline renderer reacts to; plain text between them
// is skipped in one step by the regex engine.
const INLINE_RE = /[\\`*\[&<>"']/g;

// A slug: NFKD, combining marks dropped, A-Z lowered, each run of other
// characters one '-', none at either end, cut to 64, '-' at the cut dropped.
function slugify(text) {
  const s = text.normalize('NFKD').replace(MARK_RE, '').toLowerCase();
  let out = '';
  let lastDash = true; // suppress a leading '-'
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const ok = (c >= 97 && c <= 122) || (c >= 48 && c <= 57);
    if (ok) { out += s[i]; lastDash = false; }
    else if (!lastDash) { out += '-'; lastDash = true; }
  }
  if (lastDash && out.length > 0) out = out.slice(0, -1);
  if (out.length > 64) {
    out = out.slice(0, 64);
    if (out.charCodeAt(63) === 45) out = out.slice(0, 63);
  }
  return out === '' ? 'untitled' : out;
}

// Pure-function caches, cleared at the start of each run(): tag names and
// dates repeat across pages, NFKD normalisation does not need redoing.
const SLUG_CACHE = new Map();
const DATE_CACHE = new Map();
function cachedSlugify(text) {
  let r = SLUG_CACHE.get(text);
  if (r === undefined) { r = slugify(text); SLUG_CACHE.set(text, r); }
  return r;
}
function cachedDateLong(ds) {
  let r = DATE_CACHE.get(ds);
  if (r === undefined) { r = dateLong(ds); DATE_CACHE.set(ds, r); }
  return r;
}

function dateLong(ds) {
  // ds is a validated YYYY-MM-DD string.
  const y = ds.slice(0, 4);
  const m = (ds.charCodeAt(5) - 48) * 10 + (ds.charCodeAt(6) - 48);
  const d = (ds.charCodeAt(8) - 48) * 10 + (ds.charCodeAt(9) - 48);
  return d + ' ' + MONTHS[m - 1] + ' ' + y;
}

function isRealDate(v) {
  if (v.length !== 10 || v.charCodeAt(4) !== 45 || v.charCodeAt(7) !== 45) return false;
  for (let i = 0; i < 10; i++) {
    if (i === 4 || i === 7) continue;
    const c = v.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  const y = (v.charCodeAt(0) - 48) * 1000 + (v.charCodeAt(1) - 48) * 100 + (v.charCodeAt(2) - 48) * 10 + (v.charCodeAt(3) - 48);
  const m = (v.charCodeAt(5) - 48) * 10 + (v.charCodeAt(6) - 48);
  const d = (v.charCodeAt(8) - 48) * 10 + (v.charCodeAt(9) - 48);
  if (y < 1970 || y > 2099 || m < 1 || m > 12 || d < 1) return false;
  const dim = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  return d <= dim + (m === 2 && leap ? 1 : 0);
}

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function trimST(s) {
  let a = 0, b = s.length;
  while (a < b && (s.charCodeAt(a) === 32 || s.charCodeAt(a) === 9)) a++;
  while (b > a && (s.charCodeAt(b - 1) === 32 || s.charCodeAt(b - 1) === 9)) b--;
  return s.slice(a, b);
}

// Parse a quoted or bare string value for title/summary.
// Returns the string, or null with reason set in err.reason.
function parseStringValue(v, err) {
  if (v.charCodeAt(0) === 34) { // '"'
    let i = 1;
    let out = '';
    let start = 1;
    while (i < v.length) {
      const c = v[i];
      if (c === '\\') {
        const n = v[i + 1];
        if (n !== '"' && n !== '\\') { err.reason = 'a quoted string is not closed'; return null; }
        out += v.slice(start, i) + n;
        i += 2;
        start = i;
      } else if (c === '"') {
        if (i !== v.length - 1) { err.reason = 'a quoted string is not closed'; return null; }
        out += v.slice(start, i);
        return out;
      } else i++;
    }
    err.reason = 'a quoted string is not closed';
    return null;
  }
  const c0 = v.charCodeAt(0);
  if (c0 === 34 || c0 === 91) { // '"' or '['
    err.reason = 'a bare string opens on ' + v[0];
    return null;
  }
  return v;
}

// Parse front matter. Returns {fm, body} or {refusal} (reason string).
// content is already \r-normalised. The closing '---' line is found by
// string search, so the body is one slice instead of a split/join round-trip.
function parseFrontMatter(content) {
  if (content.length < 3 || content.charCodeAt(0) !== 45 || content.charCodeAt(1) !== 45 || content.charCodeAt(2) !== 45) return { refusal: 'no front matter' };
  if (content.length === 3) return { refusal: 'the front matter is not closed' };
  if (content.charCodeAt(3) !== 10) return { refusal: 'no front matter' };
  let idx = content.indexOf('\n---', 3);
  let closeEnd = -1; // offset just past the closing line: start of the body
  let fmEnd = -1; // index of the '\n' before the closing '---'
  while (idx !== -1) {
    const after = idx + 4;
    if (after === content.length) { closeEnd = after; fmEnd = idx; break; }
    if (content.charCodeAt(after) === 10) { closeEnd = after + 1; fmEnd = idx; break; }
    idx = content.indexOf('\n---', idx + 1);
  }
  if (closeEnd === -1) return { refusal: 'the front matter is not closed' };
  const fmText = content.slice(4, fmEnd);
  const fmLines = fmText === '' ? [] : fmText.split('\n');
  const fm = {};
  const seen = new Set();
  const err = { reason: '' };
  for (let k = 0; k < fmLines.length; k++) {
    const line = fmLines[k];
    const lineNo = k + 2; // original line number (line 0 is '---')
    if (isBlankLine(line)) continue;
    if (line.charCodeAt(0) === 35) continue; // '#' comment
    const ci = line.indexOf(':');
    if (ci === -1) return { refusal: 'line ' + lineNo + ' is not "key: value"' };
    const key = line.slice(0, ci);
    if (!/^[a-z_]+$/.test(key)) return { refusal: 'line ' + lineNo + ' is not "key: value"' };
    let v = line.slice(ci + 1);
    if (v.charCodeAt(0) === 32) v = v.slice(1);
    v = trimST(v);
    if (!KNOWN_KEYS[key]) return { refusal: 'unknown key "' + key + '"' };
    if (seen.has(key)) return { refusal: 'key "' + key + '" is given twice' };
    seen.add(key);
    if (v === '') return { refusal: 'key "' + key + '" has no value' };
    if (key === 'title' || key === 'summary') {
      const s = parseStringValue(v, err);
      if (s === null) return { refusal: 'key "' + key + '": ' + err.reason };
      fm[key] = s;
    } else if (key === 'date') {
      if (!isRealDate(v)) return { refusal: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      fm.date = v;
    } else if (key === 'tags') {
      if (v.length < 2 || v.charCodeAt(0) !== 91 || v.charCodeAt(v.length - 1) !== 93) {
        return { refusal: 'key "tags": not a list [a, b]' };
      }
      const inner = v.slice(1, -1);
      const tags = [];
      if (inner !== '') {
        const parts = inner.split(',');
        for (let p = 0; p < parts.length; p++) {
          const t = trimST(parts[p]);
          if (t === '' || t.indexOf('"') !== -1 || t.indexOf('[') !== -1 || t.indexOf(']') !== -1) {
            return { refusal: 'key "tags": an empty tag, or one holding " [ or ]' };
          }
          tags.push(t);
        }
      }
      fm.tags = tags;
    } else if (key === 'draft') {
      if (v !== 'true' && v !== 'false') return { refusal: 'key "draft": true or false' };
      fm.draft = v === 'true';
    } else if (key === 'layout') {
      if (!/^[a-z0-9-]+$/.test(v)) return { refusal: 'key "layout": not a template name' };
      fm.layout = v;
    } else if (key === 'slug') {
      if (v.length > 64 || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(v)) return { refusal: 'key "slug": not a slug' };
      fm.slug = v;
    }
  }
  if (fm.title === undefined) return { refusal: 'no title' };
  return { fm, body: content.slice(closeEnd) };
}

// ---------------------------------------------------------------- links

function hasScheme(target) {
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < target.length; i++) {
    const c = target.charCodeAt(i);
    if (c === 58) return true; // ':'
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46) continue;
    return false;
  }
  return false;
}

function hasWhitespace(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11) return true;
  }
  return false;
}

// Resolve a link target. Returns the href, or null when broken.
function resolveLink(target, srcDir, pageBySource, staticSet, base) {
  if (hasScheme(target)) return target;
  const c0 = target.charCodeAt(0);
  if (c0 === 47 || c0 === 35) return target; // '/' or '#'
  let frag = '';
  let path = target;
  const hi = target.indexOf('#');
  if (hi !== -1) { path = target.slice(0, hi); frag = target.slice(hi); }
  const parts = (srcDir === '' ? path : srcDir + '/' + path).split('/');
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (out.length > 0) out.pop(); continue; }
    out.push(seg);
  }
  const resolved = out.join('/');
  const url = pageBySource.get(resolved);
  if (url !== undefined) return url + frag;
  if (staticSet.has(resolved)) return base + '/' + resolved + frag;
  return null;
}

// ---------------------------------------------------------------- inline

// Is the character at j consumed by a backslash escape? The renderer eats
// `\X` pairs (X escapable) left to right, so a '*' or ']' is escaped exactly
// when the run of backslashes right before it has odd length.
function isEscaped(s, j) {
  let k = 0;
  let p = j - 1;
  while (p >= 0 && s.charCodeAt(p) === 92) { k++; p--; }
  return (k & 1) === 1;
}

// Find a '**' closer for strong, from `from`, within [from, end).
// Returns the index of the first '*' of the closer, or -1.
function findStrongClose(s, from, end) {
  let j = s.indexOf('**', from);
  while (j !== -1 && j + 1 < end) {
    if (!isEscaped(s, j)) return j;
    j = s.indexOf('**', j + 1);
  }
  return -1;
}

// Find a single-'*' closer for emphasis, from `from`, opener at `open`.
// A closer is the next unescaped '*' that stands alone: a '**' pair is
// skipped as a unit, and an escaped '*' is skipped too. Returns the index, or -1.
function findEmClose(s, from, end, open) {
  let j = s.indexOf('*', from);
  while (j !== -1 && j < end) {
    if (isEscaped(s, j)) { j = s.indexOf('*', j + 1); continue; }
    if (j + 1 < end && s.charCodeAt(j + 1) === 42) { j = s.indexOf('*', j + 2); continue; } // a '**' pair: not a closer
    if (j - open < 2) { j = s.indexOf('*', j + 1); continue; } // at least one character between
    return j;
  }
  return -1;
}

// Find the first unescaped ']' from `from`, within [from, end). Returns index or -1.
function findTextClose(s, from, end) {
  let j = s.indexOf(']', from);
  while (j !== -1 && j < end) {
    if (!isEscaped(s, j)) return j;
    j = s.indexOf(']', j + 1);
  }
  return -1;
}

// Render inline markup of s[start..end) into out (array of strings).
// ctx: {srcDir, pageBySource, staticSet, base, srcPath, broken:Set}
// Plain text is skipped by the regex engine; only special characters are
// visited one by one. INLINE_RE's lastIndex is reset on entry and after
// every construct, so nested calls cannot disturb the outer scan.
function renderInline(s, ctx, out, start, end) {
  let run = start;
  INLINE_RE.lastIndex = start;
  let m;
  while ((m = INLINE_RE.exec(s)) !== null && m.index < end) {
    const i = m.index;
    const c = s.charCodeAt(i);
    if (c === 92) { // backslash
      const n = i + 1 < end ? s[i + 1] : '';
      if (n !== '' && ESCAPABLE.has(n)) {
        if (i > run) out.push(s.slice(run, i));
        out.push(n);
        run = i + 2;
        INLINE_RE.lastIndex = i + 2;
        continue;
      }
      INLINE_RE.lastIndex = i + 1;
      continue;
    }
    if (c === 96) { // backtick: code span
      const j = s.indexOf('`', i + 1);
      if (j !== -1 && j < end && j > i + 1) {
        if (i > run) out.push(s.slice(run, i));
        out.push('<code>', esc(s.slice(i + 1, j)), '</code>');
        run = j + 1;
        INLINE_RE.lastIndex = j + 1;
        continue;
      }
      INLINE_RE.lastIndex = i + 1;
      continue;
    }
    if (c === 42) { // '*'
      if (i + 1 < end && s.charCodeAt(i + 1) === 42) {
        const j = findStrongClose(s, i + 2, end);
        if (j !== -1 && j > i + 2) {
          if (i > run) out.push(s.slice(run, i));
          out.push('<strong>');
          renderInline(s, ctx, out, i + 2, j);
          out.push('</strong>');
          run = j + 2;
          INLINE_RE.lastIndex = j + 2;
          continue;
        }
        INLINE_RE.lastIndex = i + 2;
        continue;
      }
      const j = findEmClose(s, i + 1, end, i);
      if (j !== -1) {
        if (i > run) out.push(s.slice(run, i));
        out.push('<em>');
        renderInline(s, ctx, out, i + 1, j);
        out.push('</em>');
        run = j + 1;
        INLINE_RE.lastIndex = j + 1;
        continue;
      }
      INLINE_RE.lastIndex = i + 1;
      continue;
    }
    if (c === 91) { // '[': link
      const j = findTextClose(s, i + 1, end);
      if (j !== -1 && j + 1 < end && s.charCodeAt(j + 1) === 40) { // '('
        const k = s.indexOf(')', j + 2);
        if (k !== -1 && k < end) {
          const target = s.slice(j + 2, k);
          if (target !== '' && !hasWhitespace(target)) {
            const href = resolveLink(target, ctx.srcDir, ctx.pageBySource, ctx.staticSet, ctx.base);
            if (i > run) out.push(s.slice(run, i));
            if (href === null) {
              ctx.broken.add('broken-link ' + ctx.srcPath + ' -> ' + target);
              out.push('<a href="', esc(target), '">');
            } else {
              out.push('<a href="', esc(href), '">');
            }
            renderInline(s, ctx, out, i + 1, j);
            out.push('</a>');
            run = k + 1;
            INLINE_RE.lastIndex = k + 1;
            continue;
          }
        }
      }
      INLINE_RE.lastIndex = i + 1;
      continue;
    }
    if (c === 38) { if (i > run) out.push(s.slice(run, i)); out.push('&amp;'); run = i + 1; INLINE_RE.lastIndex = i + 1; continue; }
    if (c === 60) { if (i > run) out.push(s.slice(run, i)); out.push('&lt;'); run = i + 1; INLINE_RE.lastIndex = i + 1; continue; }
    if (c === 62) { if (i > run) out.push(s.slice(run, i)); out.push('&gt;'); run = i + 1; INLINE_RE.lastIndex = i + 1; continue; }
    if (c === 34) { if (i > run) out.push(s.slice(run, i)); out.push('&quot;'); run = i + 1; INLINE_RE.lastIndex = i + 1; continue; }
    if (c === 39) { if (i > run) out.push(s.slice(run, i)); out.push('&#39;'); run = i + 1; INLINE_RE.lastIndex = i + 1; continue; }
    INLINE_RE.lastIndex = i + 1;
  }
  if (end > run) out.push(s.slice(run, end));
}

// One scratch array for inline rendering: inlineToString is never
// re-entered (its recursion goes through renderInline on the same array),
// so a shared array avoids one allocation per paragraph/heading/item.
const INLINE_OUT = [];
function inlineToString(s, ctx) {
  INLINE_OUT.length = 0;
  renderInline(s, ctx, INLINE_OUT, 0, s.length);
  return INLINE_OUT.join('');
}

// ---------------------------------------------------------------- markdown

function isFenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    const ok = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45;
    if (!ok) {
      // Only spaces/tabs may follow the language.
      for (let k = i; k < line.length; k++) {
        const d = line.charCodeAt(k);
        if (d !== 32 && d !== 9) return null;
      }
      return line.slice(3, i);
    }
  }
  return line.slice(3);
}

function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function headingInfo(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 35) n++;
  if (n === 0 || n > 6) return null;
  if (n >= line.length) return null;
  const c = line.charCodeAt(n);
  if (c !== 32 && c !== 9) return null;
  let a = n;
  while (a < line.length && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  let b = line.length;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  if (b <= a) return null;
  return { level: n, text: line.slice(a, b) };
}

function isBreak(line) {
  let b = line.length;
  while (b > 0 && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  const t = line.slice(0, b);
  return t === '---' || t === '***';
}

function listMarker(line) {
  const c0 = line.charCodeAt(0);
  if (c0 === 45 || c0 === 42) { // '-' or '*'
    if (line.charCodeAt(1) === 32) return { kind: 0, len: 2, num: 0 };
    return null;
  }
  if (c0 >= 48 && c0 <= 57) {
    let i = 0;
    while (i < line.length && line.charCodeAt(i) >= 48 && line.charCodeAt(i) <= 57) i++;
    if (i < line.length && line.charCodeAt(i) === 46 && line.charCodeAt(i + 1) === 32) {
      return { kind: 1, len: i + 2, num: parseInt(line.slice(0, i), 10) };
    }
  }
  return null;
}

// Does this line end a paragraph (blank, fence, heading or break)?
// Dispatches on the first character, so a plain text line answers at once.
function paraBreak(line) {
  const c0 = line.length === 0 ? -1 : line.charCodeAt(0);
  if (c0 === -1 || c0 === 32 || c0 === 9) return isBlankLine(line);
  if (c0 === 96) return isFenceOpen(line) !== null;
  if (c0 === 35) return headingInfo(line) !== null;
  if (c0 === 45 || c0 === 42) return isBreak(line);
  return false;
}

// Render a Markdown body to HTML. Returns {html, toc, excerpt, words}.
// ctx carries link context (srcDir, pageBySource, staticSet, base, srcPath, broken).
function renderBody(body, ctx) {
  const lines = body.split('\n');
  const out = [];
  const toc = [];
  const headingIds = new Set();
  let excerpt = '';
  let words = 0;
  // Word count: runs of non-whitespace in the raw body.
  {
    let inWord = false;
    for (let i = 0; i < body.length; i++) {
      const c = body.charCodeAt(i);
      const ws = c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11;
      if (ws) inWord = false;
      else if (!inWord) { inWord = true; words++; }
    }
  }
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    const c0 = line.length === 0 ? -1 : line.charCodeAt(0);
    // Blank (empty or spaces/tabs only).
    if (c0 === -1 || ((c0 === 32 || c0 === 9) && isBlankLine(line))) { i++; continue; }
    // Fence: a line starting with '`' can only be a fence or a paragraph.
    if (c0 === 96) {
      const lang = isFenceOpen(line);
      if (lang !== null) {
        const parts = ['<pre><code'];
        if (lang !== '') parts.push(' class="language-', esc(lang), '"');
        parts.push('>');
        i++;
        while (i < n && !isFenceClose(lines[i])) {
          parts.push(esc(lines[i]), '\n');
          i++;
        }
        if (i < n) i++; // closing fence
        parts.push('</code></pre>');
        out.push(parts.join(''), '\n');
        continue;
      }
    } else if (c0 === 35) { // '#': heading or paragraph
      const h = headingInfo(line);
      if (h !== null) {
        let id = cachedSlugify(h.text);
        let cand = id;
        let k = 2;
        while (headingIds.has(cand)) { cand = id + '-' + k; k++; }
        headingIds.add(cand);
        id = cand;
        const inner = inlineToString(h.text, ctx);
        if (h.level === 2 || h.level === 3) toc.push({ level: h.level, id, html: inner });
        out.push('<h', String(h.level), ' id="', id, '">', inner, '</h', String(h.level), '>', '\n');
        i++;
        continue;
      }
    } else if (c0 === 62) { // '>': blockquote
      const q = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        let t = lines[i].slice(1);
        if (t.charCodeAt(0) === 32) t = t.slice(1);
        t = trimST(t);
        if (t !== '') q.push(t);
        i++;
      }
      if (q.length === 0) out.push('<blockquote>\n</blockquote>', '\n');
      else out.push('<blockquote>\n<p>', inlineToString(q.join('\n'), ctx), '</p>\n</blockquote>', '\n');
      continue;
    } else if (c0 === 45 || c0 === 42 || (c0 >= 48 && c0 <= 57)) { // list or break
      if ((c0 === 45 || c0 === 42) && isBreak(line)) {
        out.push('<hr>', '\n');
        i++;
        continue;
      }
      const m = listMarker(line);
      if (m !== null) {
        const items = [];
        let firstNum = 0;
        let kind = m.kind;
        while (i < n) {
          const l2 = lines[i];
          const mm = listMarker(l2);
          if (mm !== null && mm.kind === kind) {
            if (items.length === 0 && kind === 1) firstNum = mm.num;
            items.push(l2.slice(mm.len));
            i++;
            continue;
          }
          // Continuation: two or more spaces then a non-space.
          if (l2.length >= 2 && l2.charCodeAt(0) === 32 && l2.charCodeAt(1) === 32) {
            const t = trimST(l2);
            if (t !== '') {
              items[items.length - 1] += '\n' + t;
              i++;
              continue;
            }
          }
          break;
        }
        out.push(kind === 0 ? '<ul>\n' : (firstNum === 1 ? '<ol>\n' : '<ol start="' + firstNum + '">\n'));
        for (let k = 0; k < items.length; k++) {
          out.push('<li>', inlineToString(items[k], ctx), '</li>\n');
        }
        out.push(kind === 0 ? '</ul>' : '</ol>', '\n');
        continue;
      }
    }
    // Paragraph: lines up to a blank line, a fence, a heading or a break.
    const p = [trimST(line)];
    i++;
    while (i < n) {
      const l2 = lines[i];
      if (paraBreak(l2)) break;
      p.push(trimST(l2));
      i++;
    }
    const inner = inlineToString(p.join('\n'), ctx);
    const html = '<p>' + inner + '</p>';
    if (excerpt === '') excerpt = inner;
    out.push(html, '\n');
  }
  return { html: out.join(''), toc, excerpt, words };
}

// ---------------------------------------------------------------- templates

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

function parsePath(text) {
  const t = trimST(text);
  if (!PATH_RE.test(t)) return null;
  return t.split('.');
}

// Remove lines that hold a single {% %} tag and nothing but spaces/tabs:
// the tag stays and still renders, but the line (including its '\n') goes.
function eatTagLines(src) {
  const lines = src.split('\n');
  let out = '';
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const a = line.indexOf('{%');
    let tag = null;
    if (a !== -1 && a === line.lastIndexOf('{%')) {
      const b = line.indexOf('%}', a + 2);
      if (b !== -1) {
        let beforeOk = true;
        for (let k = 0; k < a; k++) {
          const c = line.charCodeAt(k);
          if (c !== 32 && c !== 9) { beforeOk = false; break; }
        }
        let afterOk = true;
        for (let k = b + 2; k < line.length; k++) {
          const c = line.charCodeAt(k);
          if (c !== 32 && c !== 9) { afterOk = false; break; }
        }
        if (beforeOk && afterOk && line.indexOf('{{', a) === -1) tag = line.slice(a, b + 2);
      }
    }
    if (tag !== null) {
      out += tag; // the line's '\n' is eaten with it: no separator after
    } else {
      out += line;
      if (li < lines.length - 1) out += '\n';
    }
  }
  return out;
}

// Parse a template source into a node tree. Returns {nodes} or {error}.
function parseTemplate(src) {
  const s = eatTagLines(src);
  const root = [];
  const stack = [{ nodes: root, kind: 'root' }];
  const top = () => stack[stack.length - 1];
  const push = (node) => top().nodes.push(node);
  let i = 0;
  const n = s.length;
  let run = 0;
  const flushText = (to) => {
    if (to > run) push({ k: 't', s: s.slice(run, to) });
  };
  while (i < n) {
    if (s.startsWith('{{{', i)) {
      const j = s.indexOf('}}}', i + 3);
      if (j === -1) return { error: 'unclosed {{{' };
      const p = parsePath(s.slice(i + 3, j));
      if (p === null) return { error: 'bad path' };
      flushText(i);
      push({ k: 'v', p, raw: true });
      i = j + 3;
      run = i;
      continue;
    }
    if (s.startsWith('{{', i)) {
      const j = s.indexOf('}}', i + 2);
      if (j === -1) return { error: 'unclosed {{' };
      const p = parsePath(s.slice(i + 2, j));
      if (p === null) return { error: 'bad path' };
      flushText(i);
      push({ k: 'v', p, raw: false });
      i = j + 2;
      run = i;
      continue;
    }
    if (s.startsWith('{%', i)) {
      const j = s.indexOf('%}', i + 2);
      if (j === -1) return { error: 'unclosed {%' };
      const tag = trimST(s.slice(i + 2, j));
      flushText(i);
      if (tag === 'endfor') {
        if (top().kind !== 'for') return { error: 'endfor without for' };
        stack.pop();
      } else if (tag === 'endif') {
        if (top().kind !== 'if') return { error: 'endif without if' };
        stack.pop();
      } else if (tag === 'else') {
        if (top().kind !== 'if' || top().node.els !== null) return { error: 'else without if' };
        top().node.els = [];
        top().nodes = top().node.els;
      } else if (tag.startsWith('for ')) {
        const m = /^for ([A-Za-z_][A-Za-z0-9_]*) in (.+)$/.exec(tag);
        if (!m) return { error: 'bad for' };
        const p = parsePath(m[2]);
        if (p === null) return { error: 'bad path' };
        const node = { k: 'f', v: m[1], p, body: [] };
        push(node);
        stack.push({ nodes: node.body, kind: 'for' });
      } else if (tag.startsWith('if ')) {
        let rest = tag.slice(3);
        let neg = false;
        if (rest.startsWith('not ')) { neg = true; rest = rest.slice(4); }
        const p = parsePath(rest);
        if (p === null) return { error: 'bad path' };
        const node = { k: 'i', p, neg, body: [], els: null };
        push(node);
        stack.push({ nodes: node.body, kind: 'if', node });
      } else if (tag.startsWith('include ')) {
        const m = /^include "([^"]*)"$/.exec(tag);
        if (!m) return { error: 'bad include' };
        push({ k: 'c', n: m[1] });
      } else {
        return { error: 'unknown tag' };
      }
      i = j + 2;
      run = i;
      continue;
    }
    i++;
  }
  flushText(n);
  if (stack.length !== 1) {
    const open = top().kind;
    return { error: open === 'for' ? 'unclosed for' : 'unclosed if' };
  }
  return { nodes: root };
}

const HAS = Object.prototype.hasOwnProperty;

// One step down a path, with the reference semantics: a string's 'length'
// and numeric index work, anything else on a non-object is undefined, and
// only own properties are read.
function tailSeg(v, seg) {
  if (v === null || (typeof v !== 'object' && typeof v !== 'function')) {
    if (typeof v === 'string' && seg === 'length') return v.length;
    if (typeof v === 'string' && NUM_SEG_RE.test(seg)) {
      const n = Number(seg);
      return n < v.length ? v[n] : undefined;
    }
    return undefined;
  }
  return HAS.call(v, seg) ? v[seg] : undefined;
}

function resolvePath(parts, frames, values) {
  const first = parts[0];
  let v;
  if (frames.length === 0) {
    if (!HAS.call(values, first)) return undefined;
    v = values[first];
  } else {
    let found = false;
    for (let f = frames.length - 1; f >= 0; f--) {
      if (HAS.call(frames[f], first)) { v = frames[f][first]; found = true; break; }
    }
    if (!found) {
      if (HAS.call(values, first)) v = values[first];
      else return undefined;
    }
  }
  for (let i = 1; i < parts.length; i++) {
    v = tailSeg(v, parts[i]);
    if (v === undefined) return undefined;
  }
  return v;
}

// A value as the template writes it: strings as they are, numbers and
// booleans spelled out, arrays joined with ', ', everything else nothing.
function valueToString(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let s = '';
    for (let i = 0; i < v.length; i++) {
      if (i > 0) s += ', ';
      s += valueToString(v[i]);
    }
    return s;
  }
  return '';
}

// An escaped template value: strings are escaped, numbers/booleans spelled
// out (they hold no escapable character), arrays joined then escaped.
function escValue(v) {
  if (typeof v === 'string') return esc(v);
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return esc(valueToString(v));
  return '';
}

function isTruthy(v) {
  if (v === undefined || v === null || v === false || v === '' || v === 0) return false;
  if (Array.isArray(v) && v.length === 0) return false;
  return true;
}

// ---------------------------------------------------------------- template codegen
//
// A parsed template is compiled once per case into a JS function
// fn(F, V, T, O, D): F = frames array, V = values, T = compiled templates,
// O = output array, D = include depth. The generated code is straight-line:
// text is pushed, variables are resolved, loops are native `for` loops.
// A loop variable (and `loop`) inside its own body is a JS local, so the
// common `p.title` / `loop.index` reads cost one property load; anything
// else goes through resolvePath, which also covers variables an included
// template inherits from its includer's frames.

function foldTail(base, parts, i) {
  let e = base;
  for (; i < parts.length; i++) e = 'tailSeg(' + e + ',' + JSON.stringify(parts[i]) + ')';
  return e;
}

// JS expression for a path, given the statically known enclosing loops
// (ctx.scope, innermost last: {v: loop var, item: JS local, loop: JS local}).
function pathExpr(parts, ctx) {
  const first = parts[0];
  for (let s = ctx.scope.length - 1; s >= 0; s--) {
    if (ctx.scope[s].v === first) return foldTail(ctx.scope[s].item, parts, 1);
  }
  if (first === 'loop' && ctx.scope.length > 0) return foldTail(ctx.scope[ctx.scope.length - 1].loop, parts, 1);
  // Direct values access: the values object only ever holds these keys, and
  // no for-loop in the case binds one of them, so no frame can shadow the
  // root — it reads straight from V (absent reads as undefined, as before).
  if (VALUE_KEYS.has(first) && !ctx.loopVars.has(first)) return foldTail('V.' + first, parts, 1);
  // Shared path table: one array per distinct path, no allocation per render.
  const key = JSON.stringify(parts);
  let idx = ctx.pathMap.get(key);
  if (idx === undefined) {
    idx = ctx.paths.length;
    ctx.paths.push(parts);
    ctx.pathMap.set(key, idx);
  }
  return 'resolvePath(P[' + idx + '],F,V)';
}

function genNodes(nodes, ctx, out) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const node = nodes[ni];
    if (node.k === 't') { out.push('O.push(' + JSON.stringify(node.s) + ');'); continue; }
    if (node.k === 'v') {
      const u = ctx.uid++;
      const expr = pathExpr(node.p, ctx);
      if (node.raw) out.push('{const v' + u + '=' + expr + ';if(v' + u + '!=null)O.push(valueToString(v' + u + '));}');
      else out.push('{const v' + u + '=' + expr + ';if(v' + u + '!=null)O.push(escValue(v' + u + '));}');
      continue;
    }
    if (node.k === 'f') {
      const u = ctx.uid++;
      const a = '__a' + u, fr = '__f' + u, lp = '__l' + u, it = '__i' + u, item = '__t' + u;
      const pexpr = pathExpr(node.p, ctx);
      out.push('{const ' + a + '=' + pexpr + ';if(Array.isArray(' + a + ')&&' + a + '.length){const ' + fr + '={};const ' + lp + '={index:0,first:false,last:false,length:' + a + '.length};' + fr + '.loop=' + lp + ';F.push(' + fr + ');for(let ' + it + '=0;' + it + '<' + a + '.length;' + it + '++){const ' + item + '=' + a + '[' + it + '];' + fr + '[' + JSON.stringify(node.v) + ']=' + item + ';' + lp + '.index=' + it + '+1;' + lp + '.first=' + it + '===0;' + lp + '.last=' + it + '===' + a + '.length-1;');
      ctx.scope.push({ v: node.v, item, loop: lp });
      genNodes(node.body, ctx, out);
      ctx.scope.pop();
      out.push('}F.pop();}}');
      continue;
    }
    if (node.k === 'i') {
      const u = ctx.uid++;
      const pexpr = pathExpr(node.p, ctx);
      const cond = node.neg ? '!isTruthy(v' + u + ')' : 'isTruthy(v' + u + ')';
      out.push('{const v' + u + '=' + pexpr + ';if(' + cond + '){');
      genNodes(node.body, ctx, out);
      out.push('}');
      if (node.els !== null) { out.push('else{'); genNodes(node.els, ctx, out); out.push('}'); }
      out.push('}');
      continue;
    }
    if (node.k === 'c') {
      out.push('{if(D<8){const t=T[' + JSON.stringify(node.n) + '];if(t)t(F,V,T,O,D+1);}}');
      continue;
    }
  }
}

// Keys a values object can hold (the four constructions in run()). None is
// an Object.prototype property, so a missing key reads as undefined.
const VALUE_KEYS = new Set(['site', 'tags', 'recent', 'page', 'posts', 'pager', 'tag']);

// Every name a for-loop binds anywhere in the case: a frame only ever
// carries its loop variable and 'loop', so these are the only roots a
// frame can shadow.
function collectLoopVars(nodes, set) {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.k === 'f') { set.add(node.v); collectLoopVars(node.body, set); }
    else if (node.k === 'i') { collectLoopVars(node.body, set); if (node.els) collectLoopVars(node.els, set); }
  }
}

function compileTemplate(nodes, loopVars) {
  const ctx = { scope: [], uid: 0, paths: [], pathMap: new Map(), loopVars };
  const parts = [];
  genNodes(nodes, ctx, parts);
  const factory = new Function('resolvePath', 'valueToString', 'escValue', 'isTruthy', 'tailSeg', 'P',
    'return function(F,V,T,O,D){\n' + parts.join('\n') + '\n}');
  return factory(resolvePath, valueToString, escValue, isTruthy, tailSeg, ctx.paths);
}

// One scratch array for template rendering: renderTemplate is never
// re-entered (includes append to the same array), so a shared array
// avoids one allocation per rendered page.
const TPL_OUT = [];
function renderTemplate(tpl, values, templates) {
  TPL_OUT.length = 0;
  tpl([], values, templates, TPL_OUT, 0);
  return TPL_OUT.join('');
}

// ---------------------------------------------------------------- build

export function run(input) {
  SLUG_CACHE.clear();
  DATE_CACHE.clear();
  const site = input.site;
  let base = site.base_url;
  while (base.length > 0 && base.charCodeAt(base.length - 1) === 47) base = base.slice(0, -1);
  const perPage = site.per_page;
  const recentN = site.recent;

  // Templates, parsed in code-unit order of name, then compiled once.
  const templates = {};
  const report = [];
  const names = Object.keys(input.templates || {}).sort();
  const parsed = {};
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const r = parseTemplate(input.templates[name]);
    if (r.error) {
      report.push('template "' + name + '": ' + r.error);
      continue;
    }
    parsed[name] = r.nodes;
  }
  const loopVars = new Set();
  for (let i = 0; i < names.length; i++) {
    if (parsed[names[i]]) collectLoopVars(parsed[names[i]], loopVars);
  }
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    if (parsed[name]) templates[name] = compileTemplate(parsed[name], loopVars);
  }

  // Sources sorted by path in code-unit order.
  const files = (input.files || []).slice().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const statics = [];
  const staticSet = new Set();
  const pages = []; // surviving sources, in source order
  const takenByDir = new Map(); // dir -> Set of slugs
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (!f.path.endsWith('.md')) {
      statics.push(f);
      staticSet.add(f.path);
      continue;
    }
    const rawC = f.content;
    const content = rawC.indexOf('\r') === -1 ? rawC : rawC.replace(/\r\n?/g, '\n');
    const parsed = parseFrontMatter(content);
    if (parsed.refusal) {
      report.push('refused ' + f.path + ': ' + parsed.refusal);
      continue;
    }
    const fm = parsed.fm;
    const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
    const isPost = dir === 'posts' || dir.startsWith('posts/');
    const topDir = dir === '' ? '' : dir.split('/')[0];
    if (topDir === 'tags' || topDir === 'page') {
      report.push('refused ' + f.path + ': ' + topDir + '/ is the generator\'s own');
      continue;
    }
    if (isPost && fm.date === undefined) {
      report.push('refused ' + f.path + ': a post needs a date');
      continue;
    }
    const layout = fm.layout !== undefined ? fm.layout : (isPost ? 'post' : 'page');
    if (!templates[layout]) {
      report.push('refused ' + f.path + ': layout "' + layout + '" is no template that parses');
      continue;
    }
    if (fm.draft === true) {
      report.push('draft ' + f.path);
      continue;
    }
    // Permalink slug, unique in its output directory in source order:
    // a post's directory is 'posts', a page's is its source's directory.
    const outDir = isPost ? 'posts' : dir;
    let taken = takenByDir.get(outDir);
    if (!taken) {
      taken = new Set();
      if (outDir === '') { taken.add('posts'); taken.add('tags'); taken.add('page'); }
      takenByDir.set(outDir, taken);
    }
    const baseSlug = fm.slug !== undefined ? fm.slug : cachedSlugify(fm.title);
    let slug = baseSlug;
    let k = 2;
    while (taken.has(slug)) { slug = baseSlug + '-' + k; k++; }
    taken.add(slug);
    const url = base + '/' + (outDir === '' ? '' : outDir + '/') + slug + '/';
    const outPath = (outDir === '' ? '' : outDir + '/') + slug + '/index.html';
    pages.push({
      path: f.path, fm, dir, isPost, layout, slug, url, outPath,
      body: parsed.body,
    });
  }

  // Source path -> page url, for link resolution.
  const pageBySource = new Map();
  for (let i = 0; i < pages.length; i++) pageBySource.set(pages[i].path, pages[i].url);

  // Render bodies.
  const broken = new Set();
  const posts = [];
  for (let i = 0; i < pages.length; i++) {
    const pg = pages[i];
    const srcDir = pg.dir;
    const ctx = { srcDir, pageBySource, staticSet, base, srcPath: pg.path, broken };
    const r = renderBody(pg.body, ctx);
    pg.content = r.html;
    pg.toc = r.toc;
    pg.excerpt = r.excerpt;
    pg.words = r.words;
    pg.reading = Math.max(1, Math.ceil(r.words / 200));
    if (pg.isPost) posts.push(pg);
  }
  for (const b of broken) report.push(b);

  // Collections: posts newest date first, equal dates by slug.
  posts.sort((a, b) => {
    if (a.fm.date !== b.fm.date) return a.fm.date < b.fm.date ? 1 : -1;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });
  for (let i = 0; i < posts.length; i++) {
    posts[i].newer = i > 0 ? posts[i - 1] : null;
    posts[i].older = i < posts.length - 1 ? posts[i + 1] : null;
  }

  // Tags from posts, walking the collection order.
  const tagBySlug = new Map();
  const tagList = [];
  for (let i = 0; i < posts.length; i++) {
    const pg = posts[i];
    const seen = new Set();
    const ptags = [];
    const names2 = pg.fm.tags || [];
    for (let t = 0; t < names2.length; t++) {
      const name = names2[t];
      const slug = cachedSlugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      let tag = tagBySlug.get(slug);
      if (!tag) {
        tag = { name, slug, url: base + '/tags/' + slug + '/', count: 0, posts: [] };
        tagBySlug.set(slug, tag);
        tagList.push(tag);
      }
      tag.count++;
      tag.posts.push(pg);
      ptags.push(tag);
    }
    pg.tagObjs = ptags;
  }
  tagList.sort((a, b) => {
    if (a.count !== b.count) return b.count - a.count;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });

  // Cards.
  function cardOf(pg) {
    if (pg.card) return pg.card;
    const tags = [];
    const srcs = pg.isPost ? pg.tagObjs : tagObjsForPage(pg);
    for (let i = 0; i < srcs.length; i++) {
      const t = srcs[i];
      tags.push({ name: t.name, slug: t.slug, url: t.url });
    }
    const date = pg.fm.date !== undefined ? pg.fm.date : '';
    const card = {
      title: pg.fm.title,
      url: pg.url,
      date,
      date_long: date === '' ? '' : cachedDateLong(date),
      summary: pg.fm.summary !== undefined ? pg.fm.summary : '',
      excerpt: pg.excerpt,
      reading_minutes: pg.reading,
      tags,
    };
    pg.card = card;
    return card;
  }
  function tagObjsForPage(pg) {
    // A page's tags link to the tag of the same slug, or url "" where no post has it.
    const seen = new Set();
    const out = [];
    const names2 = pg.fm.tags || [];
    for (let t = 0; t < names2.length; t++) {
      const name = names2[t];
      const slug = cachedSlugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      const tag = tagBySlug.get(slug);
      if (tag) out.push(tag);
      else out.push({ name, slug, url: '' });
    }
    return out;
  }

  const siteVal = { title: site.title, base_url: base };
  const tagsVal = tagList.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.count }));
  const recentVal = posts.slice(0, recentN).map(cardOf);

  function pageVal(pg) {
    const card = cardOf(pg);
    const newer = pg.isPost && pg.newer
      ? { title: pg.newer.fm.title, url: pg.newer.url, date: pg.newer.fm.date, date_long: cachedDateLong(pg.newer.fm.date) }
      : null;
    const older = pg.isPost && pg.older
      ? { title: pg.older.fm.title, url: pg.older.url, date: pg.older.fm.date, date_long: cachedDateLong(pg.older.fm.date) }
      : null;
    return {
      title: card.title, url: card.url, date: card.date, date_long: card.date_long,
      summary: card.summary, excerpt: card.excerpt, reading_minutes: card.reading_minutes,
      tags: card.tags, slug: pg.slug, content: pg.content, toc: pg.toc,
      newer, older, is_post: pg.isPost,
    };
  }

  const output = {};
  const builtPaths = new Set();

  // Content pages.
  for (let i = 0; i < pages.length; i++) {
    const pg = pages[i];
    const tpl = templates[pg.layout];
    const values = { site: siteVal, tags: tagsVal, recent: recentVal, page: pageVal(pg) };
    output[pg.outPath] = renderTemplate(tpl, values, templates);
    builtPaths.add(pg.outPath);
  }

  // Index pages.
  const totalPages = Math.max(1, Math.ceil(posts.length / perPage));
  if (templates.index) {
    for (let n = 1; n <= totalPages; n++) {
      const chunk = posts.slice((n - 1) * perPage, n * perPage).map(cardOf);
      const url = n === 1 ? base + '/' : base + '/page/' + n + '/';
      const pager = {
        number: n, total: totalPages, url,
        newer_url: n > 1 ? (n === 2 ? base + '/' : base + '/page/' + (n - 1) + '/') : '',
        older_url: n < totalPages ? base + '/page/' + (n + 1) + '/' : '',
      };
      const values = { site: siteVal, tags: tagsVal, recent: recentVal, posts: chunk, pager };
      const outPath = n === 1 ? 'index.html' : 'page/' + n + '/index.html';
      output[outPath] = renderTemplate(templates.index, values, templates);
      builtPaths.add(outPath);
    }
  }

  // Tag pages + tags index.
  if (templates.tag) {
    for (let i = 0; i < tagList.length; i++) {
      const t = tagList[i];
      const tagVal = { name: t.name, slug: t.slug, url: t.url, count: t.count, posts: t.posts.map(cardOf) };
      const values = { site: siteVal, tags: tagsVal, recent: recentVal, tag: tagVal };
      const outPath = 'tags/' + t.slug + '/index.html';
      output[outPath] = renderTemplate(templates.tag, values, templates);
      builtPaths.add(outPath);
    }
  }
  if (templates.tags) {
    const values = { site: siteVal, tags: tagsVal, recent: recentVal };
    output['tags/index.html'] = renderTemplate(templates.tags, values, templates);
    builtPaths.add('tags/index.html');
  }

  // Static files.
  let staticCount = 0;
  for (let i = 0; i < statics.length; i++) {
    const f = statics[i];
    if (builtPaths.has(f.path)) {
      report.push('shadowed ' + f.path + ': a built page has its path');
      continue;
    }
    output[f.path] = f.content;
    staticCount++;
  }

  // Report.
  report.sort();
  const nPages = pages.length - posts.length;
  const lines = report.map((l) => l + '\n');
  lines.push('built ' + nPages + ' pages, ' + posts.length + ' posts, ' + tagList.length + ' tags and ' + staticCount + ' static files\n');
  output['build-report.txt'] = lines.join('');

  return output;
}
