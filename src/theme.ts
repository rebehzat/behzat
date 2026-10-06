import theme from '../assets/opencode-theme.json';
const color = (name: keyof typeof theme.theme) => {
  const value = theme.theme[name];
  const reference = typeof value === 'string' ? value : value.dark;
  return theme.defs[reference as keyof typeof theme.defs] ?? reference;
};
export const palette = {
  background: color('background'), panel: color('backgroundPanel'),
  text: color('text'), muted: color('textMuted'), primary: color('primary'),
  border: color('border'), success: color('success'), error: color('error'), accent: color('accent'),
};
export const rainbow = ['#ff6b6b', '#ffa94d', '#ffe066', '#69db7c', '#4dabf7', '#b197fc'];
export function cleanTerminalText(text: string) {
  return text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}
