/**
 * Stage colours. The five brand values are read from the CSS custom properties
 * in main.css, so tokens stay the single source; the rest are material tones
 * that only exist in the drawings.
 *
 * Neutral structure first. Colour marks a role, never decoration:
 * red = drive input (motors, wheels, operating ropes), cyan = the selected
 * part, beam blue = the one accent a figure may carry.
 */
export interface Palette {
  paper: string
  ink: string
  red: string
  cyan: string
  accent: string
  light: string
  mid: string
  dark: string
  wood: string
  woodDark: string
  stone: string
  metal: string
  water: string
  leaf: string
}

const FALLBACK = {
  paper: '#F6F6F3',
  ink: '#222222',
  red: '#ED1C24',
  cyan: '#00AEEF',
  accent: '#225DAC',
}

export function readPalette(): Palette {
  const css = typeof document === 'undefined' ? null : getComputedStyle(document.documentElement)
  const read = (name: string, fallback: string) => css?.getPropertyValue(name).trim() || fallback
  return {
    paper: read('--pn-enamel', FALLBACK.paper),
    ink: read('--pn-ink', FALLBACK.ink),
    red: read('--color-red', FALLBACK.red),
    cyan: read('--color-cyan', FALLBACK.cyan),
    accent: read('--beam-accent', FALLBACK.accent),
    light: '#FBFBF9',
    mid: '#C9C9C2',
    dark: '#2B2B2B',
    wood: '#D9C4A1',
    woodDark: '#A88B63',
    stone: '#9C9A92',
    metal: '#C4C8CC',
    water: '#DCE6EC',
    leaf: '#8FA77E',
  }
}
