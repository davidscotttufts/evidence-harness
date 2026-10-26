// Test census: a mechanical read of EVERY test case's AST, so grading covers the
// whole suite instead of a sample. Port of openwop-app's scripts/test-census.mjs.
//
// Per case it flags shapes that make a test unable to fail or not worth its cost:
//   NO_ASSERT      the case asserts nothing (no expect/assert/assert-helper/query)
//   CONDITIONAL    every assertion sits under an if / ?: / catch / && / unrun callback
//   WEAK_ONLY      only toBeDefined / toBeTruthy / not.toBeNull / …
//   STATUS_ONLY    only asserts a .status / .statusCode
//   MOCK_ONLY      only asserts toHaveBeenCalled*
//   SNAPSHOT_ONLY  only snapshot/screenshot matchers
//   SKIPPED / TODO / ONLY
//   DUPLICATE_BODY the same normalised body (and the same bound constants) elsewhere
// and per file: laundering casts, fixed sleeps without fake timers, wall-clock reads
// (a note, not a cap), and whether a header says why the test exists.
//
// Each file gets a CEILING, the best grade the census allows, never a grade. Reading
// alone never deletes: a D/F ceiling only queues the file for sabotage probes first.
// A clean census is necessary for an A, never sufficient.
//
// The ledger is keyed by each file's git blob sha, so a later run reports which files
// changed since they were graded and need grading again.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

export const CENSUS_DEFAULTS = {
  testPattern: '[./](test|spec)\\.(m|c)?(j|t)sx?$',
  // What a header must name for "this test says why it exists": an ADR/RFC/issue/incident id.
  // Same rule as openwop-app's census: an ADR/RFC id, a tracker id (ABC-12, GAP-A3), an
  // issue number, or the words incident/regression.
  headerRef: '\\b(ADR|RFC)[ -]?\\d{2,4}\\b|\\bGAP-ANALYSIS\\s+[A-Z]\\d{1,3}\\b|\\b[A-Z][A-Z0-9]{1,12}-[A-Z]?\\d{1,4}\\b|\\bGap [A-Z]-\\d{1,3}\\b|incident|regression|#\\d{3,5}\\b',
  typescriptFrom: [],
};

const CASE_ROOTS = new Set(['it', 'test']);
const MODIFIERS = new Set(['skip', 'todo', 'only', 'skipIf', 'runIf', 'fails', 'each', 'concurrent', 'sequential', 'fixme', 'slow']);
const WEAK = new Set(['toBeDefined', 'toBeTruthy', 'not.toBeNull', 'not.toBeUndefined', 'toBeInstanceOf', 'not.toBeFalsy', 'not.toThrow']);
const MOCK = new Set(['toHaveBeenCalled', 'toHaveBeenCalledWith', 'toHaveBeenCalledTimes', 'toHaveBeenLastCalledWith', 'toHaveBeenNthCalledWith', 'toBeCalled', 'toBeCalledWith', 'toBeCalledTimes']);
const SNAP = new Set(['toMatchSnapshot', 'toMatchInlineSnapshot', 'toMatchFileSnapshot', 'toHaveScreenshot']);
const QUERY_RE = /^(get|find)(All)?By[A-Z]\w*$/;
const ASSERT_NAME_RE = /^(expect|assert|check|verify|must|ensure|witness)/i;
export const SEVERE = new Set(['NO_ASSERT', 'CONDITIONAL', 'DUPLICATE_BODY']);
export const WEAKCLAIM = new Set(['WEAK_ONLY', 'STATUS_ONLY', 'MOCK_ONLY', 'SNAPSHOT_ONLY']);

// The census parses with the PROJECT's own TypeScript, so hyvemind stays dependency-free.
export function loadTypeScript(root, extra = []) {
  for (const base of ['.', ...extra, 'backend/typescript', 'frontend/react', 'packages/core']) {
    const pkg = join(root, base, 'package.json');
    if (!existsSync(pkg)) continue;
    try { return createRequire(pkg)('typescript'); } catch { /* next */ }
  }
  throw new Error('census needs the `typescript` package in the project (any workspace); install it, or set census.typescriptFrom to the workspace that has it');
}

const normalise = (t) => t.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, '');

