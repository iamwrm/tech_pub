#!/usr/bin/env node
// Colored, zebra-striped terminal renderer for show_usd_per_mtok.sh.
//
// stdin: sorted TSV rows  period, model, total_tokens, usd, cache_read, prompt_tokens, input_price
// env:   USD_MTOK_THEME = auto | light | dark   (default auto)
//
// Theme auto-detection asks the terminal for its background color (OSC 11, with a
// DA1 query as a sentinel so unsupported terminals answer immediately), then falls
// back to COLORFGBG, then to the macOS appearance setting, then to dark. Zebra
// stripes are tinted from the detected background so they stay subtle.
import { openSync, readFileSync, writeSync } from 'node:fs';
import { ReadStream } from 'node:tty';
import { execFileSync } from 'node:child_process';

const ESC = '\x1b[';

// ---------- color ----------
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const luminance = ([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

const TRUECOLOR = /truecolor|24bit/i.test(process.env.COLORTERM ?? '');
function to256([r, g, b]) {
  const lvl = [0, 95, 135, 175, 215, 255];
  const near = (v) => lvl.reduce((bi, x, i) => (Math.abs(x - v) < Math.abs(lvl[bi] - v) ? i : bi), 0);
  const [cr, cg, cb] = [near(r), near(g), near(b)];
  const cube = [lvl[cr], lvl[cg], lvl[cb]];
  const gi = Math.max(0, Math.min(23, Math.round(((r + g + b) / 3 - 8) / 10)));
  const gray = [8 + gi * 10, 8 + gi * 10, 8 + gi * 10];
  const d = (c) => (c[0] - r) ** 2 + (c[1] - g) ** 2 + (c[2] - b) ** 2;
  return d(gray) < d(cube) ? 232 + gi : 16 + 36 * cr + 6 * cg + cb;
}
const fgc = (c) => (TRUECOLOR ? `${ESC}38;2;${c.join(';')}m` : `${ESC}38;5;${to256(c)}m`);
const bgc = (c) => (TRUECOLOR ? `${ESC}48;2;${c.join(';')}m` : `${ESC}48;5;${to256(c)}m`);

function palette(mode, detectedBg) {
  const dark = mode === 'dark';
  const bg = detectedBg ?? hex(dark ? '#1e1f24' : '#ffffff');
  const ink = hex(dark ? '#e6e8ee' : '#1f2328');
  const accent = hex(dark ? '#7aa2f7' : '#2f5fd0');
  return {
    bg,
    fg: ink,
    zebra: mix(bg, ink, dark ? 0.07 : 0.055),
    head: mix(bg, accent, dark ? 0.32 : 0.16),
    total: mix(bg, accent, dark ? 0.18 : 0.09),
    accent,
    dim: mix(bg, ink, 0.5),
    faint: mix(bg, ink, 0.3),
    good: hex(dark ? '#9ece6a' : '#1a7f37'),
    warn: hex(dark ? '#e0af68' : '#9a6700'),
    bad: hex(dark ? '#f7768e' : '#cf222e'),
  };
}

// ---------- theme detection ----------
function parseOsc11(buf) {
  const m = buf.match(/\]11;rgba?:([0-9a-f]+)\/([0-9a-f]+)\/([0-9a-f]+)/i);
  if (!m) return null;
  return m.slice(1, 4).map((h) => Math.round((parseInt(h, 16) / (16 ** h.length - 1)) * 255));
}

function queryTerminalBg(timeoutMs = 400) {
  let fd;
  try { fd = openSync('/dev/tty', 'r+'); } catch { return Promise.resolve(null); }
  let input;
  try { input = new ReadStream(fd); input.setRawMode(true); } catch { return Promise.resolve(null); }
  return new Promise((resolve) => {
    let buf = '';
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { input.setRawMode(false); } catch {}
      input.destroy();
      resolve(parseOsc11(buf));
    };
    const timer = setTimeout(done, timeoutMs);
    input.on('data', (d) => { buf += d.toString('latin1'); if (/\x1b\[\?[\d;]*c/.test(buf)) done(); });
    input.on('error', done);
    try { writeSync(fd, '\x1b]11;?\x07\x1b[c'); } catch { done(); }
  });
}

async function detectTheme() {
  const forced = (process.env.USD_MTOK_THEME ?? 'auto').toLowerCase();
  if (forced === 'light' || forced === 'dark') return { mode: forced, bg: null, source: 'USD_MTOK_THEME' };
  const bg = await queryTerminalBg();
  if (bg) return { mode: luminance(bg) > 0.5 ? 'light' : 'dark', bg, source: 'terminal' };
  const fgbg = process.env.COLORFGBG?.split(';').pop();
  if (fgbg && /^\d+$/.test(fgbg)) return { mode: [7, 15].includes(+fgbg) ? 'light' : 'dark', bg: null, source: 'COLORFGBG' };
  if (process.platform === 'darwin') {
    try {
      execFileSync('defaults', ['read', '-g', 'AppleInterfaceStyle'], { stdio: 'pipe' });
      return { mode: 'dark', bg: null, source: 'macOS' };
    } catch { return { mode: 'light', bg: null, source: 'macOS' }; }
  }
  return { mode: 'dark', bg: null, source: 'default' };
}

// ---------- text helpers ----------
const ANSI = /\x1b\[[0-9;]*m/g;
const width = (s) => [...s.replace(ANSI, '')].length;
const padR = (s, w) => s + ' '.repeat(Math.max(0, w - width(s)));
const padL = (s, w) => ' '.repeat(Math.max(0, w - width(s))) + s;
const fit = (s, w) => ([...s].length <= w ? s : [...s].slice(0, Math.max(1, w - 1)).join('') + '…');
const commas = (n) => Math.round(n).toLocaleString('en-US');
const pct = (x) => `${(x * 100).toFixed(1)}%`;

// ---------- data ----------
function load() {
  const rows = readFileSync(0, 'utf8').split('\n').filter(Boolean).map((line) => {
    const [period, model, t, u, c, q, price] = line.split('\t');
    const tokens = +t, usd = +u, read = +c, prompt = +q;
    const list = /^[0-9.]+$/.test(price ?? '') && +price > 0 ? +price : null;
    const rate = tokens ? (usd / tokens) * 1e6 : 0;
    const agent = model.startsWith('[') ? model.slice(1, model.indexOf(']')) : null; // Claude Code rows are unprefixed
    const bare = model.startsWith('[') ? model.slice(model.indexOf(']') + 2) : model;
    return { period, model, agent, bare, tokens, usd, read, prompt, hit: prompt ? read / prompt : 0, rate, list, ratio: list ? rate / list : null };
  });
  const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
  const total = { tokens: sum('tokens'), usd: sum('usd'), read: sum('read'), prompt: sum('prompt') };
  total.hit = total.prompt ? total.read / total.prompt : 0;
  total.rate = total.tokens ? (total.usd / total.tokens) * 1e6 : 0;
  return { rows, total };
}

// ---------- shared painters ----------
function painters(P) {
  const paint = (c, s, bold = false) => (bold ? `${ESC}1m` : '') + fgc(c) + s + `${ESC}39m` + (bold ? `${ESC}22m` : '');
  const hitColor = (h) => (h >= 0.9 ? P.good : h >= 0.75 ? P.warn : P.bad);
  const ratioColor = (r) => (r == null ? P.faint : r <= 0.2 ? P.good : r <= 0.5 ? P.warn : P.bad);
  // A full-width line on an optional background; inner cells only change fg/bold.
  const line = (s, W, bg) => (bg ? bgc(bg) : '') + fgc(P.fg) + padR(` ${s}`, W) + `${ESC}0m`;
  return { paint, hitColor, ratioColor, line };
}

const range = (rows) => (rows[0].period === rows.at(-1).period ? rows[0].period : `${rows[0].period} → ${rows.at(-1).period}`);

// ---------- ledger ----------
function ledger({ rows, total }, P, W) {
  const { paint, hitColor, ratioColor, line } = painters(P);
  const pw = Math.max(6, ...rows.map((r) => width(r.period)));
  const fixed = 2 + pw + 2 + 13 + 10 + 8 + 9 + 9 + 8 + 2;
  const mw = Math.max(12, Math.min(Math.max(...rows.map((r) => width(r.model))), W - fixed));
  const tw = Math.min(W, fixed + mw);
  const cols = (p, m, t, u, h, r, l, x) => `${padR(p, pw)}  ${padR(m, mw)} ${padL(t, 13)}${padL(u, 10)}${padL(h, 8)}${padL(r, 9)}${padL(l, 9)}${padL(x, 8)}`;
  // $/MTOK heat: log-scaled across the report's rows, cheapest green -> priciest red.
  const logs = rows.filter((r) => r.rate > 0).map((r) => Math.log(r.rate));
  const lo = Math.min(...logs), hi = Math.max(...logs);
  const rateColor = (rate) => {
    if (!(rate > 0) || !(hi > lo)) return P.fg;
    const t = (Math.log(rate) - lo) / (hi - lo);
    return t < 0.5 ? mix(P.good, P.warn, t * 2) : mix(P.warn, P.bad, (t - 0.5) * 2);
  };
  const out = [];
  out.push(` ${paint(P.accent, '◆', true)} ${paint(P.fg, 'USD per MTok', true)}  ${paint(P.dim, range(rows))}`);
  out.push('');
  out.push(line(paint(P.fg, cols('PERIOD', 'MODEL', 'TOKENS', 'USD', 'HIT', '$/MTOK', 'LIST', 'RATIO'), true), tw, P.head));
  rows.forEach((r, i) => {
    const first = i === 0 || rows[i - 1].period !== r.period;
    const name = r.agent == null ? fit(r.model, mw) : paint(P.dim, `[${r.agent}] `) + fit(r.bare, mw - r.agent.length - 3);
    out.push(line(cols(
      first ? r.period : '',
      name,
      commas(r.tokens),
      r.usd.toFixed(4),
      paint(hitColor(r.hit), pct(r.hit)),
      paint(rateColor(r.rate), r.rate.toFixed(4)),
      r.list == null ? paint(P.faint, '—') : r.list.toFixed(4),
      r.ratio == null ? paint(P.faint, '—') : paint(ratioColor(r.ratio), r.ratio.toFixed(4)),
    ), tw, i % 2 ? P.zebra : null));
  });
  out.push(line(paint(P.accent, cols('TOTAL', `${rows.length} rows`, commas(total.tokens), total.usd.toFixed(4), pct(total.hit), total.rate.toFixed(4), '', ''), true), tw, P.total));
  out.push('');
  out.push(paint(P.dim, ' HIT = cache_read/(input+cache_create+cache_read) · $/MTOK = USD/tokens (blended) · LIST = catalog uncached input · RATIO = $/MTOK ÷ LIST · $/MTOK shaded cheapest→priciest'));
  return out;
}

// ---------- main ----------
const data = load();
if (!data.rows.length) { process.stderr.write('no per-model rows\n'); process.exit(1); }
const theme = await detectTheme();
const P = palette(theme.mode, theme.bg);
const W = process.stdout.columns || +process.env.COLUMNS || 160;
process.stdout.write(ledger(data, P, W).join('\n') + '\n');
