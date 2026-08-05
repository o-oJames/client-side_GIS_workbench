// ---------------------------------------------------------------------------
// Attribute query expressions for vector layers.
//
// Users filter a layer's features with a small SQL-flavoured expression, e.g.
//
//   "capture_date" > '2024-01-01'
//   "published" is true
//   "name" like '%park%' and ("type" in ('trail', 'reserve') or "area" >= 10)
//
// Grammar (case-insensitive keywords):
//
//   orExpr    := andExpr ( OR andExpr )*
//   andExpr   := notExpr ( AND notExpr )*
//   notExpr   := NOT notExpr | '(' orExpr ')' | predicate
//   predicate := operand [ cmpOp operand
//                        | IS [NOT] (TRUE | FALSE | NULL)
//                        | [NOT] LIKE string
//                        | [NOT] IN '(' literal (',' literal)* ')' ]
//   operand   := identifier | string | number | TRUE | FALSE | NULL
//
// Identifiers may be bare words (capture_date) or quoted ("capture date").
// Single quotes delimit string literals; typographic quotes are normalised so
// expressions pasted from documents just work. Comparisons are numeric when
// both sides are numbers, temporal when both sides look like dates, and
// string-based otherwise - so "capture_date" > '2024-01-01' does a real date
// comparison while "name" > 'A' compares alphabetically.
// ---------------------------------------------------------------------------

export interface CompiledFeatureFilter {
  /** The original (trimmed) expression. */
  source: string;
  /** Returns true when a feature's attribute table satisfies the query. */
  predicate: (props: Record<string, any>) => boolean;
}

export type FeatureFilterCheck =
  | { ok: true }
  | { ok: false; error: string };

// ----- value helpers --------------------------------------------------------

type Literal = string | number | boolean | null;

interface Operand { attr?: string; literal?: Literal; isLiteral: boolean; }

type AstNode =
  | { kind: 'or' | 'and'; left: AstNode; right: AstNode }
  | { kind: 'not'; operand: AstNode }
  | { kind: 'cmp'; op: string; left: Operand; right: Operand }
  | { kind: 'is'; negated: boolean; test: 'true' | 'false' | 'null'; operand: Operand }
  | { kind: 'like'; negated: boolean; operand: Operand; pattern: string }
  | { kind: 'in'; negated: boolean; operand: Operand; list: Literal[] }
  | { kind: 'truthy'; operand: Operand };

const isMissing = (v: any) => v === undefined || v === null;

/** True when the value is (or stringifies to) a finite number. */
function asNumber(v: any): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return null;
  if (typeof v === 'string') {
    const s = v.trim();
    if (s === '') return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

const ISO_DATE = /^\d{4}-\d{1,2}-\d{1,2}([T ]\d{1,2}:\d{2}(:\d{2}(\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?)?$/;
const SLASH_DATE = /^\d{4}\/\d{1,2}\/\d{1,2}([ T]\d{1,2}:\d{2}(:\d{2}(\.\d+)?)?)?$/;

/** Epoch millis when the value looks like a calendar date, else null. */
function asDateMs(v: any): number | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!ISO_DATE.test(s) && !SLASH_DATE.test(s)) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

function coerceBool(v: any): boolean | null {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v === 1 ? true : v === 0 ? false : null;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true' || s === 'yes') return true;
    if (s === 'false' || s === 'no') return false;
  }
  return null;
}

function looseEquals(a: any, b: any): boolean {
  if (isMissing(a) && isMissing(b)) return true;
  if (isMissing(a) || isMissing(b)) return false;
  const ba = coerceBool(a);
  const bb = coerceBool(b);
  if (ba !== null && bb !== null) return ba === bb;
  const na = asNumber(a);
  const nb = asNumber(b);
  if (na !== null && nb !== null) return na === nb;
  const da = asDateMs(a);
  const db = asDateMs(b);
  if (da !== null && db !== null) return da === db;
  return String(a) === String(b);
}

/** Ordered comparison; null when the pair is not orderable. */
function orderedCompare(a: any, b: any): number | null {
  if (isMissing(a) || isMissing(b)) return null;
  const na = asNumber(a);
  const nb = asNumber(b);
  if (na !== null && nb !== null) return na - nb;
  const da = asDateMs(a);
  const db = asDateMs(b);
  if (da !== null && db !== null) return da - db;
  if (typeof a === 'string' || typeof b === 'string') {
    const sa = String(a);
    const sb = String(b);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  }
  return null;
}

function isTruthy(v: any): boolean {
  if (isMissing(v)) return false;
  const b = coerceBool(v);
  if (b !== null) return b;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v.trim() !== '';
  return true;
}

/** Compile a SQL-style LIKE pattern (% = any run, _ = one char) to a RegExp. */
function likeToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('^' + escaped.replace(/%/g, '[\\s\\S]*').replace(/_/g, '[\\s\\S]') + '$', 'i');
}