export function censusFile(ts, file, text, opt) {
  const REF_RE = new RegExp(opt.headerRef);
  const kind = file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);

  const caseCallInfo = (node) => {
    if (!ts.isCallExpression(node)) return null;
    const mods = [];
    let callee = node.expression;
    for (let guard = 0; guard < 8; guard++) {
      if (ts.isIdentifier(callee)) return CASE_ROOTS.has(callee.text) ? { mods } : null;
      if (ts.isPropertyAccessExpression(callee)) {
        if (!MODIFIERS.has(callee.name.text)) return null;
        mods.push(callee.name.text); callee = callee.expression; continue;
      }
      if (ts.isCallExpression(callee)) { callee = callee.expression; continue; } // it.each(rows)(…)
      return null;
    }
    return null;
  };
  const literalText = (n) => !n ? '' : ts.isStringLiteralLike(n) ? n.text : ts.isTemplateExpression(n) ? `${n.head.text}\${…}` : n.getText().slice(0, 80);
  const matcherOf = (call) => {
    const parts = [];
    let cur = call;
    while (cur.parent && ts.isPropertyAccessExpression(cur.parent) && cur.parent.expression === cur) { parts.push(cur.parent.name.text); cur = cur.parent; }
    return parts.filter((p) => p !== 'resolves' && p !== 'rejects' && p !== 'soft').join('.');
  };
  const isExpectCall = (n) => {
    if (!ts.isCallExpression(n)) return false;
    const e = n.expression;
    if (ts.isIdentifier(e)) return e.text === 'expect';
    return ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 'expect' && (e.name.text === 'soft' || e.name.text === 'poll');
  };
  const isConditional = (node, stopAt) => {
    for (let p = node.parent; p && p !== stopAt; p = p.parent) {
      if (ts.isIfStatement(p) || ts.isConditionalExpression(p) || ts.isCatchClause(p)) return true;
      if (ts.isBinaryExpression(p) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(p.operatorToken.kind)) return true;
      // A nested callback that may never run (a .then, a listener). Loops and known runners are fine.
      if ((ts.isArrowFunction(p) || ts.isFunctionExpression(p)) && p.parent && ts.isCallExpression(p.parent)) {
        const callee = p.parent.expression.getText();
        if (!/^(expect|it|test|describe|waitFor|vi\.waitFor|act|step|test\.step|t\.test)\b/.test(callee) && !/\.(forEach|map|every|some|filter|reduce)$/.test(callee)) return true;
      }
    }
    return false;
  };

  // Local assertion helpers: functions whose body asserts or throws.
  const assertFns = new Set();
  const visitFns = (n) => {
    let name, body;
    if (ts.isFunctionDeclaration(n) && n.name) { name = n.name.text; body = n.body; }
    else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) { name = n.name.text; body = n.initializer.body; }
    if (name && body && /\bexpect\s*[(.]|\bassert[\w.]*\s*\(|\bthrow\b/.test(body.getText())) assertFns.add(name);
    ts.forEachChild(n, visitFns);
  };
  visitFns(sf);
  const topLevel = new Map();
  for (const st of sf.statements) {
    if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && d.initializer) topLevel.set(d.name.text, d.initializer.getText().slice(0, 400));
  }

  const firstCase = text.search(/^\s*(describe|it|test)(\.\w+)*\(/m);
  const preamble = text.slice(0, firstCase === -1 ? 6000 : Math.min(firstCase, 6000));
  const header = (preamble.match(/\/\*[\s\S]*?\*\/|(?:^[ \t]*\/\/.*\n){2,}/m) ?? [''])[0];
  const fakeTimers = /useFakeTimers|setSystemTime|mock\.timers|clockShift/.test(text);
  const file$ = {
    file,
    casts: (text.match(/\bas any\b|\bas unknown as\b|@ts-(ignore|nocheck|expect-error)/g) ?? []).length,
    sleeps: fakeTimers ? 0 : (text.match(/setTimeout\([^,)]*,\s*[1-9]\d*\s*\)|\bsleep\(\s*[1-9]|waitForTimeout\(/g) ?? []).length,
    clockUses: fakeTimers ? 0 : (text.match(/\bDate\.now\(\)|new Date\(\)|Math\.random\(\)|performance\.now\(\)/g) ?? []).length,
    headerRef: REF_RE.test(header),
    hasHeader: header.trim().length > 0,
    cases: [],
  };

  // `const run = KEY ? describe : describe.skip` gates a whole suite.
  const gatedAliases = new Set([...text.matchAll(/(?:const|let)\s+(\w+)\s*=[^;\n]*\?\s*(?:describe|it|test)(?:\.\w+)?\s*:\s*(?:describe|it|test)\.skip\b/g)].map((m) => m[1]));
  const isGatedCall = (n) => ts.isCallExpression(n) && ((ts.isIdentifier(n.expression) && gatedAliases.has(n.expression.text))
    || (ts.isParenthesizedExpression(n.expression) && ts.isConditionalExpression(n.expression.expression) && /\.skip\b/.test(n.expression.expression.getText())));
  let gatedDepth = 0;
  const visit = (n) => {
    const info = caseCallInfo(n);
    if (info) {
      const fn = [...n.arguments].reverse().find((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a));
      const c = { title: literalText(n.arguments[0]), line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1, flags: [] };
      if (gatedDepth > 0 || info.mods.some((m) => ['skip', 'skipIf', 'fixme'].includes(m))) c.flags.push('SKIPPED');
      // node:test passes options: test('x', { skip: true }, fn)
      if (n.arguments.some((a) => ts.isObjectLiteralExpression(a) && /\b(skip|todo)\s*:\s*(true|['"`])/.test(a.getText()))) c.flags.push('SKIPPED');
      if (info.mods.includes('todo')) c.flags.push('TODO');
      if (info.mods.includes('only')) c.flags.push('ONLY');
      if (fn && !info.mods.includes('todo')) {
        const asserts = [];
        const walk = (m) => {
          if (isExpectCall(m)) {
            const argText = m.arguments[0]?.getText() ?? '';
            asserts.push({ matcher: matcherOf(m), conditional: isConditional(m, fn), status: /\.(status|statusCode)$/.test(argText) });
          } else if (ts.isCallExpression(m)) {
            const e = m.expression;
            const name = ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) ? `${e.expression.text}.${e.name.text}` : '';
            const head = name.split('.')[0];
            const member = ts.isPropertyAccessExpression(e) ? e.name.text : name;
            if (head === 'assert' || name.startsWith('t.assert') || assertFns.has(head) || (head && head !== 'expect' && ASSERT_NAME_RE.test(head))) {
              asserts.push({ matcher: `helper:${name}`, conditional: isConditional(m, fn), status: false });
            } else if (QUERY_RE.test(member)) {
              asserts.push({ matcher: `query:${member}`, conditional: isConditional(m, fn), status: false });
            }
          }
          ts.forEachChild(m, walk);
        };
        walk(fn.body);
        if (asserts.length === 0) c.flags.push('NO_ASSERT');
        else {
          if (asserts.every((a) => a.conditional)) c.flags.push('CONDITIONAL');
          const plain = asserts.filter((a) => !a.matcher.startsWith('helper:') && !a.matcher.startsWith('query:'));
          if (plain.length === asserts.length) {
            if (plain.every((a) => WEAK.has(a.matcher))) c.flags.push('WEAK_ONLY');
            if (plain.every((a) => a.status)) c.flags.push('STATUS_ONLY');
            if (plain.every((a) => MOCK.has(a.matcher.replace(/^not\./, '')))) c.flags.push('MOCK_ONLY');
            if (plain.every((a) => SNAP.has(a.matcher))) c.flags.push('SNAPSHOT_ONLY');
          }
        }
        c.assertions = asserts.length;
        // Identical text over DIFFERENT bound constants is not redundancy: fold them in.
        const used = new Set();
        const collect = (m) => { if (ts.isIdentifier(m)) used.add(m.text); ts.forEachChild(m, collect); };
        collect(fn.body);
        const bound = [...used].filter((id) => topLevel.has(id)).sort().map((id) => `${id}=${topLevel.get(id)}`).join(';');
        const norm = `${normalise(fn.body.getText())}|${normalise(bound)}`;
        if (norm.length > 120) c.hash = createHash('sha1').update(norm).digest('hex');
      }
      file$.cases.push(c);
      return;
    }
    const gated = isGatedCall(n);
    if (gated) gatedDepth++;
    ts.forEachChild(n, visit);
    if (gated) gatedDepth--;
  };
  visit(sf);
  return file$;
}

// The best grade the census allows. Can-it-fail flags drive D/F; weak claims cap at C/B
// (an upgrade target, never a deletion signal on its own).
export function ceiling(r) {
  const live = r.cases.filter((c) => !c.flags.includes('TODO') && !c.flags.includes('SKIPPED'));
  const severe = live.filter((c) => c.flags.some((f) => SEVERE.has(f)));
  const weak = live.filter((c) => c.flags.some((f) => SEVERE.has(f) || WEAKCLAIM.has(f)));
  const skipped = r.cases.length - live.length;
  const reasons = [];
  let g = 'A';
  const cap = (x, why) => { if (x > g) g = x; reasons.push(why); };
  if (r.cases.length === 0) cap('F', 'no test cases');
  else if (live.length === 0) cap('F', 'every case skipped/todo');
  else if (live.every((c) => c.flags.includes('NO_ASSERT'))) cap('F', 'no case asserts anything');
  else if (severe.length === live.length) cap('D', 'every live case has a can-it-fail flag');
  else if (severe.length / live.length >= 0.3) cap('C', `${severe.length}/${live.length} cases may be unable to fail`);
  else if (weak.length === live.length) cap('C', 'every live case asserts less than a full claim');
  else if (weak.length > 0) cap('B', `${weak.length}/${live.length} cases flagged`);
  if (skipped > 0) cap('C', `${skipped} skipped/todo`);
  if (r.cases.some((c) => c.flags.includes('ONLY'))) cap('C', '.only hides the rest of the file');
  if (r.casts > 0) cap('B', `${r.casts} laundering cast(s)`);
  if (r.sleeps > 0) cap('B', `${r.sleeps} fixed sleep(s) without fake timers`);
  if (r.clockUses > 0) reasons.push(`note: ${r.clockUses} wall-clock/random read(s); check under a shifted clock`);
  if (!r.headerRef) cap('B', r.hasHeader ? 'header names no ADR/RFC/issue id' : 'no header saying why the test exists');
  return { ceiling: g, reasons };
}

export function runCensus(root, cfg, { prefixes = [], previous = null, ts: tsIn = null } = {}) {
  const opt = { ...CENSUS_DEFAULTS, ...(cfg.census ?? {}) };
  const ts = tsIn ?? loadTypeScript(root, opt.typescriptFrom);
  const testRe = new RegExp(opt.testPattern);
  const list = execFileSync('git', ['ls-files', '-s'], { cwd: root, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 }).split('\n').filter(Boolean)
    .map((l) => { const [meta, file] = l.split('\t'); return { file, blob: meta.split(' ')[1] }; })
    .filter(({ file }) => testRe.test(file) && !file.includes('node_modules/') && (!prefixes.length || prefixes.some((p) => file.startsWith(p))));
  const prev = new Map((previous?.files ?? []).map((f) => [f.file, f]));
  const results = [];
  const bodies = new Map();
  for (const { file, blob } of list) {
    const abs = join(root, file);
    if (!existsSync(abs)) continue;
    const r = censusFile(ts, file, readFileSync(abs, 'utf8'), opt);
    r.blob = blob;
    for (const c of r.cases) if (c.hash) { if (!bodies.has(c.hash)) bodies.set(c.hash, []); bodies.get(c.hash).push({ file, line: c.line }); }
    results.push(r);
  }
  for (const r of results) {
    for (const c of r.cases) {
      if (c.hash && bodies.get(c.hash).length > 1) {
        c.flags.push('DUPLICATE_BODY');
        c.duplicates = bodies.get(c.hash).filter((d) => !(d.file === r.file && d.line === c.line)).slice(0, 3);
      }
      delete c.hash;
    }
    Object.assign(r, ceiling(r));
    const p = prev.get(r.file);
    r.status = !p ? 'new' : p.blob !== r.blob ? 'changed' : 'unchanged';
    // Grades a grader recorded survive only while the file is unchanged.
    if (p && r.status === 'unchanged' && p.grade) r.grade = p.grade;
  }
  const cases = results.flatMap((r) => r.cases);
  const count = (pred) => cases.filter(pred).length;
  const summary = {
    files: results.length, cases: cases.length,
    flags: Object.fromEntries(['NO_ASSERT', 'CONDITIONAL', 'WEAK_ONLY', 'STATUS_ONLY', 'MOCK_ONLY', 'SNAPSHOT_ONLY', 'DUPLICATE_BODY', 'SKIPPED', 'TODO', 'ONLY'].map((f) => [f, count((c) => c.flags.includes(f))])),
    ceilings: Object.fromEntries(['A', 'B', 'C', 'D', 'F'].map((g) => [g, results.filter((r) => r.ceiling === g).length])),
    changed: results.filter((r) => r.status !== 'unchanged').length,
  };
  return {
    summary,
    // Ledger: what a grader acts on. Flagged cases only, plus each file's blob for re-queueing.
    files: results.map((r) => ({
      file: r.file, blob: r.blob, status: r.status, ceiling: r.ceiling, reasons: r.reasons,
      cases: r.cases.length, ...(r.grade ? { grade: r.grade } : {}),
      flagged: r.cases.filter((c) => c.flags.length).map((c) => ({ line: c.line, title: c.title, flags: c.flags, ...(c.duplicates ? { duplicates: c.duplicates } : {}) })),
    })),
  };
}

export function renderCensus(r) {
  const s = r.summary;
  const lines = ['# Test census', '', `${s.files} files · ${s.cases} cases · ${s.changed} new or changed`, '',
    '| Ceiling | Files |', '|---|---:|', ...Object.entries(s.ceilings).map(([g, n]) => `| ${g} | ${n} |`), '',
    '| Flag | Cases |', '|---|---:|', ...Object.entries(s.flags).map(([f, n]) => `| ${f} | ${n} |`), '',
    'A ceiling is the best grade the census allows, never a grade. D/F files go to sabotage probes first; reading alone never deletes.', '',
    '| File | Ceiling | Status | Why |', '|---|---|---|---|'];
  for (const f of [...r.files].sort((a, b) => b.ceiling.localeCompare(a.ceiling) || a.file.localeCompare(b.file))) {
    if (f.ceiling === 'A' && f.status === 'unchanged') continue;
    lines.push(`| \`${f.file}\` | ${f.ceiling} | ${f.status} | ${f.reasons.join('; ') || '—'} |`);
  }
  return lines.join('\n') + '\n';
}
