/**
 * Contrast audit for every foreground/ground pair the site actually paints.
 *
 *   npx --yes tsx scripts/contrast-audit.ts
 *
 * Thresholds (WCAG 2.2):
 *   text   1.4.3   >= 4.5:1
 *   large  1.4.3   >= 3:1, ONLY for text >= 24px regular or >= 18.66px bold.
 *                  Anton has one weight (400), so an Anton heading counts as
 *                  large by its rendered size alone.
 *   ui     1.4.11  >= 3:1 for anything needed to identify a control or its
 *                  state: focus rings, input and key borders.
 *
 * A contrast figure belongs to a PAIR, not to a colour: when a ground moves,
 * every pair on it must be re-measured -- add the new ground here, don't reason
 * from the old number. Translucent grounds are composited over the paper they
 * actually sit on before measuring. Values mirror app/assets/css/main.css;
 * keep them in sync when a token changes.
 */

type Kind = 'text' | 'large' | 'ui'

const T = {
  paper: '#F6F6F3',
  ink: '#222222',
  label: '#555555',
  faint: '#8C8C8C',
  muted: '#5A6169',
  grouped: '#EFEFEA',
  surface: '#ECECE7',
  red: '#ED1C24',
  redCta: '#C4121A',
  redOnDark: '#FF5A5F',
  cyan: '#00AEEF',
  cyanLabel: '#006E9B',
  focusRing: '#006E9B',
  white: '#FFFFFF',
  deep: '#181818',
  plate: '#181818',
  charcoal: '#1F1F1F',
  labelDeep: '#A3A3A3',
  mutedOnDark: '#A8AEB5',
  beam: '#225DAC',
  // Campaign fields (homepage sections, chapter panels, stalls).
  yellow: '#FFE86C',
  blue: '#2B19D9',
  onBlueLabel: '#D8D4FF',
}

function rgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [0, 2, 4].map(i => Number.parseInt(h.slice(i, i + 2), 16)) as [number, number, number]
}

function over(fg: string, alpha: number, ground: string): string {
  const a = rgb(fg)
  const b = rgb(ground)
  return '#' + a.map((c, i) => Math.round(c * alpha + b[i] * (1 - alpha)).toString(16).padStart(2, '0')).join('')
}

