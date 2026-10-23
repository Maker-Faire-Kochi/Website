<script setup lang="ts">
/**
 * The opening plot: the hero's self-balancing robot is drawn on the sheet as
 * hairlines, its faces fill in, and it rolls onto its mark -- leaning into the
 * start and back against the stop, the way the simulated balancer on the page
 * does -- blinks, and the sheet lifts off.
 *
 * CSS only and about 1.37s end to end, so it needs no JS to finish and cannot
 * strand anyone behind it. It never takes pointer events, and reduced motion
 * skips it entirely. The lift stays at 950ms: the hero entrance (1050-1800ms)
 * is timed to it -- move them together.
 *
 * Geometry: the axle is the SVG origin, so the wheel spin and the body lean
 * both rotate about 0 0 (transform-box: view-box) without any pivot maths, and
 * the roll is a CSS translate on the <svg> element itself. The wheel turns
 * ROLL / (R * SCALE) radians (the roll is in CSS px, the radius in SVG units)
 * over exactly the same duration and easing as the roll, so it never skids.
 */
const R = 16
const ROLL = 150
/** Rendered px per SVG unit: .loader-bot is 100px wide for an 80-unit viewBox. */
const SCALE = 100 / 80
const spin = `${((ROLL / (R * SCALE)) * 180) / Math.PI}deg`
const holes = Array.from({ length: 5 }, (_, i) => {
  const a = (i / 5) * Math.PI * 2 - Math.PI / 2
  return { x: +(Math.cos(a) * 9).toFixed(2), y: +(Math.sin(a) * 9).toFixed(2) }
})
</script>

<template>
  <div class="loader" aria-hidden="true">
    <div class="loader-sheet">
      <div class="loader-stage">
        <svg class="loader-bot" viewBox="-40 -112 80 134" :style="{ '--roll': `${ROLL}px`, '--spin': spin }">
          <ellipse class="loader-shadow" cx="0" :cy="R + 2" rx="22" ry="2.6" />
          <g class="loader-lean">
            <!-- Body: a slotted side beam, battery, board, head servo, head beam. -->
            <path class="loader-part fill-light" pathLength="100" d="M-6 0V-74A6 6 0 0 1 6 -74V0A6 6 0 0 1 -6 0Z" />
            <rect class="loader-part fill-paper" pathLength="100" x="-1.8" y="-62" width="3.6" height="22" rx="1.8" />
            <rect class="loader-part fill-dark" pathLength="100" x="-10" y="-26" width="20" height="15" />
            <rect class="loader-part fill-mid" pathLength="100" x="-8.5" y="-40" width="17" height="8" />
            <circle class="loader-part fill-light" pathLength="100" cx="0" cy="-74" r="2.4" />
            <rect class="loader-part fill-dark" pathLength="100" x="-6" y="-86" width="12" height="10" />
            <g class="loader-head">
              <rect class="loader-part fill-accent" pathLength="100" x="-17" y="-101" width="34" height="13" rx="6.5" />
              <g class="loader-eyes">
                <circle class="loader-part fill-light" pathLength="100" cx="-7" cy="-94.5" r="3.2" />
                <circle class="loader-part fill-light" pathLength="100" cx="7" cy="-94.5" r="3.2" />
              </g>
            </g>
          </g>
          <!-- Wheel: red, because it is the drive. -->
          <g class="loader-wheel">
            <circle class="loader-part fill-red" pathLength="100" :r="R" />
            <circle v-for="(h, i) in holes" :key="i" class="loader-part fill-paper" pathLength="100" :cx="h.x" :cy="h.y" r="2.4" />
            <circle class="loader-part fill-light" pathLength="100" r="3.4" />
          </g>
        </svg>
        <span class="loader-ground" />
      </div>
      <p class="loader-label">
        <span>Sht 00 / 04</span>
        <span class="loader-count" />
      </p>
      <span class="loader-bar" />
    </div>
  </div>
</template>

<style scoped>
@property --pct {
  syntax: '<integer>';
  inherits: false;
  initial-value: 0;
}

.loader {
  position: fixed;
  inset: 0;
  z-index: 300;
  pointer-events: none;
  animation: loader-lift 420ms cubic-bezier(0.7, 0, 0.3, 1) 950ms both;
}

