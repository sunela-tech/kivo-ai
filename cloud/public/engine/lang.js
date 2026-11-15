// InkScript, the drawing language INKOS 1 and INKOS 1.1 write.
// A line-by-line port of inkos/vector/lang.py (decode side only).
// The constants are checked against data/app.json by cloud/test/engine.test.mjs.

export const GRID = 128;
export const PAD = 0, BOS = 1, EOS = 2;
export const PATH_MIN = { LINE: 2, CURVE: 2, POLY: 3, BLOB: 3, FILL: 3, FBLOB: 3 };
export const FIXED_ARGS = { CIRC: 3, DISC: 3, RECT: 4, BOX: 4, ELLI: 4 };
export const STATE_CMDS = ['W1', 'W2', 'W3', 'W4', 'INK', 'ERASE', 'SOLID', 'DASH', 'CLEAN', 'HAND'];
export const NAMES = ['<pad>', '<bos>', '<eos>', ...Object.keys(PATH_MIN), ...Object.keys(FIXED_ARGS), ...STATE_CMDS, 'TEXT', 'END'];
export const TOK = Object.fromEntries(NAMES.map((n, i) => [n, i]));
export const COORD0 = NAMES.length;
export const CHAR0 = COORD0 + GRID;
export const N_CHARS = 126 - 32 + 1;
export const VOCAB = CHAR0 + N_CHARS;          // INKOS 1
export const N_COLORS = 6;
export const COLOR0 = VOCAB;
export const VOCAB_COLOR = VOCAB + N_COLORS;   // INKOS 1.1
export const END = TOK.END, TEXT = TOK.TEXT;
export const MAX_PATH_POINTS = 96, MAX_TEXT_ITEMS = 96, TEXT_ARGS = 4;

export function charToken(c) {
  let o = c.charCodeAt(0);
  if (o < 32 || o > 126) o = 63; // '?'
  return CHAR0 + o - 32;
}
export const tokenChar = (t) => String.fromCharCode(t - CHAR0 + 32);
export const promptTokens = (prompt) => Array.from(prompt, charToken);

/** Tracks a program as it is written; allowed() masks the next token. */
export class Grammar {
  constructor(promptLen = 0, vocab = VOCAB) {
    this.P = promptLen | 0;
    this.V = vocab | 0;
    this.ops = [];
    this.mode = 'top';
    this.cmd = '';
    this.args = [];
    this.items = [];
    this.nItems = 0;
    this.spanStart = 0;
    this.done = false;
  }

  /** Uint8Array over V + P ids: 1 where the token is legal now. */
  allowed() {
    const m = new Uint8Array(this.V + this.P);
    const coords = () => m.fill(1, COORD0, CHAR0);
    switch (this.mode) {
      case 'top':
        m[EOS] = 1;
        m.fill(1, TOK.LINE, TOK.TEXT + 1);
        if (this.V > VOCAB) m.fill(1, VOCAB, this.V); // colour tokens, between commands only
        break;
      case 'path': {
        const n = this.args.length;
        if (n % 2 === 1) coords();
        else if (n / 2 >= MAX_PATH_POINTS) m[END] = 1;
        else if (n / 2 >= PATH_MIN[this.cmd]) { coords(); m[END] = 1; }
        else coords();
        break;
      }
      case 'fixed':
      case 'text_args':
        coords();
        break;
      case 'items':
        if (this.nItems >= MAX_TEXT_ITEMS) m[END] = 1;
        else { m.fill(1, CHAR0, VOCAB); m[END] = 1; m.fill(1, this.V, this.V + this.P); }
        break;
      case 'span_end':
        m.fill(1, this.V + this.spanStart, this.V + this.P);
        break;
      default:
        break;
    }
    return m;
  }