// ----- attribute lookup -----------------------------------------------------

/**
 * Read an attribute from a feature's property table. Tries the exact name
 * first, then a case-insensitive match, so "Capture_Date" finds capture_date.
 */
export function lookupAttribute(props: Record<string, any>, name: string): any {
  if (!props || typeof props !== 'object') return undefined;
  if (Object.prototype.hasOwnProperty.call(props, name)) return props[name];
  const lower = name.toLowerCase();
  for (const key of Object.keys(props)) {
    if (key.toLowerCase() === lower) return props[key];
  }
  return undefined;
}

/**
 * Extract the plain attribute table of an OpenLayers feature (or pass a plain
 * object through). The geometry property is dropped so it can never leak into
 * comparisons.
 */
export function featureProperties(feature: any): Record<string, any> {
  if (!feature) return {};
  if (typeof feature.getProperties !== 'function') return feature;
  const props: Record<string, any> = { ...feature.getProperties() };
  const geomName = typeof feature.getGeometryName === 'function' ? feature.getGeometryName() : 'geometry';
  if (geomName) delete props[geomName];
  return props;
}

// ----- tokenizer ------------------------------------------------------------

interface Token {
  type: 'lparen' | 'rparen' | 'comma' | 'op' | 'string' | 'number' | 'ident' | 'kw' | 'eof';
  value: string;
  pos: number;
}

const KEYWORDS = new Set(['and', 'or', 'not', 'is', 'like', 'in', 'true', 'false', 'null']);

/** Straighten typographic quotes so pasted expressions tokenize correctly. */
function normalizeQuotes(input: string): string {
  return input
    .replace(/[\u2018\u2019\u02BC]/g, "'")
    .replace(/[\u201C\u201D]/g, '"');
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = input.length;

  while (i < n) {
    const c = input[i];
    if (/\s/.test(c)) { i++; continue; }

    if (c === '(') { tokens.push({ type: 'lparen', value: c, pos: i }); i++; continue; }
    if (c === ')') { tokens.push({ type: 'rparen', value: c, pos: i }); i++; continue; }
    if (c === ',') { tokens.push({ type: 'comma', value: c, pos: i }); i++; continue; }

    // Comparison operators (two-char forms first).
    const two = input.slice(i, i + 2);
    if (two === '<=' || two === '>=' || two === '!=' || two === '<>' || two === '==') {
      tokens.push({ type: 'op', value: two === '==' ? '=' : two === '<>' ? '!=' : two, pos: i });
      i += 2;
      continue;
    }
    if (c === '<' || c === '>' || c === '=') {
      tokens.push({ type: 'op', value: c === '=' ? '=' : c, pos: i });
      i++;
      continue;
    }

    // String literals use 'single' quotes. "Double" quotes delimit field
    // names (SQL-style identifiers), so they are emitted as `ident` tokens -
    // the UI hint makes the convention explicit.
    if (c === "'" || c === '"') {
      const quote = c;
      let j = i + 1;
      let out = '';
      let closed = false;
      while (j < n) {
        const ch = input[j];
        if (ch === '\\' && j + 1 < n) { out += input[j + 1]; j += 2; continue; }
        if (ch === quote) { closed = true; j++; break; }
        out += ch;
        j++;
      }
      if (!closed) {
        throw new Error(`Unterminated string starting at position ${i + 1} — add the closing ${quote} quote.`);
      }
      tokens.push({ type: quote === "'" ? 'string' : 'ident', value: out, pos: i });
      i = j;
      continue;
    }

    // Number (integers and decimals, optional sign handled by the parser).
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(input[i + 1] || ''))) {
      let j = i;
      while (j < n && /[0-9._eE+-]/.test(input[j])) {
        // Stop the sign from swallowing a following operator: only allow +/-
        // directly after an exponent character.
        const ch = input[j];
        if ((ch === '+' || ch === '-') && j > i && !/[eE]/.test(input[j - 1])) break;
        j++;
      }
      const raw = input.slice(i, j);
      const num = Number(raw);
      if (Number.isFinite(num)) {
        tokens.push({ type: 'number', value: raw, pos: i });
        i = j;
        continue;
      }
      throw new Error(`"${raw}" is not a valid number (position ${i + 1}).`);
    }

    // Bare word: identifier or keyword.
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_.]/.test(input[j])) j++;
      const word = input.slice(i, j);
      const lower = word.toLowerCase();
      if (KEYWORDS.has(lower)) {
        tokens.push({ type: 'kw', value: lower, pos: i });
      } else {
        tokens.push({ type: 'ident', value: word, pos: i });
      }
      i = j;
      continue;
    }

    throw new Error(`Unexpected character "${c}" at position ${i + 1}.`);
  }

  tokens.push({ type: 'eof', value: '', pos: n });
  return tokens;
}

