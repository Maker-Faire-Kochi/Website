<script setup lang="ts">
/**
 * The 404's story in one strip: the homepage is a route through the faire, and
 * this page is where the route breaks. The site's little self-balancer (the
 * same one the opening plot draws) rolls along the route, stops at the break,
 * looks one way, then the other, and blinks -- the key below takes it back.
 *
 * CSS only and one-shot (about 3s), so it never loops past WCAG 2.2.2's five
 * seconds; reduced motion shows the final pose. The wheel turns roll / radius,
 * so it never skids; the body leans into the start and back against the stop,
 * as the simulated balancer on the homepage does.
 */
const R = 16
/** From 40 units off the left edge to just short of the break at x 372. */
const ROLL = 385
const spin = `${(ROLL / R) * 180 / Math.PI}deg`
const holes = Array.from({ length: 5 }, (_, i) => {
  const a = (i / 5) * Math.PI * 2 - Math.PI / 2
  return { x: +(Math.cos(a) * 9).toFixed(2), y: +(Math.sin(a) * 9).toFixed(2) }
})
</script>

<template>
  <svg class="rb" viewBox="0 0 600 150" aria-hidden="true">
    <!-- The route: inked up to the break, then only the faint plan. -->
    <path class="rb-route" d="M0 122H372" />
    <path class="rb-plan" d="M408 122H600" />
    <!-- The break, marked like a station. -->
    <!-- Position on the outer group, animation on the inner one: a CSS
         transform would REPLACE the SVG translate, not compose with it. -->
    <g transform="translate(390 122)">
      <g class="rb-station">
        <circle r="17" />
        <text y="4" text-anchor="middle">404</text>
      </g>
    </g>

    <g class="rb-bot" :style="{ '--roll': `${ROLL}px`, '--spin': spin }">
      <g transform="translate(0 104)">
        <ellipse class="rb-shadow" cx="0" cy="18" rx="22" ry="2.6" />
        <g class="rb-lean">
          <path class="p-light" d="M-6 0V-74A6 6 0 0 1 6 -74V0A6 6 0 0 1 -6 0Z" />
          <rect class="p-paper" x="-1.8" y="-62" width="3.6" height="22" rx="1.8" />
          <rect class="p-dark" x="-10" y="-26" width="20" height="15" />
          <rect class="p-mid" x="-8.5" y="-40" width="17" height="8" />
          <rect class="p-dark" x="-6" y="-86" width="12" height="10" />
          <g class="rb-head">
            <rect class="p-accent" x="-17" y="-101" width="34" height="13" rx="6.5" />
            <g class="rb-eyes">
              <circle class="p-light" cx="-7" cy="-94.5" r="3.2" />
              <circle class="p-light" cx="7" cy="-94.5" r="3.2" />
            </g>
          </g>
        </g>
        <g class="rb-wheel">
          <circle class="p-red" :r="R" />
          <circle v-for="(h, i) in holes" :key="i" class="p-paper" :cx="h.x" :cy="h.y" r="2.4" />
          <circle class="p-light" r="3.4" />
        </g>
      </g>
    </g>
  </svg>
</template>

<style scoped>
.rb {
  display: block;
  width: 100%;
  height: auto;
  overflow: visible;
}

.rb-route {
  fill: none;
  stroke: var(--pn-ink);
  stroke-width: 1.25;
  stroke-dasharray: 372;
  animation: rb-draw 700ms cubic-bezier(0.6, 0, 0.3, 1) both;
}

.rb-plan {
  fill: none;
  stroke: var(--pn-ink);
  stroke-width: 1;
  stroke-dasharray: 2 6;
  opacity: 0.35;
}

.rb-station circle {
  fill: var(--pn-enamel);
  stroke: var(--color-red);
  stroke-width: 1.5;
}

.rb-station text {
  font: 500 10px var(--font-readout);
  fill: var(--pn-ink);
}

.rb-station {
  transform-box: fill-box;
  transform-origin: center;
  animation: rb-pop 360ms cubic-bezier(0.3, 1.4, 0.5, 1) 600ms both;
}

/* The robot, drawn in the site's materials. */
.rb-bot * {
  stroke: var(--pn-ink);
  stroke-width: 1.25;
  stroke-linejoin: round;
}

.p-light { fill: #FBFBF9; }
.p-paper { fill: var(--pn-enamel); }
.p-mid { fill: #C9C9C2; }
.p-dark { fill: #2B2B2B; }
.p-red { fill: var(--color-red); }
.p-accent { fill: var(--beam-accent); }

.rb-shadow {
  fill: var(--pn-ink);
  stroke: none;
  opacity: 0.14;
}

/* Rolls in from off the left edge and stops just short of the break. */
.rb-bot {
  animation: rb-roll 1500ms cubic-bezier(0.45, 0, 0.25, 1) 500ms both;
}

.rb-lean,
.rb-wheel,
.rb-head,
.rb-eyes {
  transform-box: view-box;
  transform-origin: 0 0;
}

.rb-wheel {
  animation: rb-spin 1500ms cubic-bezier(0.45, 0, 0.25, 1) 500ms both;
}

.rb-lean {
  animation: rb-balance 1700ms ease-in-out 500ms both;
}

.rb-head {
  transform-origin: 0 -88px;
  animation: rb-look 1100ms ease-in-out 2050ms both;
}

.rb-eyes {
  transform-origin: 0 -94.5px;
  animation: rb-blink 180ms ease-in-out 3100ms both;
}

@keyframes rb-draw { from { stroke-dashoffset: 372; } to { stroke-dashoffset: 0; } }
@keyframes rb-pop { from { transform: scale(0); } to { transform: scale(1); } }
@keyframes rb-roll { from { transform: translateX(-40px); } to { transform: translateX(calc(var(--roll) - 40px)); } }
@keyframes rb-spin { from { transform: rotate(0); } to { transform: rotate(var(--spin)); } }
@keyframes rb-balance {
  0% { transform: rotate(0); }
  25% { transform: rotate(9deg); }
  70% { transform: rotate(-7deg); }
  86% { transform: rotate(2deg); }
  100% { transform: rotate(0); }
}
/* At the break: a look ahead, a look back, then settle facing the gap. */
@keyframes rb-look {
  0%, 100% { transform: rotate(0); }
  30% { transform: rotate(10deg); }
  65% { transform: rotate(-10deg); }
}
@keyframes rb-blink { 50% { transform: scaleY(0.1); } }

@media (prefers-reduced-motion: reduce) {
  .rb-route,
  .rb-station,
  .rb-bot,
  .rb-wheel,
  .rb-lean,
  .rb-head,
  .rb-eyes {
    animation-duration: 1ms;
    animation-delay: 0ms;
  }
}

:root[data-motion-start='paused'] .rb * {
  animation-duration: 1ms !important;
  animation-delay: 0ms !important;
}
</style>