  /** Consume one token; returns false (and changes nothing) if it is illegal. */
  feed(t, mask) {
    if (this.done || t < 0 || t >= this.V + this.P || !(mask || this.allowed())[t]) return false;
    switch (this.mode) {
      case 'top': {
        if (t === EOS) { this.done = true; this.mode = 'done'; return true; }
        if (t >= COLOR0) { this.ops.push(['COLOR', t - COLOR0]); return true; }
        const name = NAMES[t];
        if (STATE_CMDS.includes(name)) this.ops.push(name[0] === 'W' ? ['W', +name[1]] : [name]);
        else if (name in PATH_MIN) { this.mode = 'path'; this.cmd = name; this.args = []; }
        else if (name in FIXED_ARGS) { this.mode = 'fixed'; this.cmd = name; this.args = []; }
        else { this.mode = 'text_args'; this.cmd = 'TEXT'; this.args = []; this.items = []; this.nItems = 0; }
        break;
      }
      case 'path':
        if (t === END) {
          const pts = [];
          for (let i = 0; i < this.args.length; i += 2) pts.push([this.args[i], this.args[i + 1]]);
          this.ops.push([this.cmd, pts]);
          this.mode = 'top';
        } else this.args.push(t - COORD0);
        break;
      case 'fixed':
        this.args.push(t - COORD0);
        if (this.args.length === FIXED_ARGS[this.cmd]) { this.ops.push([this.cmd, ...this.args]); this.mode = 'top'; }
        break;
      case 'text_args':
        this.args.push(t - COORD0);
        if (this.args.length === TEXT_ARGS) this.mode = 'items';
        break;
      case 'items':
        if (t === END) { this.ops.push(['TEXT', ...this.args, this.items]); this.mode = 'top'; }
        else if (t >= this.V) { this.spanStart = t - this.V; this.mode = 'span_end'; this.nItems += 1; }
        else {
          const c = tokenChar(t);
          const last = this.items[this.items.length - 1];
          if (typeof last === 'string') this.items[this.items.length - 1] = last + c;
          else this.items.push(c);
          this.nItems += 1;
        }
        break;
      case 'span_end':
        this.items.push([this.spanStart, t - this.V]);
        this.mode = 'items';
        break;
      default:
        return false;
    }
    return true;
  }

  get inProgress() { return this.mode !== 'top' && this.mode !== 'done'; }
}

/** Token ids -> {ops, ok}; parsing stops at EOS, PAD or the first illegal token. */
export function decode(tokens, promptLen = 0, vocab = VOCAB) {
  const g = new Grammar(promptLen, vocab);
  for (const t of tokens) {
    if (t === PAD || !g.feed(t)) break;
    if (g.done) break;
  }
  return { ops: g.ops, ok: g.done };
}

export function resolveText(items, prompt) {
  return items.map((it) => (typeof it === 'string' ? it : prompt.slice(Math.max(0, it[0]), Math.max(0, it[1]) + 1))).join('');
}

export function describe(ops) {
  const byType = {};
  for (const op of ops) byType[op[0]] = (byType[op[0]] || 0) + 1;
  return { ops: ops.length, by_type: byType };
}

/** Port of inkos/prompts.py normalize_prompt: fold a prompt into the trained character set. */
export function normalizePrompt(text, maxLen) {
  let t = (text || '').normalize('NFKD');
  t = t.replace(/‘/g, "'").replace(/’/g, "'").replace(/“/g, '"').replace(/”/g, '"')
    .replace(/–/g, '-').replace(/—/g, '-').replace(/→/g, '->');
  const lines = t.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean);
  let out = '';
  for (const ln of lines) {
    if (!out) out = ln;
    else if (';:,'.includes(out[out.length - 1])) out += ' ' + ln;
    else out += '; ' + ln;
  }
  out = Array.from(out, (c) => {
    const o = c.codePointAt(0);
    if (o >= 32 && o <= 126) return c;
    return /\p{M}/u.test(c) ? '' : '?';
  }).join('');
  out = out.replace(/\s+/g, ' ').trim();
  return out.slice(0, maxLen).trimEnd() || ' ';
}