// ----- parser ---------------------------------------------------------------

class Parser {
  private tokens: Token[];
  private idx = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.idx + offset, this.tokens.length - 1)];
  }

  private next(): Token {
    return this.tokens[this.idx++];
  }

  private describe(t: Token): string {
    if (t.type === 'eof') return 'end of expression';
    return `"${t.value}"`;
  }

  parse(): AstNode {
    const node = this.parseOr();
    const t = this.peek();
    if (t.type !== 'eof') {
      throw new Error(`Unexpected ${this.describe(t)} — expected AND, OR, or the end of the expression.`);
    }
    return node;
  }

  private parseOr(): AstNode {
    let left = this.parseAnd();
    while (this.peek().type === 'kw' && this.peek().value === 'or') {
      this.next();
      const right = this.parseAnd();
      left = { kind: 'or', left, right };
    }
    return left;
  }

  private parseAnd(): AstNode {
    let left = this.parseNot();
    while (this.peek().type === 'kw' && this.peek().value === 'and') {
      this.next();
      const right = this.parseNot();
      left = { kind: 'and', left, right };
    }
    return left;
  }

  private parseNot(): AstNode {
    const t = this.peek();
    if (t.type === 'kw' && t.value === 'not') {
      this.next();
      return { kind: 'not', operand: this.parseNot() };
    }
    if (t.type === 'lparen') {
      this.next();
      const inner = this.parseOr();
      const close = this.next();
      if (close.type !== 'rparen') {
        throw new Error(`Missing closing ")" — found ${this.describe(close)}.`);
      }
      return inner;
    }
    return this.parsePredicate();
  }

  private parsePredicate(): AstNode {
    const left = this.parseOperand();

    const t = this.peek();
    if (t.type === 'op') {
      this.next();
      const right = this.parseOperand();
      return { kind: 'cmp', op: t.value, left, right };
    }

    if (t.type === 'kw' && t.value === 'is') {
      this.next();
      let negated = false;
      if (this.peek().type === 'kw' && this.peek().value === 'not') {
        negated = true;
        this.next();
      }
      const testTok = this.next();
      if (testTok.type === 'kw' && (testTok.value === 'true' || testTok.value === 'false' || testTok.value === 'null')) {
        return { kind: 'is', negated, test: testTok.value as 'true' | 'false' | 'null', operand: left };
      }
      throw new Error(`Expected TRUE, FALSE, or NULL after IS — found ${this.describe(testTok)}.`);
    }

    let negated = false;
    let kwTok = t;
    if (t.type === 'kw' && t.value === 'not') {
      const after = this.peek(1);
      if (after.type === 'kw' && (after.value === 'like' || after.value === 'in')) {
        negated = true;
        this.next();
        kwTok = this.peek();
      }
    }

    if (kwTok.type === 'kw' && kwTok.value === 'like') {
      this.next();
      const pat = this.next();
      if (pat.type !== 'string') {
        throw new Error(`LIKE needs a single-quoted pattern string — e.g. "name" LIKE '%park%'.`);
      }
      return { kind: 'like', negated, operand: left, pattern: pat.value };
    }

    if (kwTok.type === 'kw' && kwTok.value === 'in') {
      this.next();
      const open = this.next();
      if (open.type !== 'lparen') {
        throw new Error(`Expected "(" after IN — e.g. "type" IN ('a', 'b').`);
      }
      const list: Literal[] = [];
      if (this.peek().type !== 'rparen') {
        for (;;) {
          list.push(this.parseLiteral());
          const sep = this.next();
          if (sep.type === 'rparen') break;
          if (sep.type !== 'comma') {
            throw new Error(`Expected "," or ")" inside the IN list — found ${this.describe(sep)}.`);
          }
        }
      } else {
        this.next();
      }
      return { kind: 'in', negated, operand: left, list };
    }

    // Bare operand: truthiness test, e.g. "published".
    return { kind: 'truthy', operand: left };
  }

  private parseOperand(): Operand {
    const t = this.next();
    switch (t.type) {
      case 'ident':
        return { attr: t.value, isLiteral: false };
      case 'string':
        return { literal: t.value, isLiteral: true };
      case 'number':
        return { literal: Number(t.value), isLiteral: true };
      case 'kw':
        if (t.value === 'true') return { literal: true, isLiteral: true };
        if (t.value === 'false') return { literal: false, isLiteral: true };
        if (t.value === 'null') return { literal: null, isLiteral: true };
        throw new Error(`Unexpected keyword "${t.value.toUpperCase()}" — expected a field name or value.`);
      case 'eof':
        throw new Error('Expression ends unexpectedly — expected a field name or value.');
      default:
        throw new Error(`Unexpected ${this.describe(t)} — expected a field name or value.`);
    }
  }

  private parseLiteral(): Literal {
    const op = this.parseOperand();
    if (!op.isLiteral) {
      throw new Error(`Expected a value inside the IN list — "${op.attr}" is a field name.`);
    }
    return op.literal as Literal;
  }
}