function lum(hex: string) {
  const [r, g, b] = rgb(hex).map((c) => {
    const s = c / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function ratio(a: string, b: string) {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

const cyanTint = (a: number) => over(T.cyan, a, T.paper)
const inkTint = (a: number) => over('#222222', a, T.paper)

const PAIRS: [Kind, string, string, string, string][] = [
  // kind, label, foreground, ground label, ground
  ['text', 'ink body', T.ink, 'paper', T.paper],
  ['text', 'ink body', T.ink, 'grouped', T.grouped],
  ['text', 'ink body', T.ink, 'surface', T.surface],
  ['text', 'ink body', T.ink, 'cyan tint 8%', cyanTint(0.08)],
  ['text', 'ink body', T.ink, 'ink tint 6%', inkTint(0.06)],
  ['text', 'ink body', T.ink, '#FAFAFA panel', '#FAFAFA'],
  ['text', 'label (secondary)', T.label, 'paper', T.paper],
  ['text', 'label (secondary)', T.label, 'grouped', T.grouped],
  ['text', 'label (secondary)', T.label, 'surface', T.surface],
  ['text', 'label (secondary)', T.label, 'cyan tint 8%', cyanTint(0.08)],
  ['text', 'label (secondary)', T.label, 'ink tint 6%', inkTint(0.06)],
  ['text', 'muted', T.muted, 'paper', T.paper],
  ['text', 'red CTA small text', T.redCta, 'paper', T.paper],
  ['text', 'red CTA small text', T.redCta, 'cyan tint 8%', cyanTint(0.08)],
  ['text', 'cyan label', T.cyanLabel, 'paper', T.paper],
  ['text', 'cyan label', T.cyanLabel, 'cyan tint 8%', cyanTint(0.08)],
  ['text', 'cyan label', T.cyanLabel, 'grouped', T.grouped],
  ['text', 'cyan label', T.cyanLabel, 'ink tint 6%', inkTint(0.06)],
  ['text', 'beam blue link/label', T.beam, 'paper', T.paper],
  ['text', 'white on red key', T.white, 'red CTA', T.redCta],
  ['text', 'white on ink key', T.white, 'ink', T.ink],
  ['text', 'on-deep', T.white, 'deep', T.deep],
  ['text', 'label on deep', T.labelDeep, 'deep', T.deep],
  ['text', 'cyan readout', T.cyan, 'plate', T.plate],
  ['text', 'muted on charcoal', T.mutedOnDark, 'charcoal', T.charcoal],
  ['text', 'red on dark', T.redOnDark, 'charcoal', T.charcoal],
  ['large', 'red display (>=24px)', T.red, 'paper', T.paper],
  ['large', 'faint display (>=24px)', T.faint, 'paper', T.paper],
  ['ui', 'focus ring (light grounds)', T.focusRing, 'paper', T.paper],
  ['ui', 'focus ring (light grounds)', T.focusRing, 'grouped', T.grouped],
  ['ui', 'focus ring (dark grounds)', T.cyan, 'deep', T.deep],
  ['ui', 'focus ring (dark grounds)', T.cyan, 'charcoal', T.charcoal],
  ['ui', 'key / input border (ink)', T.ink, 'paper', T.paper],
  ['ui', 'red key cap', T.redCta, 'paper', T.paper],
  // Form sheets (form-sheet.css, SheetBar.vue)
  ['ui', 'choice control (ink) on selected tint', T.ink, 'cyan tint 8%', cyanTint(0.08)],
  ['ui', 'checkbox tick (paper) on ink box', T.paper, 'ink', T.ink],
  ['ui', 'focus ring on selected choice', T.focusRing, 'cyan tint 8%', cyanTint(0.08)],
  ['ui', 'sheet bar current-page bar', T.cyanLabel, 'paper', T.paper],
  ['text', 'placeholder (label)', T.label, 'paper', T.paper],
  // Campaign fields.
  ['text', 'blue on yellow (lede, links, hint)', T.blue, 'yellow', T.yellow],
  ['text', 'ink on yellow (copy)', T.ink, 'yellow', T.yellow],
  ['text', 'label on yellow (credit)', T.label, 'yellow', T.yellow],
  ['text', 'white on red CTA key', T.white, 'red CTA', T.redCta],
  ['ui', 'red CTA key on yellow', T.redCta, 'yellow', T.yellow],
  ['text', 'white on blue (copy)', T.white, 'blue', T.blue],
  ['text', 'label on blue', T.onBlueLabel, 'blue', T.blue],
  ['text', 'yellow on blue (display, facts)', T.yellow, 'blue', T.blue],
  ['text', 'blue on paper (ledes, stall icons)', T.blue, 'paper', T.paper],
  ['text', 'white on ink (stall, footer)', T.white, 'ink', T.ink],
  ['text', 'yellow on ink (stall icon, footer titles)', T.yellow, 'ink', T.ink],
  ['text', 'label on ink (When facts, footer)', T.onBlueLabel, 'ink', T.ink],
  ['ui', 'focus ring on blue/ink (yellow)', T.yellow, 'blue', T.blue],
  ['ui', 'focus ring on yellow', T.focusRing, 'yellow', T.yellow],
]

const MIN: Record<Kind, number> = { text: 4.5, large: 3, ui: 3 }
let failed = 0
const rows = PAIRS.map(([kind, name, fg, groundName, ground]) => {
  const r = ratio(fg, ground)
  const ok = r >= MIN[kind]
  if (!ok) failed++
  return `${ok ? 'PASS' : 'FAIL'}  ${kind.padEnd(5)}  ${r.toFixed(2).padStart(5)}:1  ${name} ${fg} on ${groundName} ${ground}`
})
console.log(rows.join('\n'))

// Cyan as TEXT on a light ground must never appear; prove the rule still holds.
const cyanOnPaper = ratio(T.cyan, T.paper)
console.log(`INFO  cyan #00AEEF on paper is ${cyanOnPaper.toFixed(2)}:1 -- structural only on light grounds, never text or a focus ring.`)

if (failed) {
  console.error(`\n${failed} failed`)
  process.exit(1)
}
console.log('\nAll contrast pairs pass')
