// Small helpers for the demo scripts: timestamps, colours, and a narrator.
const useColor = process.stdout.isTTY || process.env.FORCE_COLOR;
const c = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
export const bold = c('1');
export const dim = c('2');
export const red = c('31');
export const green = c('32');
export const yellow = c('33');
export const blue = c('34');
export const magenta = c('35');
export const cyan = c('36');

const t0 = Date.now();
export const ts = () => dim(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s]`);
export const say = (...a) => console.log(ts(), ...a);
export const step = (title) => console.log(`\n${bold(yellow('▶ ' + title))}`);
export const explain = (text) => console.log(dim('  ' + text));
export const ok = (text) => console.log(`  ${green('✓')} ${text}`);
export const bad = (text) => console.log(`  ${red('✗')} ${text}`);
