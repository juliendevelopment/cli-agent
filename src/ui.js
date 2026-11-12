const esc = '\x1b[';

const colors = {
  reset: `${esc}0m`,
  bold: `${esc}1m`,
  dim: `${esc}2m`,
  italic: `${esc}3m`,
  underline: `${esc}4m`,

  // Foreground colors
  black: `${esc}30m`,
  red: `${esc}31m`,
  green: `${esc}32m`,
  yellow: `${esc}33m`,
  blue: `${esc}34m`,
  magenta: `${esc}35m`,
  cyan: `${esc}36m`,
  white: `${esc}37m`,

  // Bright / 256 colors
  brightBlue: `${esc}94m`,
  brightCyan: `${esc}96m`,
  brightGreen: `${esc}92m`,
  brightYellow: `${esc}93m`,
  brightMagenta: `${esc}95m`,
  gray: `${esc}90m`,

  // Background
  bgBlue: `${esc}44m`,
  bgDark: `${esc}48;5;236m`,
  bgHighlight: `${esc}48;5;238m`
};

function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

function visibleLength(str) {
  return stripAnsi(str).length;
}

function padRight(str, len) {
  const currentLen = visibleLength(str);
  if (currentLen >= len) return str;
  return str + ' '.repeat(len - currentLen);
}

function truncate(str, maxLen) {
  const plain = stripAnsi(str);
  if (plain.length <= maxLen) return str;
  if (maxLen <= 3) return plain.slice(0, maxLen);
  return plain.slice(0, maxLen - 3) + '...';
}

function drawLine(width, char = '─') {
  return char.repeat(Math.max(0, width));
}

function clearScreen() {
  process.stdout.write(`${esc}2J${esc}H`);
}

function hideCursor() {
  process.stdout.write(`${esc}?25l`);
}

function showCursor() {
  process.stdout.write(`${esc}?25h`);
}

function moveTo(row, col) {
  process.stdout.write(`${esc}${row};${col}H`);
}

/**
 * Redraw the screen without flicker: move home, overwrite each line, clear the
 * rest of every line and everything below the last one.
 */
function paint(lines) {
  const body = lines.map(line => `${line}${esc}0m${esc}K`).join('\r\n');
  process.stdout.write(`${esc}H${body}${esc}J`);
}

module.exports = {
  colors,
  stripAnsi,
  visibleLength,
  padRight,
  truncate,
  drawLine,
  clearScreen,
  hideCursor,
  showCursor,
  moveTo,
  paint
};