// ----- evaluation -----------------------------------------------------------

function resolveOperand(op: Operand, props: Record<string, any>): any {
  return op.isLiteral ? op.literal : lookupAttribute(props, op.attr as string);
}

function evalNode(node: AstNode, props: Record<string, any>): boolean {
  switch (node.kind) {
    case 'or':
      return evalNode(node.left, props) || evalNode(node.right, props);
    case 'and':
      return evalNode(node.left, props) && evalNode(node.right, props);
    case 'not':
      return !evalNode(node.operand, props);
    case 'cmp': {
      const a = resolveOperand(node.left, props);
      const b = resolveOperand(node.right, props);
      if (node.op === '=') return looseEquals(a, b);
      if (node.op === '!=') return !looseEquals(a, b);
      const cmp = orderedCompare(a, b);
      if (cmp === null) return false;
      if (node.op === '<') return cmp < 0;
      if (node.op === '<=') return cmp <= 0;
      if (node.op === '>') return cmp > 0;
      return cmp >= 0; // '>'
    }
    case 'is': {
      const v = resolveOperand(node.operand, props);
      let result: boolean;
      if (node.test === 'null') result = isMissing(v);
      else if (node.test === 'true') result = coerceBool(v) === true;
      else result = coerceBool(v) === false;
      return node.negated ? !result : result;
    }
    case 'like': {
      const v = resolveOperand(node.operand, props);
      if (isMissing(v)) return node.negated;
      const matched = likeToRegExp(node.pattern).test(String(v));
      return node.negated ? !matched : matched;
    }
    case 'in': {
      const v = resolveOperand(node.operand, props);
      const matched = node.list.some(item => looseEquals(v, item));
      return node.negated ? !matched : matched;
    }
    case 'truthy':
      return isTruthy(resolveOperand(node.operand, props));
  }
}

// ----- public API -----------------------------------------------------------

/**
 * Compile a query expression. Throws an Error with a human-readable message
 * when the syntax is invalid.
 */
export function compileFeatureFilter(expression: string): CompiledFeatureFilter {
  const source = (expression || '').trim();
  if (!source) {
    throw new Error('The query expression is empty.');
  }
  const tokens = tokenize(normalizeQuotes(source));
  const ast = new Parser(tokens).parse();
  return { source, predicate: (props) => evalNode(ast, props || {}) };
}

/** Non-throwing syntax check for live UI feedback. */
export function checkFeatureFilter(expression: string): FeatureFilterCheck {
  try {
    compileFeatureFilter(expression);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Convenience: compile + test one feature (OL feature or plain props object). */
export function featureMatchesFilter(compiled: CompiledFeatureFilter, feature: any): boolean {
  return compiled.predicate(featureProperties(feature));
}
