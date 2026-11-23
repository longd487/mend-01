// main.ts is mend, the CLI SPEC.md specifies. It does all ten sections of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, line matching at three tiers, unified diffs, SEARCH/REPLACE blocks,
// V4A patches, JSON edits and the all-or-nothing write. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

// ---------- section 3: a file as lines ----------

interface FileText {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileText {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  let final = false;
  if (text.endsWith(br)) {
    parts.pop();
    final = true;
  }
  return { lines: parts, br, final };
}

function joinFile(f: FileText): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

// ---------- section 5: matching lines ----------

function stripTrail(s: string): string {
  return s.replace(/[ \t]+$/, '');
}
function stripBoth(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}
function occurrences(file: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  const n = o.length;
  if (n === 0) return out;
  for (let i = 0; i + n <= file.length; i++) {
    let ok = true;
    for (let j = 0; j < n; j++) {
      if (!lineEq(file[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}
function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}
/** Tier 2 re-indentation (section 5): a non-context new line starting with O's first line's leading
 * whitespace has that prefix replaced by the file's first matched line's. */
function reindent(text: string, oFirst: string, fileFirst: string): string {
  if (text === '' || text.trim() === '') return text;
  const p = leadingWs(oFirst);
  if (!text.startsWith(p)) return text;
  return leadingWs(fileFirst) + text.slice(p.length);
}

/** A new line: `ctx >= 0` mirrors O's line at that index (a context line, written as the file's own matched
 * line); `ctx === -1` is a fresh line. */
interface NewLine {
  text: string;
  ctx: number;
}
interface Replacement {
  o: string[];
  n: NewLine[];
}

function mapNew(f: FileText, at: number, r: Replacement, tier: number): string[] {
  return r.n.map((nl) => {
    if (nl.ctx >= 0) return f.lines[at + nl.ctx]!;
    if (tier === 2 && r.o.length > 0) return reindent(nl.text, r.o[0]!, f.lines[at]!);
    return nl.text;
  });
}
function replaceAt(f: FileText, at: number, r: Replacement, tier: number): FileText {
  const lines = [...f.lines.slice(0, at), ...mapNew(f, at, r, tier), ...f.lines.slice(at + r.o.length)];
  return { lines, br: f.br, final: f.final };
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<{ old: string; new: string }> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------- section 6: unified diffs ----------

interface Hunk {
  a: number;
  o: string[];
  n: NewLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noEol: boolean;
  /** A `\` line follows the hunk's last `+` line (for creations). */
  lastPlusNoEol: boolean;
}
interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

const DIFF_GIT = /^diff --git a\/(\S+) b\/(\S+)$/;
const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** The path of a `--- ` / `+++ ` line: text after the four characters, up to the first tab, surrounding spaces
 * removed; `/dev/null` means no file, a leading `a/` or `b/` is removed. */
function headerPath(line: string): string | null {
  const t = line.slice(4).split('\t')[0]!.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) return t.slice(2);
  return t;
}

interface BodyItem {
  kind: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
}

function parseHunk(lines: string[], i: number): { hunk: Hunk; next: number } {
  const m = HUNK_HEAD.exec(lines[i]!);
  if (m === null) throw new Exit2(`error: parse ${i + 1}`);
  const a = parseInt(m[1]!, 10);
  const items: BodyItem[] = [];
  let j = i + 1;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') {
      items.push({ kind: 'ctx', text: '' });
      j++;
      continue;
    }
    const c = l[0]!;
    if (c === ' ') {
      items.push({ kind: 'ctx', text: l.slice(1) });
      j++;
      continue;
    }
    if (c === '-') {
      items.push({ kind: 'old', text: l.slice(1) });
      j++;
      continue;
    }
    if (c === '+') {
      items.push({ kind: 'new', text: l.slice(1) });
      j++;
      continue;
    }
    if (c === '\\') {
      items.push({ kind: 'bs', text: l });
      j++;
      continue;
    }
    break;
  }
  // Empty lines at the end of a body are not part of it.
  let end = items.length;
  while (end > 0 && items[end - 1]!.kind === 'ctx' && items[end - 1]!.text === '') end--;
  const body = items.slice(0, end);
  let noEol = false;
  let lastPlusNoEol = false;
  for (let k = body.length - 1; k >= 0; k--) {
    if (body[k]!.kind === 'ctx' || body[k]!.kind === 'new') {
      noEol = k + 1 < body.length && body[k + 1]!.kind === 'bs';
      break;
    }
  }
  for (let k = body.length - 1; k >= 0; k--) {
    if (body[k]!.kind === 'new') {
      lastPlusNoEol = k + 1 < body.length && body[k + 1]!.kind === 'bs';
      break;
    }
  }
  const o: string[] = [];
  const n: NewLine[] = [];
  for (const it of body) {
    if (it.kind === 'ctx') {
      o.push(it.text);
      n.push({ text: it.text, ctx: o.length - 1 });
    } else if (it.kind === 'old') o.push(it.text);
    else if (it.kind === 'new') n.push({ text: it.text, ctx: -1 });
  }
  return { hunk: { a, o, n, noEol, lastPlusNoEol }, next: j };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  interface Sec {
    oldPath: string | null;
    newPath: string | null;
    pairSeen: boolean;
    newFile: boolean;
    deletedFile: boolean;
    hunks: Hunk[];
  }
  const secs: Sec[] = [];
  let cur: Sec | null = null;
  let state: 'outside' | 'header' | 'between' = 'outside';
  const startSection = (oldP: string | null, newP: string | null): void => {
    cur = { oldPath: oldP, newPath: newP, pairSeen: false, newFile: false, deletedFile: false, hunks: [] };
    secs.push(cur);
    state = 'header';
  };
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(l.trimEnd());
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      startSection(m[1]!, m[2]!);
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const { hunk, next } = parseHunk(lines, i);
      cur.hunks.push(hunk);
      state = 'between';
      i = next;
      continue;
    }
    if (state === 'header' && cur !== null) {
      if (l.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          cur.oldPath = headerPath(l);
          cur.newPath = headerPath(lines[i + 1]!);
          cur.pairSeen = true;
          i += 2;
          continue;
        }
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (l.startsWith('+++ ')) {
        cur.newPath = headerPath(l);
        cur.pairSeen = true;
        i++;
        continue;
      }
      if (l.startsWith('rename from ')) {
        if (!cur.pairSeen) cur.oldPath = l.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (l.startsWith('rename to ')) {
        if (!cur.pairSeen) cur.newPath = l.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (l.startsWith('new file mode')) {
        cur.newFile = true;
        i++;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        cur.deletedFile = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldP = headerPath(l);
      const newP = headerPath(lines[i + 1]!);
      startSection(oldP, newP);
      cur!.pairSeen = true;
      i += 2;
      continue;
    }
    i++;
  }
  return secs.map((s) => uniEdit(s, strict));
}

function uniKind(s: UniSection): 'create' | 'delete' | 'move' | 'change' {
  const o = s.oldPath;
  const n = s.newPath;
  if ((o === null || s.newFile) && n !== null) return 'create';
  if ((n === null || s.deletedFile) && o !== null) return 'delete';
  if (o !== null && n !== null && o !== n) return 'move';
  return 'change';
}

/** Apply a section's hunks in order to a file's text; `d` is the drift of hunks applied so far. */
function applyHunksTo(content: string, hunks: Hunk[], strict: boolean, path: string): string {
  let f = splitFile(content);
  let d = 0;
  for (const h of hunks) {
    if (h.o.length === 0) {
      const pos = Math.max(0, Math.min(h.a + d, f.lines.length));
      const lines = [...f.lines.slice(0, pos), ...h.n.map((nl) => nl.text), ...f.lines.slice(pos)];
      const final = pos === f.lines.length ? !h.noEol : f.final;
      f = { lines, br: f.br, final };
      d += h.n.length;
      continue;
    }
    const tiers = strict ? [0] : [0, 1, 2];
    let tier = -1;
    let occ: number[] = [];
    for (const t of tiers) {
      occ = occurrences(f.lines, h.o, t);
      if (occ.length > 0) {
        tier = t;
        break;
      }
    }
    if (tier < 0) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = occ[0]!;
    for (const p of occ) {
      if (Math.abs(p - target) < Math.abs(best - target)) best = p;
    }
    const after = replaceAt(f, best, { o: h.o, n: h.n }, tier);
    const reachesEnd = best + h.o.length === f.lines.length;
    f = { ...after, final: reachesEnd ? !h.noEol : f.final };
    d += h.n.length - h.o.length;
  }
  return joinFile(f);
}

function uniEdit(s: UniSection, strict: boolean): Edit {
  return (tree) => {
    const kind = uniKind(s);
    const o = s.oldPath;
    const n = s.newPath;
    if (o !== null && !safe(o)) throw new Fail('unsafe', o);
    if (n !== null && !safe(n)) throw new Fail('unsafe', n);
    if (kind === 'create') {
      const np = n!;
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const plus: string[] = [];
      let lastPlusNoEol = false;
      for (const h of s.hunks) {
        let saw = false;
        for (const nl of h.n) {
          if (nl.ctx === -1) {
            plus.push(nl.text);
            saw = true;
          }
        }
        if (saw) lastPlusNoEol = h.lastPlusNoEol;
      }
      tree.now.set(np, plus.length === 0 ? '' : plus.join('\n') + (lastPlusNoEol ? '' : '\n'));
      return;
    }
    if (kind === 'delete') {
      const op = o!;
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    if (kind === 'move') {
      const op = o!;
      const np = n!;
      if (tree.get(op) === null) throw new Fail('missing', op);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const after = applyHunksTo(tree.get(op)!, s.hunks, strict, op);
      tree.now.set(np, after);
      tree.now.set(op, null);
      tree.moves.push({ old: op, new: np });
      return;
    }
    const p = o ?? '';
    if (tree.get(p) === null) throw new Fail('missing', p);
    tree.now.set(p, applyHunksTo(tree.get(p)!, s.hunks, strict, p));
  };
}

// ---------- section 7: SEARCH/REPLACE blocks ----------

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
    }
    if (eq === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
    }
    if (rep === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const oldLines = lines.slice(searchIdx + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = splitFile(before);
    const tiers = strict ? [0] : [0, 1, 2];
    let tier = -1;
    let occ: number[] = [];
    for (const t of tiers) {
      occ = occurrences(f.lines, oldLines, t);
      if (occ.length > 0) {
        tier = t;
        break;
      }
    }
    if (tier < 0) throw new Fail('no-match', path);
    if (occ.length > 1) throw new Fail('ambiguous', path);
    const at = occ[0]!;
    const mapped = newLines.map((nl) => (tier === 2 ? reindent(nl, oldLines[0]!, f.lines[at]!) : nl));
    const lines = [...f.lines.slice(0, at), ...mapped, ...f.lines.slice(at + oldLines.length)];
    tree.now.set(path, joinFile({ lines, br: f.br, final: f.final }));
  };
}

// ---------- section 8: V4A patches ----------

interface VChunk {
  anchor: string | null;
  o: string[];
  n: NewLine[];
  eof: boolean;
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    if (l.startsWith('*** Add File: ')) {
      const path = l.slice('*** Add File: '.length).trim();
      const secLines: string[] = [];
      let j = i + 1;
      while (j < last) {
        const m = lines[j]!;
        if (isSectionStart(m) || m.trim() === '*** End Patch') break;
        if (m === '') {
          secLines.push('');
          j++;
          continue;
        }
        if (m.startsWith('+')) {
          secLines.push(m.slice(1));
          j++;
          continue;
        }
        throw new Exit2(`error: parse ${j + 1}`);
      }
      while (secLines.length > 0 && secLines[secLines.length - 1] === '') secLines.pop();
      edits.push(v4aAddEdit(path, secLines));
      i = j;
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const path = l.slice('*** Delete File: '.length).trim();
      let j = i + 1;
      while (j < last && blank(lines[j]!)) j++;
      if (j < last) {
        const m = lines[j]!;
        if (!isSectionStart(m) && m.trim() !== '*** End Patch') throw new Exit2(`error: parse ${j + 1}`);
      }
      edits.push(v4aDeleteEdit(path));
      i = j;
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const path = l.slice('*** Update File: '.length).trim();
      const parsed = parseV4aUpdate(lines, i + 1, last, isSectionStart);
      if (parsed.moveTo === null && parsed.chunks.length === 0) throw new Exit2(`error: parse ${i + 1}`);
      edits.push(v4aUpdateEdit(path, parsed.moveTo, parsed.chunks, strict));
      i = parsed.next;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

/** Parse an Update File section's body: an optional `*** Move to:` first line, then chunks. A chunk starts at
 * an `@@` line or, for the first chunk, at a body line; `*** End of File` ends a chunk and anchors it to the end
 * of the file. Blank lines after a chunk ended by `*** End of File` are ignored; blank lines inside a chunk are
 * empty context lines. */
function parseV4aUpdate(
  lines: string[],
  start: number,
  last: number,
  isSectionStart: (l: string) => boolean,
): { moveTo: string | null; chunks: VChunk[]; next: number } {
  let moveTo: string | null = null;
  const chunks: VChunk[] = [];
  let j = start;
  if (j < last && lines[j]!.startsWith('*** Move to: ')) {
    moveTo = lines[j]!.slice('*** Move to: '.length).trim();
    j++;
  }
  let cur: VChunk | null = null;
  const closeChunk = (): void => {
    if (cur !== null) {
      chunks.push(cur);
      cur = null;
    }
  };
  while (j < last) {
    const l = lines[j]!;
    if (isSectionStart(l) || l.trim() === '*** End Patch') break;
    if (l === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${j + 1}`);
      cur.eof = true;
      closeChunk();
      j++;
      continue;
    }
    if (l.startsWith('@@')) {
      closeChunk();
      const anchor = l.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, o: [], n: [], eof: false };
      j++;
      continue;
    }
    if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
      if (cur === null) {
        if (chunks.length > 0) throw new Exit2(`error: parse ${j + 1}`);
        cur = { anchor: null, o: [], n: [], eof: false };
      }
      if (l === '') {
        cur.o.push('');
        cur.n.push({ text: '', ctx: cur.o.length - 1 });
      } else if (l[0] === ' ') {
        const t = l.slice(1);
        cur.o.push(t);
        cur.n.push({ text: t, ctx: cur.o.length - 1 });
      } else if (l[0] === '-') cur.o.push(l.slice(1));
      else cur.n.push({ text: l.slice(1), ctx: -1 });
      j++;
      continue;
    }
    throw new Exit2(`error: parse ${j + 1}`);
  }
  closeChunk();
  // Blank lines at the end of the section are not part of it: drop trailing empty context lines from the last
  // chunk, unless it ended at `*** End of File` (its blanks sit before that line, not at the section's end).
  if (chunks.length > 0) {
    const lc = chunks[chunks.length - 1]!;
    if (!lc.eof) {
      while (
        lc.o.length > 0 &&
        lc.n.length > 0 &&
        lc.o[lc.o.length - 1] === '' &&
        lc.n[lc.n.length - 1]!.ctx === lc.o.length - 1 &&
        lc.n[lc.n.length - 1]!.text === ''
      ) {
        lc.o.pop();
        lc.n.pop();
      }
    }
  }
  return { moveTo, chunks, next: j };
}

function v4aAddEdit(path: string, secLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, secLines.length === 0 ? '' : secLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let f = splitFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const tiers = strict ? [0] : [0, 1, 2];
        let found = -1;
        for (const t of tiers) {
          for (let k = cursor; k < f.lines.length; k++) {
            if (lineEq(f.lines[k]!, ch.anchor, t)) {
              found = k;
              break;
            }
          }
          if (found >= 0) break;
        }
        if (found < 0) throw new Fail('no-match', path);
        cursor = found + 1;
      }
      if (ch.o.length === 0) {
        const pos = ch.eof ? f.lines.length : cursor;
        const lines = [...f.lines.slice(0, pos), ...ch.n.map((nl) => nl.text), ...f.lines.slice(pos)];
        f = { lines, br: f.br, final: f.final };
        cursor = pos + ch.n.length;
        continue;
      }
      const tiers = strict ? [0] : [0, 1, 2];
      let tier = -1;
      let at = -1;
      for (const t of tiers) {
        const occ = occurrences(f.lines, ch.o, t).filter((p) => p >= cursor && (!ch.eof || p + ch.o.length === f.lines.length));
        if (occ.length > 0) {
          tier = t;
          at = occ[0]!;
          break;
        }
      }
      if (tier < 0) throw new Fail('no-match', path);
      f = replaceAt(f, at, { o: ch.o, n: ch.n }, tier);
      cursor = at + ch.n.length;
    }
    const out = joinFile(f);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      tree.moves.push({ old: path, new: moveTo });
    } else {
      tree.now.set(path, out);
    }
  };
}

// ---------- section 1, 2 and 10: invocation, output, order and atomicity ----------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  interface Row {
    key: string;
    line: string;
  }
  const rows: Row[] = [];
  const consumed = new Set<string>();
  for (const m of tree.moves) {
    const wasOld = tree.original(m.old);
    const nowOld = tree.get(m.old);
    const wasNew = tree.original(m.new);
    const nowNew = tree.get(m.new);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: m.new, line: `R ${m.old} -> ${m.new}` });
      consumed.add(m.old);
      consumed.add(m.new);
    }
  }
  for (const p of tree.now.keys()) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const out = rows.map((r) => r.line);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