.loader-sheet {
  position: absolute;
  inset: 0;
  display: grid;
  place-content: center;
  justify-items: center;
  gap: 1.25rem;
  background-color: var(--pn-enamel);
  background-image: var(--pn-grain);
  background-size: 24px 24px;
  border-bottom: 2px solid var(--pn-ink);
}

/* The robot rolls from left of its mark onto it; the ground stays put. */
.loader-stage {
  position: relative;
  width: 300px;
  display: grid;
  justify-items: center;
}

.loader-bot {
  width: 100px;
  height: 168px;
  overflow: visible;
  animation: loader-roll 820ms cubic-bezier(0.45, 0, 0.25, 1) 120ms both;
}

.loader-ground {
  width: 100%;
  height: 10px;
  margin-top: -4px;
  border-top: 1.5px solid var(--pn-ink);
  background-image: repeating-linear-gradient(-45deg, rgba(34, 34, 34, 0.4) 0 1px, transparent 1px 8px);
}

.loader-lean,
.loader-wheel,
.loader-head,
.loader-eyes {
  transform-box: view-box;
  transform-origin: 0 0;
}

.loader-wheel {
  animation: loader-spin 820ms cubic-bezier(0.45, 0, 0.25, 1) 120ms both;
}

.loader-lean {
  animation: loader-balance 900ms ease-in-out 120ms both;
}

.loader-head {
  transform-origin: 0 -88px;
  animation: loader-look 260ms cubic-bezier(0.3, 0, 0.2, 1) 760ms both;
}

.loader-eyes {
  transform-origin: 0 -94.5px;
  animation: loader-blink 160ms ease-in-out 820ms both;
}

/* Plotted as hairlines first, then the faces fill in. */
.loader-part {
  stroke: var(--pn-ink);
  stroke-width: 1.25;
  stroke-linejoin: round;
  stroke-dasharray: 100;
  fill-opacity: 0;
  animation:
    loader-plot 420ms cubic-bezier(0.6, 0, 0.3, 1) 0ms both,
    loader-fill 220ms ease-out 330ms both;
}

.fill-light { fill: #FBFBF9; }
.fill-paper { fill: var(--pn-enamel); }
.fill-mid { fill: #C9C9C2; }
.fill-dark { fill: #2B2B2B; }
.fill-red { fill: var(--color-red); }
.fill-accent { fill: var(--beam-accent); }

.loader-shadow {
  fill: var(--pn-ink);
  opacity: 0.14;
}

.loader-label {
  display: flex;
  gap: 1.5rem;
  font-family: var(--font-readout);
  font-weight: 500;
  font-size: 0.75rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--pn-ink);
}

.loader-count {
  width: 3ch;
  text-align: right;
  font-variant-numeric: tabular-nums;
  animation: loader-count 880ms steps(20) both;
  counter-reset: pct var(--pct);
}

.loader-count::after {
  content: counter(pct);
}

.loader-bar {
  position: absolute;
  left: 0;
  bottom: 0;
  height: 4px;
  width: 100%;
  background: var(--color-cyan);
  transform-origin: 0 50%;
  animation: loader-bar 900ms cubic-bezier(0.6, 0, 0.3, 1) both;
}

@keyframes loader-plot { from { stroke-dashoffset: 100; } to { stroke-dashoffset: 0; } }
@keyframes loader-fill { to { fill-opacity: 1; } }
@keyframes loader-roll { from { transform: translateX(calc(var(--roll) * -1)); } to { transform: translateX(0); } }
@keyframes loader-spin { from { transform: rotate(calc(var(--spin) * -1)); } to { transform: rotate(0); } }
/* Lean into the acceleration, back against the braking, one small overshoot, settle. */
@keyframes loader-balance {
  0% { transform: rotate(0); }
  28% { transform: rotate(9deg); }
  62% { transform: rotate(-7deg); }
  82% { transform: rotate(2deg); }
  100% { transform: rotate(0); }
}
@keyframes loader-look { 50% { transform: rotate(-8deg); } }
@keyframes loader-blink { 50% { transform: scaleY(0.1); } }
@keyframes loader-count { from { --pct: 0; } to { --pct: 100; } }
@keyframes loader-bar { from { transform: scaleX(0); } to { transform: scaleX(1); } }
@keyframes loader-lift { to { transform: translateY(-100%); visibility: hidden; } }

@media (prefers-reduced-motion: reduce) {
  .loader {
    display: none;
  }
}
</style>
