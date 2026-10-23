# Maker Faire Kochi 2027 — project notes

Nuxt 4 / Vue 3 single-page site, three.js 0.186 for every drawing. No test runner; tests are tsx scripts (`npm run test:*`).

## Current design: campaign fields + full-screen 3D chapters (revamp, 2026-10)

Visual language: **Dela Gothic One** display (`--font-panel`, one weight, `--lh-display` 1.08) +
**Inter** text (`--font-readout`), Noto Sans Malayalam on `:lang(ml)`. Whole sections are colour
FIELDS (`.field-paper | -yellow | -blue | -ink`; campaign yellow `#FFE86C`, blue `#2B19D9`), red
`#C4121A` is the action, cyan is structural only. Every drawing is **live three.js in the
straight-beam hairline style** (slotted straight members, plain pins, opaque faces, fine edge lines).
Event: **5–6 February 2027, The Grounds @ Chakola Mill, Kochi** (all facts live in `EVENT`,
`useCountdown.ts`; nuxt.config, error.vue and `server/utils/mailer.ts` keep their own literals).

Page order (`pages/index.vue`) — the rail's stations and the footer must follow it:
Hero (`#top`, yellow) · What (`#about`, paper, one screen) · Kochi (`#kochi`, backwater chapter) ·
Domains (`#categories`, the aisle) · Workshop (`#workshop`, carpenter chapter) · Bench (`#bench`,
electronics chapter) · Noise (`#noise`, yellow chapter) · Take part (`#take-part`, blue, one
screen) · When (`#countdown`, blue machines chapter) · Beyond (`#beyond`, yellow, one screen) · footer.

- **Fields:** a `.field` section is NOT positioned, so its background paints BELOW the 3D canvas
  (fixed, z-index 0, first child of body); every direct child is `position: relative; z-index: 1`.
  A slot is transparent, so a drawing appears on the field itself. Never position a `.field` or
  `main`, never give a wrapper an opaque background, or every scene inside disappears.
  `.field.screen` = at least one screen, content centred; `.field.chapter-field` = no padding.
- **Full-screen chapters** (`components/three/SceneChapter.vue`, `<ThreeSceneChapter>`): the scene
  fills a sticky 100svh stage edge to edge; the default slot's `.chapter-panel`s scroll over ONE
  side (`side="left|right"`). Panels are opaque (text never sits on a moving frame; a panel may
  carry `field-blue|yellow|ink`, else it takes `--chapter-ground`). The panels column is pulled
  up with `margin-top: -100svh` — NOT a negative margin on the sticky stage, which shrinks its
  sticky box to nothing and pins it a whole screen past the chapter, over the next section.
  Panels emit `progress` (continuous, 0..n-1, as each panel's centre crosses mid-screen) and
  `stepActions[i]` runs a scene action when panel i is reached. Caption, hint and keyboard
  controls sit in the dock: the bottom corner on the drawing's side, just above the nav (under
  the scene on phones; compact -- one scrolling row of chips, no hint -- on phones and screens
  under 500px tall). **The focus box stops at the dock's top** (and the nav's): `SceneChapter`
  measures both (ResizeObserver) and trims the box's y1, so no scene frames its subject under
  them at any size. The props' boxes are the maximum; the live box is shorter.
- **Phones (<= 740px): the drawing is never covered.** Each panel is `position: sticky` at the
  chapter's `--stick` (54% down, or higher so the chapter's tallest panel fits, never above 30%;
  `measureBand`, one pin per chapter so no covered panel peeks out) and fills the band to the
  screen's foot; the next panel slides up over it. Steps on phones count from a panel reaching its
  pin. The phone hero flattens its words block (`display: contents`) so the playground sits under
  the headline and facts, sized to the mat (`min(68svh, 80vw)`).
- **Smoothness:** every scene builds once the page is idle, in page order, one at a time
  (`buildQueue` in `SceneSlot.vue`), not mid-scroll as a chapter nears (`near` is the fallback);
  `FixedClock.advance` takes a wall-clock budget (stage: 8 ms per slot) so a slow phone slows the
  motion a moment instead of spiralling into catch-up stutter; the aisle meter reads cached stall
  centres, never fresh rects after writing the transform.
- **Focus box** (`fit()` in `core/stage.ts`): a slot's `data-focus="x0 x1 y0 y1"` (fractions)
  makes the scene's `resize(w, h)` receive the BOX size, and a `setViewOffset` extends the same
  camera over the rest of the slot. Scenes frame their subject for the box and must build a world
  that runs past every screen edge (floor/wall/water/horizon, test at 2560x1080). Pointer NDC stays
  slot-relative (correct for raycasting); a scene's own px (hover labels, `heroAnchors`) come out
  scaled by the box, so the page divides them by the box's width/height fractions
  (`SceneChapter` callout, `HeroLeaders`). Desktop boxes: hero `0.46 1 0 1`, bench `0 0.6 0 1`,
  others `0.44 1 0 1` (the panels' right edge stays left of it); phones (<= 740px) `0 1 0 0.6`;
  the hero below 900px wide or 560px tall stacks under
  the words with no box. `/lab/<scene>?focus=0.44+1+0+1` outlines the box.
- **Scroll-driven shots:** `electronics/shots.ts` and `backwater/shots.ts` export `SHOTS` and a
  plain `scrollShot = { progress }` that the chapter writes (`Bench.vue`, `Kochi.vue`); the scene
  eases toward it without overshoot. The panel count must equal `SHOTS.length`.
- **Headings in boxes size to the box:** chapter panels and stall boards are size containers
  (`container-type: inline-size`) and their display headings use `cqi` units, so a long word
  ("ELECTRONICS", "RESTORATION") never runs out of its panel. Check with `npm run check:overflow`.
  A display heading in a GRID CELL is the same problem (Beyond's "BEYOND", the form titles):
  wrap it in a `container-type: inline-size` div and size it in `cqi` from the word's measured
  em width (BEYOND 5.3em, INVOLVED 6.7em, VOLUNTEER 7.9em). check:overflow now tests every text
  run against its own block too, on `/`, `/interestform` and `/volunteer`, 320 to 3840 wide.
- **Big screens:** from 1920px wide `html { font-size: max(100%, 100vw / 120) }` (16px at 1920,
  32px at 3840), and the wrap is `82.5rem`, so 2K/4K monitors and TVs get the 1920 layout scaled
  up, not a small column. px-built chrome steps with it: the rail `zoom`s 1.25/1.5/2 at
  2400/2880/3600px and `--rail-h` follows (70/84/112px). Size new layout in rem, not px.
- **Domains** (`components/home/Domains.vue`) is a pinned "faire aisle": one striped-awning stall
  per discipline, scrolled sideways while the section is pinned (height = screen + row overflow);
  focusing a stall's link scrolls the page to it. No JS / row fits: a plain sideways-scrolling row.
  The copy says "domain" (meter: "Domain 03 / 14"); "stall" is only the drawing and class names.
- **No coplanar faces (z-fighting).** Two same-facing faces on one plane shimmer as the camera
  moves (the far shore's land and its stone edge did, under scroll). Stop one block short or sink
  it into its neighbour; `test-backwater.ts` samples every face of the ground, boom and stones.
- **Form pages** (`/interestform`, `/volunteer`, shared `form-sheet.css` + `InterestSection.vue`):
  a yellow title field, then the form on paper, one numbered section per 2px rule (big blue
  figure + head pinned beside its fields over 900px, stacked below); choice tiles fill campaign
  blue when chosen, the focus ring goes round the tile; submit is the red key; thanks is a blue
  panel. SheetBar hides its Home link at <= 430px (the logo goes home).
- **One WebGL renderer** (`core/stage.ts`, multiple-scenes pattern, scissor per slot, only visible
  slots simulate). `<ThreeSceneSlot>` SSRs a poster `<picture>` and imports three.js after load +
  idle; reduced motion, Save-Data and no-WebGL never import it.
- **Scenes** (`scenes/index.ts`):
  - `hero` — the WHOLE first screen is the playground (no focus box): a 10 cm 3D diorama board
    whose top is exact #FFE86C (unlit shader), ochre faces, slotted-beam lips. Data-driven cast
    (`FACTORIES` + `CAST_WIDE` / `CAST_PHONE`, `castFor`): Makey, two Open-Duck-Mini ducks, an
    Ascento-style wheel-legged balancer and a Go2-style dog (phone: Makey + duck). Default activity is
    FOOTBALL (two teams, keepers, shots, seeded clashes about every 10–20 s, goal celebrations, a ramp
    the wheel-leg jumps off); robots fall and get up their own way. The pointer is DELIBERATE only:
    moving it changes nothing (tested bitwise); a click/tap or a 1.2 s rest sets one cyan target the
    nearest robots go to; grab-and-fling stays. **Text is a separate zone:** `Hero.vue` publishes
    the logo, words block, key box, hint and nav rail as `heroKeepOut` rects (core/signal.ts,
    fractions of the slot); the scene raises a plinth under each and treats it as a solid wall, so no
    robot, ball or block is ever drawn over the text (tested). `heroAnchors` ids are `${kind}-${n}`;
    `HeroLeaders` numbers 01 Makey, 02 duck, 03 balancer, 04 dog.
  - `backwater` — cheena vala worked by two fishers (overhand rope grips, hand over hand ~20 cm a
    stroke, eyes on the net via `lookAt(net, { priority: 'target' })`); the catch (karimeen-style fish,
    seeded, some dips empty) comes up in the net and one fisher scoops it with a 9 m pole from a rack
    beside his hip into an open basket. Coconuts fall on their own every 12–18 s and hit the bank
    people (kid, watcher, visitor), each with a kind reaction. Four scroll shots (`backwater/shots.ts`, a PERSPECTIVE
    camera, 40° FOV, fitted by projected bounds): the machine from a boat at eye level, three-quarter
    on from the net's end (az -0.55: end-on from the bank was a tangle, a bank-side camera stood among
    the palms), the balance (pivot, counterweights, haulers), the catch (fixed frame on the lifted net
    that also holds the boom's tip through the whole dip, so the machine never leaves it), the bank.
    Tests use the dock-trimmed boxes. Keep-away rule: with perspective, anything near the camera but
    outside the focus box renders huge across the full-bleed slot, so every shot keeps people >= 6.6 m
    and palm trunks >= 8.5 m from the camera over the WHOLE slot (tested). Nothing moves without a cause.
  - `workshop` — a carpenter seen three-quarter front: saw, plane, mallet + chisel worked with
    wrapped grips (people `setHandTarget` axis/kind), weight moving with each stroke, eyes on the cut,
    walking between stands; exploded stool; full room. Tests check arm/torso clearance, elbow side,
    wrist limits, palm facing, fingers clear of tools and hand/shoulder speed.
  - `electronics` — a maker's corner (pegboard, racks, drill press, mitre saw, monitor, meter,
    magnifier lamp) with a seated maker soldering; four shots.
  - `noise` — noise machine + pen plotter (feeds `noiseSignal`).
  - `machines` — THE countdown: a yellow split-flap counter (DD HH over MM SS, Dela Gothic figures,
    the seconds flap falls every second) driven by a gear train and red crank, on the blue field (When
    is a `field-blue` chapter; the scene paints its floor exactly #2B19D9 with an unlit quad, as the
    hero paints #FFE86C).
- **People** (`app/three/people/`): skinned bodies with blended joints (7.5-head canon), faces,
  hands with finger bones, garments (shirt, kurta, mundu/lungi/folded with kasavu, skirt, hijab,
  apron), seeded looks and varied rest poses (`style.ts`). Grips: `setHandTarget(side, { position,
  normal?, elbow?, axis?, kind: 'wrap'|'pinch'|'flat', radius? })`; wrist limits, hand <= 4 m/s and
  shoulder <= 1 m/s, hand/head and hand/hand clearance are enforced by the library. Gaze:
  `lookAt(t, { priority: 'target' })` keeps eyes on the work (any options object also TRACKS a
  moving target; plain `lookAt(t)` does not). Never run
  `disposeGeometries` over a person: people share geometry; call `person.dispose()`.
- **Robots** (`app/three/robots/`): `balancer/` wheel-legged, physically simulated (LQR gains
  scheduled on leg length, committed; `npx tsx scripts/tune-balance.ts` regenerates and cross-checks
  them); `duck/` kinematic IK gait + real falls; `dog/` and
  `makey/` share `dog/stepper|script|rig|kin.ts`. All implement `robots/types.ts`.
- **Determinism, motion, keyboard, sound, signals, Pretext, easter eggs, PageLoader, start-up
  cost:** unchanged from the first revamp: fixed 5 ms steps (`core/clock.ts`), seeded `core/rng.ts`;
  ONE motion state (`useMotion`; templates read `view`, logic reads `state`); every pointer
  interaction has a button calling `action(name)` with a polite live region; audio only through
  `soundContext()`; easter eggs typed "dance"/"conga", Konami, logo x5, a minute idle. The rail's
  sound switch spells out "Sound on/off" over 900px wide, and Off suspends the shared
  AudioContext, so a loop already playing stops too (not just the next sound).

Dev tools:

```bash
npm run dev                      # then /lab/<scene>[?focus=x0+x1+y0+y1] (dev only; 404 in production)
npm run shot -- <url> <out.png> [--sample 3000 --cpu 4] [--move x,y] [--tap x,y] [--reduced] [--webgl-off]
npm run posters                  # regenerate public/img/scenes/* (dev server running); renders each scene
                                 # at screen shape WITH its chapter's focus box
npm run test:three               # balance + gait + collisions, then test:scenes
npm run test:scenes              # every scene + people (dog and Makey: npx tsx scripts/test-dog.ts / test-makey.ts)
npm run test:contrast            # every colour pair the site paints, WCAG thresholds
npm run check:overflow           # (dev server running) no text runs out of its panel/stall/page at 12 widths
```

**Regenerate the posters whenever a scene's look or poster pose changes**; they are what
reduced-motion, Save-Data and no-WebGL visitors see, and what everyone sees before the first frame.

Budgets per slot (`npm run shot -- … --sample`): hero <= 130 draw calls desktop (it runs at ~125) / 70 phone,
backwater <= 75, others <= 70; <= 80k triangles per scene (hero <= 100k). The lab draws each scene
twice (full + 96px thumbnail), so halve its stats. The lab thumbnail can go blank under `?focus=`
because the full-bleed slot draws over it; the homepage has no overlapping slots.

The **2026-09 control-panel hero** (`MakerSchematic.vue`) was deleted in this revamp; the
notes below about it, and everything under "The hero is a live vector scene", are history.
`usePanelSound.ts` stays: the rail's key sounds use it and `playMachine('servo')` voices the
robots.

## History: "control panel / drawing sheet" (2026-09, superseded by the 3D revamp)

**The hero is now `app/components/hero/MakerSchematic.vue`, NOT `HeroScene.server.vue`.**
The Open Peeps scene and its `remotion/` pipeline are no longer rendered anywhere
(`HeroScene.server.vue` is still on disk but unreferenced). Everything under "The hero is a live
vector scene" below documents that retired scene — read it as history, not as live rules.

- **Palette is the favicon only:** red, cyan, white, plus black (`--pn-ink`), on white
 dot-grid paper. The CLAUDE.md contrast rules still apply: cyan is never text on white, and
 cyan *labels* use `#0077A8` (5.0:1) instead, e.g. `.a-fig`.
- **Type:** Archivo (`--font-panel`, condensed via `font-stretch: 62%`) for display, IBM Plex
 Mono (`--font-readout`) for body/labels. Buttons are `.key` / `.key-red` (tactile, 60ms press).
- **MakerSchematic is interactive.** Five machines (cheena vala, drone, treadle sewing machine,
 charkha & wool, robot arm) are `role="button"` groups; click/Enter runs a one-shot
 `.is-running` animation plus a WebAudio sound from `playMachine()` in `usePanelSound.ts`.
 The robot arm stays parked until it is clicked. That click starts two-link IK
 (reactive `transform` attributes, rAF lerp) and closes the gripper; a second
 click, or eight seconds without a pointer move, parks it at rest. While it
 tracks, the target is clamped to `REACH` in the arm's own drawing, so the gripper
 stays to the right of the charkha. Unclamped, it tracked the pointer across the whole hero and
 swung over the charkha and sewing machine. Kerala set pieces: one coconut palm (built by
 `palm()`; item `11` is a button that drops a nut to the ground), plus hanging
 counterweight stones and a lantern on the cheena vala. Idle motion is gated by `.hero-stage.is-ready`, paused by
 `.is-offscreen`, and removed by `prefers-reduced-motion`. Keep the viewBox origin at `0 0`:
 parts rotate with `transform-box: view-box; transform-origin: 0 0` inside `translate()` groups.
- **React Bits are hand-ported to Vue** in `app/components/bits/` (auto-imported as `Bits*`):
 `SplitText`, `DecryptedText`, `CountUp`, `ClickSpark`. No React dependency was added.
 All SSR-render final text (SEO / no-JS safe), and all skip under reduced motion.
- **`PageLoader.vue`** is CSS-only (no JS gate), `pointer-events: none`, lifts at ~950ms.
 Hero entrance delays (1050–1800ms) are tuned to it — move them together.
- **Scroll reveal** lives in `pages/index.vue`; `.reveal` is added by JS only, and only to
 elements below the fold, so no-JS visitors and the first screen never start hidden.
- **`--rail-h` is 58px** now (the nav keys grew with the reading type).
- **A reload always starts at the top** (`plugins/scroll-top.client.ts`: manual
 `scrollRestoration`, hash stripped, `scrollTo(0,0)` on mount and first `page:finish`).
- **The sheet stacks below 900px wide, and also below 520px tall** (a landscape
 iPhone is wider than 900). The parts list uses `auto-fit` so its labels wrap
 inside the key cell. Form and admin fields are 16px so iOS does not zoom on focus.
- **The backwater is ONE clipped body** (`#sch-water-clip`, x 0–214): a filled surface that
 slides exactly one wave period (40 units) per loop, plus dashed currents on `stroke-dashoffset`.
 Keep the wave path extending ≥ 40 units past both clip edges or the loop shows a gap.
- **Admin** uses the same language: `layouts/admin.vue` defines the shared unscoped
 `.a-panel / .a-head / .a-fig / .a-title / .a-meta / .a-empty` classes used by every chart in
 `modules/admin/components/` (`AdminLineChart`, `AdminDonut`, `AdminHeatmap`,
 `AdminPipeline`, `AdminSparkline`, `AdminBarChart` — whose `fig` prop is required). Metrics
 come from `useInterestAnalytics.ts` (`series14/30`, `weekCompare`, `heatmap`, `pipeline`,
 `combos`, `depth`, ...). The heatmap uses the viewer's local time, like the day series.
 Sparklines use `preserveAspectRatio="none"`, so their end dot is a round-capped
 zero-length stroke; a `<circle>` stretches into an oval.

## Run

```bash
npm install       # once
npm run dev       # http://localhost:3000
```

Production check:

```bash
npm run build
node .output/server/index.mjs      # PORT=3000 by default
```

## Design system invariants

These are **contrast requirements, not preferences**. `npm run test:contrast` measures every
pair; a pair belongs to its GROUND, so add the new ground there when one moves.

| Token | Value | Rule |
|---|---|---|
| `--pn-enamel` (paper) | `#F6F6F3` | Page ground. Ink on it 14.7:1, `--pn-label` 6.9:1. |
| `--color-red` | `#ED1C24` | Logo and display type **≥24px only** (4.05:1 on paper). |
| `--color-red-cta` | `#C4121A` | **Every red fill behind a label** and any small red text (5.6:1 on paper; white on it 6.1:1). |
| `--color-red-on-dark` | `#FF5A5F` | Red **text on ink/charcoal**. |
| `--color-cyan` | `#00AEEF` | **Structural only** on light grounds (2.34:1 on paper): fills, rules, icons. Never text or a focus ring on paper. Fine on dark. |
| `--color-cyan-text` / `--focus-ring` | `#006E9B` | Cyan as text or focus ring on light grounds (≥4.6:1 on paper and every light tint). |
| `--lh-display` | `1.08` | Every multi-line Dela Gothic One setting. Its caps collide below ~1.05. |

Dela Gothic One is single-weight: `font-synthesis: none` is on, and display rules use `font-weight: 400`
— never ask for a bolder display face (the browser would fake it). Campaign field pairs (blue on yellow
7.58, white on blue 9.36, label #D8D4FF on blue 6.59, red CTA on yellow 4.93) are in the audit.

## Gotchas worth not rediscovering

### The hero is a live vector scene, not a video

`app/components/HeroScene.server.vue` is **generated** — never hand-edit it. Regenerate with:

```bash
cd remotion && npm run scene          # extract -> measure -> build
npm run scene:verify-loop             # must report 0.000 RMSE
npm run scene:contrast                # re-measure hero contrast
```

Source of truth: `remotion/scripts/` — `cast.cjs` (figure library), `scene/placement.cjs`
(seeded crowd generator — no promenade; see "No walking crowd"), `scene/gearTower.cjs`, `scene/booths.cjs`
(stalls and exhibits), `scene/machinery.cjs`, `scene/props.cjs`.

See the motion without a browser: `npm run scene:gif` writes `out/hero-loop.gif`.
Verify invariants: `npm run scene:check` (periods), `npm run scene:spacing` (no two figures
merge) and `npm run scene:verify-loop` (0.000 RMSE — re-run a failure before believing it, it
is intermittently flaky).
Debug ONE machine alone at a pinned instant: `node scripts/isolate.cjs robotArm 6000`.

**A t=0 screenshot and the loop test both PROVE NOTHING about pivots.** The loop test compares
`rotate(0)` with `rotate(360deg)`, and t=0 is the identity frame — so a part that swings wildly
about the wrong point looks perfect in both. Every one of the disconnection bugs below was
invisible at t=0 and passed the loop check. **Always render a mid-cycle frame** (t=6000, 19000)
and prefer `isolate.cjs`, which strips every other element so a stray fragment cannot be
mistaken for a neighbour's part.

**No walking crowd.** A Maker Faire is a show and tell: people stand at a stand and
demonstrate. Visitors walking past read as a street scene and pulled attention off the
exhibits. Aerial traffic (three drones and a blimp, at different heights and rhythms) carries
the sense of movement instead.

**Keep machines' working envelopes clear of figures.** The robot arm reaches ~500 units; with
a ladder and two figures crossing it, the linkage was visually chopped into fragments and its
gripper jaws looked like debris floating in mid-air.

The constraint is **vertical, not a blanket x cutoff** — an earlier `// No zone over x>1500`
comment cost the whole right third of the frame its people. For `robotArm(1772, 902, 0.9)`,
sweeping shoulder -9..11, elbow -14..18 and wrist -16..16 to their extremes, the leftmost point
is x=1509 at y=543 and the linkage's lowest pixel per column is:

| column | linkage bottom |
|---|---|
| x ≤ 1580 | y 571 |
| x 1580–1600 | y 585 |
| x 1600–1620 | y 596 |
| x 1620–1640 | y 612 |
| x 1640–1660 | y 626 |
| x > 1660 | **unmeasured — keep figures out** |

A figure is safe only where its **head top** stays above that bottom across the figure's whole
width. That is why the apron pair is **hand-placed** in `placement.cjs` with fixed heights: the
pooled comb deals rows in random order and cannot express "front must be leftmost".

It is a PAIR, not a trio — a third figure was covered by the easel, which paints after every
crowd row. Current members and their MEASURED clearances, under the bob (`--bob` lifts a figure,
so the animated head top is `feet - h - bob`, not `feet - h`):

| figure | x | h | animated head top | clearance |
|---|---|---|---|---|
| `st_arms` front | 1448 | 268 | y 627.2 | 56.2 |
| `st_blazer` back | 1480 | 176 | y 659.2 | 88.2 |

Two things about that table are load-bearing:
- **Head top is pose-independent, WIDTH is not.** `place()` maps each measured bbox to exactly
  `h` tall, so swapping a pose cannot change the head top — but it changes the width by the
  pose's `bbox.w / bbox.h`. `st_blazer` is 0.369, so at h=176 it is 65.0 wide and its right
  edge is 1512.5. The easel's ledge starts at **x=1518** (`art.cjs` draws it `cx0 - 6` wide by
  `cw + 12`), leaving 5.5 units. `st_point` at 0.493 would reach 1537.4 and was rejected for
  that reason. Re-check the right edge after ANY pose swap here.
- The two centres are only **32 units** apart, so they overlap in depth. Verified at t=6000 and
  t=19000 on a FULL-SCENE frame: the heads stay separate (they also sit 32 units apart
  vertically), so it reads as two people, not one two-headed shape. `isolate.cjs robotArm`
  cannot judge this — it strips away the very figures and easel whose overlap is in question.

Re-derive the table if the arm is moved, rescaled, or retimed.

**The scene was deliberately CUT DOWN to six machines. Do not "restore" the rest.**
It used to carry seventeen machines covering twelve machine classes, and this file used to
say that coverage "should stay complete". That is no longer true and the change was
intentional, made on the owner's instruction to reduce the scene's weight and visual load.
What survives, one per class:

| class | machine |
|---|---|
| textile | loom (left canopy) |
| additive | 3D printer |
| rotary | gear tower |
| articulated | robot arm |
| energy | wind turbine |
| aerial | drone |

plus two non-machine craft exhibits that carry no animation: the **pot shelf** (ceramic) and
the **easel** (drawing). Every machine still visibly runs.

DELETED, with their CSS: laser cutter, oscilloscope, LED matrix, pen plotter, rover,
animatronic servo, blimp, two extra drones, and the whole receding background row (second
turbine, conveyor, CNC mill, press, solar array). The builders for them still EXIST and are
still exported from `scene/tech.cjs` and `scene/props.cjs` — they are simply never called,
exactly like the unpooled `si_*` entries in `cast.cjs`, and an uncalled builder emits zero
bytes. That is a library, not dead wiring. (Contrast `placeWalker`, which IS a trap — see
"The walking machinery" below — because it is half-wired: re-adding a walker renders nothing
until an interpolation is also restored.)

**ONE ground line now.** The faded background row and its `bg()` helper are gone, along with
`BG_FEET` and the unused `at()` placement helper. `check-grounded.cjs` no longer lists 854 as
a support. If you re-add a receding row you are re-adding `bg()` too; the old fade floor was
about 0.6, because under the 0.58 scrim anything fainter simply is not there.

**A single-exhibit stand must have NO front row.** Exhibits paint after the back and mid rows
but BEFORE the front row, so a front-row visitor stands in front of whatever the stand is
showing. That was survivable when a stand carried two or three exhibits spread across its
width — one body could only cover one of them. With one exhibit per stand it hides the whole
thing: measured after the cut, the 3D printer was reduced to a flat panel behind a shoulder
and the pot shelf was about 60% covered. So `fab` and `ceramics` are `front: 0` and their
demonstrators are `mid`, which puts them BEHIND the bench where a demonstrator belongs.
Foreground scale comes from `craft`, `kinetic`, the apron pair and the wheelchair instead.

**Art was cut where it could not be read, not squeezed in.** A hand-drawn potter's wheel was
written and rewritten twice and still read as a lamp on a stool — a wheel head seen from the
side spins about a vertical axis and shows no motion, so all that mechanism bought nothing. It
was DELETED and replaced by a shelf of pots, which is legible at a glance. A kiln was planned
for the arm's apron and dropped: `PR.kiln(1652, …)` overlaps the robot's fixed base plate,
turntable and column, so paint order would only decide which one hid the other.

**The scene is composed as a FAIRE, not a tableau.** A rhythm of booths — craft, fabrication,
ceramics — each with a canopy, a sign and its own exhibit, with air
between them and visitors circulating in front. A crowd standing before machinery is a group
photo; stalls people move between is a faire. Keep that structure when adding anything.

- **It is a `.server.vue` on purpose.** The figure data is ~159KB of markup (was ~400KB
  before the pose pool was cut, and it is still the largest single thing on the page). A normal
  component would ship it in the SSR HTML *and* again in the client chunk as a compiled
  render function. It needs `experimental.componentIslands` in `nuxt.config.ts`. Verified:
  no client JS chunk contains the path data.
- **It sits in `app/components/`, not `app/components/hero/`.** Nuxt's `pathPrefix` would
  register it as `HeroHeroScene`, and server components must resolve via auto-import to get
  island treatment.
- **Figures are INSTANCED — with ONE documented exception.** Each unique Open Peeps person is
  emitted once into `<defs>`; the crowd is `<use href="#fig-…">`. The hand-drawn back-view
  visitors (`scene/backs.cjs`) are emitted INLINE instead: each is unique and used once, so
  `<use>` would save nothing, and they are ~2.6KB against ~25KB for a peep. This is a
  deliberate second convention, not an oversight — if back views ever repeat, instance them.
  12 instances cost what 5 figures cost, because only the poses actually placed are emitted. *Internal* `<use>` is
  universally supported — only external-file references are a portability problem (verified
  in Chrome; Safari's external-ref gap is why the whole scene is inline, not a sprite).
- **Gear periods are NOT written in CSS.** `gearTower.cjs` derives radius from tooth count
  (a shared module) and period from `teeth × 0.5s`, then emits `--dur` and `data-dir` inline.
  Meshed gears counter-rotate and their periods are proportional to tooth counts — hard-coding
  those in CSS guarantees the drawing and the motion eventually disagree.
- **Tooth counts are constrained to {12,16,24,32,48,96}** so every period (6/8/12/16/24/48s)
  divides the 48s master cycle. Pick 20 teeth and the loop stops closing.
- **Resize the gear tower with `MODULE_R`, NEVER with a wrapper `transform="scale()"`.** The
  tower's plinth, A-frame feet and cross-members are authored at ABSOLUTE y (806, 812, 822, 902);
  only the gear train is positioned by `wantCx`/`wantBase`. So a group scale shrinks the plinth
  too and lifts it off the ground — tried at 0.7, and `scene:grounded` correctly reported the
  tower floating 46 units above its nearest support. `MODULE_R` (scene units per tooth) shrinks
  the train in place and leaves the footing alone. It is safe because periods are
  `teeth × SEC_PER_TOOTH` and do not involve it, and centre distance stays exactly
  `rParent + rSelf` since both radii come from `radiusFor()`. It went 2.9 → **2.1**, which took
  the train from 587×619 to ~425×448 and dropped its top from y 81 to ~252, off the headline.
  What it does NOT scale: strut widths, the hub radius (clamped at 11, so the 12-tooth gear's
  spokes are now short), the plinth, and the governor — which is now larger than the `g4` it
  hangs off. All four were checked at t=6000 and t=19000 and still read as one machine, but they
  are fixed-size and will drift further if `MODULE_R` moves again.
- **The crowd is seeded, not hand-listed.** `SEED` in `placement.cjs` drives pose, height,
  mirroring and jitter. Deterministic on purpose: a scene that reshuffles every build is
  unreviewable and churns the committed output. Change `SEED` to reshuffle.
- **The pose POOL is FOUR, and changing it RESHUFFLES THE WHOLE CROWD.** `POOL` in
  `placement.cjs` is an explicit list — `st_arms`, `st_pants`, `st_blazer`, `st_easing` —
  not "every `st_*` in cast.cjs" as it used to be. It was cut from twelve, then to four,
  because `<defs>` dominates the generated component: one pose is 20–46KB of path data, and
  the whole scene body (every machine, booth and prop) is smaller than two of them.
  `cast.cjs` deliberately keeps ALL its entries: it is the enumerated list of verified
  react-peeps keys and an unplaced entry emits nothing.

  **Only a POOL-ONLY pose can actually be dropped.** `st_arms`, `st_pants` and `st_blazer`
  are ALSO used by hand-placed figures (the apron pair and the ladder figure), so removing
  one of those from `POOL` leaves it in `<defs>` and saves **nothing**. When `st_point` was
  cut (2026-08-30) only it and `st_easing` were pool-only; `st_easing` was kept because it is
  the hijab-wearing figure and these poses are chosen for who they represent, while
  `st_point` was distinguished only by gesture. Check this before choosing a pose to cut.

  **The trap:** the pool size changes how many values `shuffleDeck()` draws from the RNG, so
  editing `POOL` — or any zone count — reshuffles EVERY zone, including ones whose counts you
  did not touch. That silently moved a pooled figure to within **7 units** of a hand-placed
  back-view visitor, against a documented ≥31 requirement.

  **`npm run scene:spacing` now enforces this**, and it is wired into `npm run scene`. It is a
  guard the pipeline was missing: the placement comb enforces `MIN_SEPARATION` between POOLED
  figures inside a zone but knows nothing about the hand-placed ones (the ladder figure, the
  apron pair, the wheelchair, the single back-view visitor), and those are exactly the ones that
  break. `scene:grounded` only looks at machines, and a pose-identity check is blind to two
  DIFFERENT poses standing on top of each other — which the guard's own pair loop did **not**
  actually do until 2026-08-29: it tested `a.use === b.use`, so it only ever caught identical
  poses, exactly the blindness this paragraph claims it covers. The identity condition is gone;
  the 2D box now applies to every pair whatever poses they use. Proven with a negative test (a
  `st_arms` dropped on the wheelchair at dx=10, dy=0 now FAILs; it passed before).
  `BACKS` in `check-spacing.cjs` is **derived**
  from `INSTANCES.BACK_VIEWS` — the same array `build-scene.cjs` renders — so it cannot drift.
  (This entry used to claim the two were hand-synced lists; that was already false.) Contrast
  `scene:grounded`, which really does keep a hard-coded selector list and really does need the
  discipline.

  **The crowd is THIRTEEN, and the gaps are the point.** It was 19, and the complaint was that
  the hero looked crowded — but the machines were already cut to six and were never the cause.
  Measured: 19 figures spanned x 277–1480 with a mean neighbour gap of **67 units** and a largest
  gap of **122**, against a front-row figure ~99 units wide. The gaps were narrower than the
  people, so the crowd tiled the frame and the stalls behind it could not be read.

  The zones were not at fault. They leave real air (880→1030 is a deliberate 150-unit gap, and
  nothing is pooled past x=1270) — but **8 of the 19 were hand-placed outside the zone system**,
  and `BACK_VIEWS` aimed its figures at "the widest gaps in the crowd", which is precisely the air
  the zones exist to create. Three back views were dropped (x=890 and x=1010 plugged the 150-unit
  gap; x=1380 plugged the open right third) and one figure each came out of `fab`, `ceramics` and
  `kinetic`. Mean gap is now **100**, largest **157**. Do not re-add a figure "to fill that empty
  patch" — the empty patch is the design.

  The twin rule is **2D on purpose**. A bare x-distance test fails on a legitimate pair: the
  ladder `st_pants` at x=1096, y=660 and a pooled `st_pants` at x=1141, y≈874 are 45 apart in x
  but 214 apart in y. Exempting that one by name would be a fudge; the y term states the actual
  reason it is fine.
- **NO seated poses in the crowd.** Open Peeps' seated bodies (`HandsBackWB`, `ClosedLegWB`,
  `MediumWB`, `OneLegUpWB`, `Bike`, ...) carry a **solid dark lap/leg mass** and are drawn
  assuming a chair this scene never provides, so under the 0.58 scrim they read as a person
  perched on a black blob, not as someone sitting. Three overlapping at x 430–560 was
  unreadable mush. The `si_*` entries stay in `cast.cjs` — they are enumerated, verified
  react-peeps keys — but nothing pools them. `si_wheel` is the sole exception: the wheelchair
  carries its own visible support, so ONE is hand-placed at x=950 in the air between the
  electronics stand and the gear tower. It only reads where nothing overlaps it.
- **Randomness is real but resolved at BUILD time.** Four `rand()` sites drive pose dealing,
  x wobble, ground-line jitter, height, mirroring and row order — but `SEED` is a fixed
  literal, so every visitor sees the same scene and every rebuild reproduces it byte-for-byte.
  That is the point: the output is committed. Per-visitor variety would mean either running the
  generator at SSR time (killing HTML caching) or shipping ~400KB of path data plus placement
  logic in client JS, which is exactly what the server component exists to prevent. To
  reshuffle, change `SEED`.
- **Wobble is LARGE and the separation guarantee is enforced AFTERWARDS.** Capping the wobble
  to buy the guarantee is the trap: a 9-unit cap made spacing nearly even and gap spread
  (coefficient of variation) fell from 1.25 to 0.36 — a lineup, the exact thing the zones exist
  to prevent. The wobble is now ±45% of the comb gap and a two-pass relaxation opens any pair
  below `MIN_SEPARATION` (forward, then shift-back-and-reopen so the last figure cannot walk
  out of its zone). CV is 0.48 with a hard 24-unit floor. Do not "fix" crowding by shrinking
  `WOBBLE`; widen the zone or drop a row count and let the guard tell you.
- **A zone's figures share ONE comb, not per-row slots.** Rows carry different counts, so
  per-row slot centres coincide at arbitrary zone widths — that is what put two identical
  `st_point` figures **2 units apart**, one a ghost of the other. Replacing it with a
  per-row phase expressed as a FRACTION of the zone then failed the same way in narrow zones:
  the 96-unit robotics zone gave back and mid only 17 units and their heads merged into one
  two-headed shape. The comb makes spacing a property of the zone, so it cannot collapse
  however narrow the zone is. Rows are dealt onto it in seeded random order, because walking
  it back-to-front left-to-right reads as a diagonal rather than a group.
- **Poses are dealt from a shuffled DECK, not picked at random.** Uniform random *with
  replacement* is what produced the twin `st_point`. The deck uses every pose once before any
  repeats and guards the reshuffle boundary, so neighbours are never twins.
- **`used` in `build-scene.cjs` is SORTED.** `<defs>` order otherwise follows first
  encounter, so any reshuffle of the crowd reorders hundreds of KB of path data and buries the
  actual cast change in the diff.
- **Depth comes from `feet`, not height.** Varying only figure height put everyone on one
  ground line and read as a lineup. Back rows have feet *higher* on the canvas, plus an
  opacity fade.
- **Figure heights track the reference film's proportions** — an adult is ~22% of frame
  height, machinery ~60%. Drawing people larger buries the benches and tools behind bodies.
- **The walking machinery still EXISTS but is UNUSED — and it is not wired up.** No instance
  sets `row: 'walk'` (see "No walking crowd"), and `walkRow` in `build-scene.cjs` is built but
  never interpolated into the template, so re-adding a walker instance renders **nothing** until
  that interpolation is restored too. `placeWalker` and `rows.walk` are kept only because the
  three constraints below are expensive to rediscover: `.walker` traverses the full width in
  exactly one master cycle and is OFF-SCREEN at both ends, so the wrap is invisible and the 48s
  loop still closes; negative delays stagger them and half run `walk-left`; and the three nested
  nodes cannot be merged — `.walker` (traverse, and it must own NO transform attribute, since a
  CSS transform would replace it), `.stride` (step bounce, unscaled scene units), `.peep-at`
  (placement attribute). Horizontal position comes entirely from the animation, so the placement
  translate is x=0.
- **`${F}`, `${D}`, `${S}` etc. ARE class attributes**, not fill values. Writing
  `<rect class="belt-item" ${F} …>` emits two `class` attributes on one element; the Vue
  compiler rejects it outright with "Duplicate attribute". Merge them: `class="belt-item fill-cyan"`.
- **`bench(x, y, w)` — `y` is the TABLE TOP**, not the canopy. Passing a canopy Y leaves the
  bench floating in mid-air on 600-unit legs.
- **NEVER write ` -- ` inside an SVG comment.** This codebase uses a double hyphen as an em
  dash all through its prose, and every `<!-- -->` block in `build-scene.cjs` and the scene
  builders is EMITTED into the generated component. A double hyphen inside an XML comment is
  invalid, so the generated SVG could not be parsed by any strict consumer (librsvg, Sharp) —
  browsers and the Vue compiler tolerate it, which is exactly why it went unnoticed in 10
  comments. They are now real em dashes and `HeroScene.server.vue` parses as strict XML; keep
  it that way. Check with:
  `python3 -c "import xml.dom.minidom,re;s=open('app/components/HeroScene.server.vue').read();xml.dom.minidom.parseString(re.sub(r'xlink:','xl_',s[s.index('<svg'):s.rindex('</svg>')+6]))"`
- **A machine's CSS class is not always its own.** `.led` is emitted by the 3D printer AND the
  drone, not only by the LED matrix it is named after — so deleting the rule with the matrix
  would have greyed out the status lights on two surviving machines. The rule carries the red
  `fill` as well as the blink, so it is not merely a motion loss. Before deleting any rule
  during a cut, enumerate what every SURVIVING builder actually emits rather than trusting the
  class name:

  ```
  node -e 'const X=require("./scripts/scene/tech.cjs");
  const all=new Set();
  for (const m of X.printer3d(0,0).matchAll(/class="([^"]+)"/g))
    m[1].split(/\s+/).forEach(c => all.add(c));
  console.log([...all].sort().join(" "))'
  ```

- **`.arm-shoulder` and `.arm-elbow` were MISSING from both motion-suppression lists.** Only
  `.arm-wrist` was listed, so the robot arm's two largest joints kept swinging for
  `prefers-reduced-motion` and no-JS visitors. Fixed. There are **TWO** exhaustive lists in
  `hero-scene.css` — `.hero-stage:not(.is-ready) …` and the `@media (prefers-reduced-motion)`
  block — and they must stay in sync; an animated class missing from either is a silent
  accessibility hole, not a visual bug you would notice.

- **`scene:grounded` has a HARD-CODED selector list.** A new exhibit is not checked for
  floating until its class is added to `sel` in `check-grounded.cjs`. Three new craft exhibits
  were silently unchecked until this was noticed in review. Add new builders to `isolate.cjs`
  too — it is the only tool that shows a part with every neighbour stripped away.
- **A CSS `alternate` animation's real period is DOUBLE its declared duration.** The loom
  shuttle is `8s alternate`, i.e. 16s, and 48/16 = 3. `scene:check` knows this and doubles any
  `alternate` duration before testing it — but if you reason about it by eye, remember the
  factor of two. A one-way translate that resets would close at 48s and still visibly jump at
  every local reset; that is why the shuttle alternates rather than repeating.
- **The preview harness reads hero-scene.css as raw text, so it will NOT catch a CSS syntax
  error.** Only `npm run build` does. After any scripted edit to that file, check brace
  balance or just build.
- **`--paper` is the scene background colour.** Anything filled with it is INVISIBLE — this
  silently erased the sculpture plinth. `.fill-paper` is deliberately a slightly different
  tint (`#DFE2E4`) so solids read as objects rather than holes.
- **Exhibits paint AFTER the seated rows.** What a booth is showing is the point of the
  booth; drawing it in structure order hid every one of them behind a body.
- **Booth canopies sit at stall height** (roof ~y480), with signage above the roof peak.
  Higher and the posts read as stilts; on the valance, the sign lands exactly at head height.
- **Zones have deliberate gaps.** Spreading figures evenly across the full width left no clear
  ground and read as a wall. Density is not the same thing as no air.
- **A CSS `transform` REPLACES an SVG `transform` attribute** rather than composing with it.
  Each figure is therefore two nested groups: `.peep-at` carries placement as an attribute,
  `.peep` carries the animated bob. Collapsing them throws every figure to the origin at
  native scale. `.peep` is also deliberately OUTSIDE the scale: inside it, a 4px bob is
  multiplied by the figure scale (~0.11) and becomes 0.4 units of nothing.
- **There is NO pause control** — removed at the owner's request, along with its `.is-paused`
  CSS. `prefers-reduced-motion` is the only mechanism a *visitor* controls. (The scene also
  suspends itself off-screen — see "The scene suspends off-screen" below — but that is not a
  visitor-controlled mechanism and does not change this entry.) WCAG 2.2.2
  asks for an in-page mechanism for motion that auto-starts and runs past five seconds; that
  is a known, accepted gap. If one is ever restored it must re-list EVERY animated class by
  name, because `animation-play-state` is not inherited and pausing an ancestor pauses nothing.

- **MEASURED runtime cost (after the six-machine cut, 2026-08-29):** **42** running
  animations, down from 112. SVG elements 928 → 598 → 492 → **477**, path data 397k → 186k →
  181k → **116k** chars (19→13 crowd cut, then integer path rounding + one pose cut).
  The earlier contention figures still stand and still say the same thing: main-thread
  contention was 2% / −7.3% / −1.6% / 4% across four runs at 112 animations — negative meaning
  the static run was SLOWER than the animating one, i.e. the cost already sat below the
  measurement floor. Everything except the camera measured 0%. Frame sampling reports 60fps,
  p95 16.7ms, 0% jank, but treat that as weak evidence: rAF is paced to 16.67ms in headless
  regardless of paint cost, so `?contend=1` is the real signal.

  **So the machine cut was NOT a frame-rate fix and must not be described as one.** It was
  asked for as one; the measurement says the animation cost was never the bottleneck. What it
  actually bought is payload and legibility (see the payload table below). Client JS for the
  scene stays 0 KB — verified again after the cut by grepping the built chunks for `fig-st_`
  and `peep-at`: no hits.
- **PERFORMANCE: the camera is the whole bill, and `will-change` on it is the whole fix.**
  Measured with `?contend=1` in the preview harness — a fixed synthetic workload timed with
  the scene animating vs static:

  | | main-thread contention |
  |---|---|
  | before | **8.8%** total (camera 10.5%; the other ~107 animations ≈ 0, i.e. noise) |
  | after `will-change: transform` on `.camera` | **0%**, within noise |

  The camera transforms the ENTIRE scene, forcing a full-viewport repaint of ~390k chars of
  path geometry every frame. Promoting that ONE group to a compositing layer makes it a
  composited transform instead. **Do not blanket-apply `will-change`** — 108 layers, each with
  its own texture, costs far more memory than it saves. Frame-rate sampling in headless is
  useless here (rAF is paced to 16.67ms regardless of paint cost); use the contention harness.
- **Pause/ready classes live on `.hero-stage` in `NetHero.vue`**, not on the scene — a server
  component cannot react to client state. The CSS crosses that boundary via descendant
  selectors in `assets/css/hero-scene.css`.
- **Animation is opted IN via `is-ready`**, which is `mounted && !saveData` — NOT the
  viewport. Off-screen suspension is a separate `is-offscreen` class that PAUSES. Without it, no-JS
  visitors would get motion they cannot stop, which is exactly what WCAG 2.2.2 prohibits.
  See "The scene suspends off-screen" below before changing how it is computed — assigning
  it from any single input has already broken the Save-Data opt-out once.
- **NEVER rotate with a `--pivot` in viewBox coordinates. Use `spinAt()`.**
  `transform-box: view-box` makes `transform-origin: <x>px <y>px` resolve against the
  **viewBox origin**, not the element's local user space. That is fine for a part sitting
  directly in the scene and silently wrong for a part nested inside any translated or scaled
  group — it spins about a point far from its own hub and visibly flies off across the frame.
  This is what caused parts to appear "flying here and there" once the receding background
  row (`bg()`) was added. `spinAt(cx, cy, cls, inner)` in `scene/geometry.cjs` translates the
  pivot to the local origin and rotates about `0 0`, which has no such dependency and is
  correct in both cases. `.joint` only needs `transform-origin: 0 0`. The robot arm's
  shoulder/elbow/wrist use the same pattern.
- **A bare `rotate(deg)` in SVG pivots about the element's LOCAL ORIGIN, not the part.** The
  robot arm's forearm used `rotate(-30)`, which pivoted about the arm's base and flung the
  forearm, wrist and gripper across the frame as three apparently unrelated fragments. Always
  give a centre: `rotate(-30 0 -268)`.
- **Parts must physically ANCHOR into each other, not merely sit near.** The gripper jaws were
  authored 56 units above the wrist block and read as two loose diamonds floating beside the
  arm. Overlap the joint rather than abutting it.
- **Thin outlines vanish; structures need fills.** The wind turbine's tower was a hairline
  triangle, so the rotor looked like it was floating unattached. Filled + outlined now.
- **A translating pattern needs a LEADING element.** The conveyor's four items shifted by one
  gap per cycle, so the rightmost slid off the belt with nothing entering behind it. There are
  now five (one starting off-belt) plus a clip path over the belt run.
- **The camera push-in CROPS the frame edges.** At the peak of the zoom the surviving band is
  about x [64, 1901] — content outside it is cut, which is what made the outermost machines
  (robot arm, cheena vala) look severed. The numbers per zoom level are documented above
  `@keyframes hero-camera`; if you raise the zoom, move those two inboard to match.
- **Every animation period must divide the 48s master cycle** — `npm run scene:check` enforces
  it, and it is wired into `npm run scene`. This is trivially easy to break by eye: a rotor at
  `0.34s` looks identical to one at `0.32s`, but `48/0.34` is not an integer and the loop
  silently stops closing. That exact mistake was caught by the guard.
- **Every `react-peeps` prop value is an exact key.** A miss renders `undefined` as a
  component and throws React #130. Enumerate with `npm run scene:enumerate`.
  `ShortVolumed` and `ShavedSides` *are* real; `CurlyHighTop` is not.
- **Use `WB` pose variants, never `BW`.** `BW` fills the body solid ink; `WB` is outline
  line-art. Solid silhouettes are far too heavy behind white type at `--hero-dim: 0.58`.
- **Poses share no baseline.** Each carries its own internal `translate()` and the stock
  850x1200 viewBox crops at the thighs (real content is ~2930 units tall). `scene:measure`
  asks a browser for `getBBox()` and writes it to `out/figures/manifest.json`; placement
  reads that. Skipping it puts every figure in the wrong place.
- **The loop closes exactly.** Every period divides a 48s master cycle, so frame(0) and
  frame(48s) are the same image — measured at **0.000 RMSE**, against mid-cycle controls of
  0.237/0.268/0.237. This is what replaced the old film's 520ms crossfade. If you retime
  anything, keep it dividing 48s and re-run `scene:verify-loop`.
- **`verify-loop` used to prove the loop over a CROP that excluded the robot arm.** Its
  screenshot window was 1200x675 while `.stage` in `preview.cjs` is **1440x900**, so it
  captured only the stage's top-left. The arm lands at stage x 1177–1503 and the turbine
  beyond it, meaning the three arm joints and the turbine rotor — some of the largest motion in
  the scene — were never in the compared image. The window now matches the stage. If you change
  `.stage`, change `shoot()` in `verify-loop.cjs` to match or the guarantee quietly shrinks.
- **`verify-loop` is INTERMITTENTLY FLAKY. Re-run a failure before believing it.** It reported
  0.0206 RMSE once, then 0.000 on five consecutive runs with no source change in between, and a
  same-frame-twice control was byte-identical. A single FAIL is not evidence; a repeated one
  is. Diagnose a real failure by diffing computed animation state rather than pixels — pin the
  page at both instants and compare `getComputedStyle(el).transform` for every entry in
  `document.getAnimations()`. That distinguishes a genuine phase error from a render artifact
  in one step, and it found nothing wrong here.


### Measured payload, and where the bytes actually are

Re-measured 2026-08-29 after the six-machine cut **and the 19→13 crowd cut**, with
`npm run build` + `node .output/server/index.mjs`:

| | raw | gzip | brotli |
|---|---|---|---|
| SSR HTML (inline scene included) | **173.3 KB** (was 237.6, 248, 483) | **60.4 KB** | **46.9 KB** |

> The 2026-08-31 HIG redesign moved these by **+170 B raw / +76 B gzip / +49 B brotli**
> (+0.10%) and took **191 B off the entry CSS**. That is noise against a 173 KB response,
> which is the point: a visual refactor of five sections is not a payload event. The lever
> is still `POOL`.

| client JS (3 chunks) | 189 KB | 70 KB | — |
| entry CSS | 27 KB | 5.7 KB | — |

Where the saving came from, and it is worth knowing the ratio before optimising this scene
again — the generated component went 444.8 → 217.6 → 207.7 → **143.4 KB**:

| | original | after machine cut | after crowd cut | after rounding + pose cut |
|---|---|---|---|---|
| `<defs>` (unique Open Peeps figures) | 368.7 KB (13 poses) | 159.1 KB (6 poses) | 159.1 KB (6 poses) | **94.8 KB** (5 poses) |
| scene body (every machine, booth, prop, `<use>`) | 74.4 KB | 57.9 KB | 48.6 KB | **48.6 KB** |

**The biggest single win was PRECISION, not content.** Rounding extracted peep coordinates
from 1dp to integers took 46.8 KB off with RMSE 0.0037 — against 0.225–0.251 for frames that
differ visibly. Figures are mapped to ~250 scene units from a ~2930-unit native space, so a
half-unit error lands at ~0.045 units. It applies ONLY to peep markup: machine geometry is in
1920×1080 space where one unit IS visible, and is rounded separately by `r1()`. See
`roundInt` in `extract-peeps.cjs`.

Note what the third column does **not** move: cutting six people saved ~10 KB and left `<defs>`
untouched, because all six poses stay in use. Removing figures is a legibility lever, not a
payload one — the payload lever is still `POOL`.

**The crowd is the payload; the machines never were.** One pose (`si_wheel`, 46 KB) costs more
than every machine in the frame put together. Cutting eleven machines saved ~16 KB; cutting
seven poses saved ~210 KB. Any future "make the hero lighter" work should start at `POOL`.

- **The node server does NOT compress.** `curl -H 'Accept-Encoding: br'` returns the full
  173.3 KB. Compression is the host's job — the deploy target is Netlify/Vercel/Cloudflare,
  which all brotli HTML automatically, so no `h3-compression` dependency was added.
  **A bare-node deploy would be a silent 3.5x regression on the largest response.**
- `public/` went **13MB → 408KB**: every file in it was verified unreferenced by grepping
  each basename against `app/` + `nuxt.config.ts` (0 hits). All of `public/video/`,
  `hero.jpg`, `net-*`, `hero-scene-first.*` and four unused logo variants are gone.
  `hero-scene-still.{avif,webp,jpg}` were kept for a while for an unbuilt Save-Data hero and
  were **deleted on 2026-08-30** — 261 KB deployed on every build and requested by nobody.
  What survives is exactly the files `app/` actually references.
  Note what this did and did not buy: it shrank the **deploy**, not the page. No visitor
  was downloading any of it.
- Google Fonts asks for `Outfit:wght@400;500;600;700`. It used to ask for 300 and 800 as
  well, which nothing in `app/` has ever used. Check before adding a weight back.

### The scene suspends off-screen — and that is NOT a WCAG fix

**Motion has TWO ORTHOGONAL AXES.** Conflating them is what caused a real bug.

    is-ready     = mounted && !saveData      -- is motion ALLOWED at all
    is-offscreen = !inViewport               -- is it CURRENTLY RUNNING

`is-ready` used to include `inViewport`, so scrolling the hero away removed every animation
via `animation: none` — and **a re-added CSS animation restarts at t=0**. Scrolling back
replayed the camera push-in and snapped every gear to its start. Measured before the fix:
the camera clock read 633ms on screen, the animation was ABSENT off screen, and on return it
read 467ms instead of resuming near 1600ms. After: 633ms → frozen at 667ms → resumes at
1150ms.

`npm run scene:resume` is the guard. `node scripts/check-resume.cjs legacy` toggles `is-ready`
instead and must FAIL — that is the pre-fix behaviour, kept so the guard can be shown to
actually detect the defect rather than merely passing.

The off-screen rule therefore PAUSES instead of removing:

    .hero-stage.is-offscreen .hero-scene * { animation-play-state: paused; }

**Its specificity is load-bearing.** It is (0,3,0). Every per-class rule such as
`.hero-scene .cog` is (0,2,0) and declares the `animation` SHORTHAND, which resets
`animation-play-state` to `running` — so any lower-specificity approach, including the
obvious `.hero-scene *` rule driven by an inherited custom property, would **silently never
apply**. It ties at (0,3,0) with the `:not(.is-ready)` block, so it MUST stay after it in
source order. The `prefers-reduced-motion` block's `animation: none !important` still wins,
which is correct.

The wildcard is also why this does NOT duplicate the 15-class list: that list stays the
single authority on WHAT animates; `is-offscreen` only decides whether it runs.

An observer must never be the sole input to whether motion runs — an earlier draft let it
re-enable animation for Save-Data visitors. That is now **structurally** guaranteed, not
merely remembered: the observer drives only `is-offscreen`, which cannot grant motion.

`will-change` on `.camera` is released for BOTH states — a paused animation still holds its
compositor layer otherwise, which defeats the point of suspending.

**Testing this needs a real clock and no reduced-motion.** `--virtual-time-budget` fakes the
very clock being measured, and headless Chrome reports `prefers-reduced-motion: reduce` with
no CLI flag able to override it, so the `!important` block wins and leaves zero animations to
measure. A `play-state` of `running` with NO animation present is indistinguishable from
healthy — `running` is the initial value. Read `document.getAnimations()` currentTime, over
HTTP, with that media block stripped.

**This does not close the WCAG 2.2.2 gap.** There is still no in-page pause control. The
visitor does not control the off-screen suspension, and scrolling back resumes the motion
automatically, which is itself auto-starting motion. `prefers-reduced-motion` remains the
only real accommodation, and the missing control is still a known, accepted gap. Do not let
a future comment claim the observer fixed it.

**The animation cost was never the problem.** Style recalc measures 0.9–1.5ms per 1.6s
window animating vs 0.1ms paused — ~0.06% of the main thread. The synthetic-contention
harness in headless reports the workload running *twice as fast* with animations on,
which is nonsense and confirms the existing warning that headless cannot measure this.
The suspension is battery insurance on real hardware, not a fix for a measured
regression. Do not "optimise" this scene on headless numbers.

### The dates are the content — rank them that way

The date was the *smallest* text in the hero (12.8px/400 at 0.88 opacity) and sat
*underneath* four 52px numerals in the countdown. That is a hierarchy inversion: the
figure that changes every second dominated, and the fact the page exists to communicate
whispered. Both are fixed, and the ranking is the point — not the specific sizes.

- `.countdown-date` is deliberately **`--font-body` 700, not `--font-headline`**. Bungee
  wraps mid-date at 390px and reads shoutier than a date needs to be.
- **A date range needs TWO `<time>` elements.** `<time datetime="2027-02-05T09:00">5 – 6
  February 2027</time>` tells a parser the whole range happens at one instant. `EVENT` in
  `useCountdown.ts` carries `rangeStart`/`rangeEnd`, each with its own ISO date.
- **Event facts live in `EVENT`**, not in templates. They were typed separately into
  `MakerCountdown.vue` and `NetHero.vue`, which is how a date gets corrected in one and
  not the other. `nuxt.config.ts` keeps its own literals — head config is evaluated
  outside the app's module graph and cannot import from there.
- `Event` JSON-LD ships from `MakerCountdown.vue`. Until it did, the dates existed only
  as pixels: invisible to search results, link previews and calendar tools.
- **The event has an END.** `phase` is `upcoming | live | ended`, not a `started`
  boolean — with only a boolean the site said "The Faire is on. Come and see." every day
  from 26 Jan 2027 onward, forever. `started` survives as a derived alias. `tick()` stops
  the interval only at `ended`; stopping at `live` would strand the page mid-faire and it
  would never reach its own closing state. Verified at five simulated instants.
- **The hero date band uses a flat `rgba(0,0,0,.38)`, never `backdrop-filter`.** Blurring
  a 927-element animated SVG behind it is a real per-frame GPU cost and buys nothing the
  flat scrim does not already give.
- **A pill radius cannot hold a wrapped box.** Below 560px both the hero band and
  `.countdown-when` stack to one fact per line and drop their separator dot — left to
  wrap, the pill drew a lopsided stadium with the dot orphaned at the end of line one.
- **`@media (max-height: 560px)` is load-bearing**, not decoration: that is a laptop at
  200% zoom (1440x900 → 720x450). The taller date band pushed the CTAs under the fixed
  nav rail there until the stack was tightened.

### Emphasis is a rank, not a colour you like

The editorial statements — the DOMAIN thesis, "Why Kochi?", the About lead — were all set
at `--color-muted` or in saturated red, i.e. at the emphasis of a caption or at maximum
volume, with nothing in between. Ranking them is what makes them readable.

- `.domain-quote` (the thesis) is `--color-gray-800` at `clamp(1.15rem, 2vw, 1.45rem)`;
  the paragraph after it stays `--color-muted`. Two paragraphs at identical size and
  colour give the reader nothing to hold on to.
- `.lead-text` is ink with a red rule down its left edge, not three lines of saturated
  `--color-red-cta`. Red stays an accent *beside* the words, which is what the palette
  reserves it for.
- **Measure the grey, do not eyeball it — and re-measure when the GROUND moves.**
  `.domain-word` was `#AEB7C0` = **2.03:1**, under even the 3:1 large-text floor, while
  its own comment insisted it must stay readable. It became `#8D959D` = 3.04:1 **on white**.
  It is now **`#828A92` = 3.27:1 on `--bg-grouped` (#F7F7F7)**.

  That last move is the lesson: moving the Domains section onto the grouped ground silently
  dropped the unchanged `#8D959D` to **2.83:1** — back under the floor — because *a contrast
  figure belongs to a PAIR, not to a colour*. Nobody touched the text; the background moved
  and took the measurement with it. Re-measure this pair if the section ground changes again.
  Contrast helper: the WCAG relative-luminance formula, not a vibe.
- `--color-gray-800` (#3A3F45) on white is **10.62:1**, not the ~9.4 an earlier note
  guessed.
- `.stat-yellow` → `.stat-cyan-alt` → **gone entirely**. All four stat cards are one
  treatment now; see "The page is composed as a sequence" below for why the per-card colour
  had to go.

### The page is composed as a SEQUENCE, and the timer closes it

Redesigned 2026-08-31 against Apple HIG, as an *Apple shell around a brand core*: HIG
structure (spacing scale, type ramp, materials, one action colour) wrapped around the
brand-loud Bungee hero. **No copy was changed** — every string, the `domains` array,
`EVENT`, the four stat figures and the trademark notice are byte-identical.

**Section order is `Hero → About → Domains → Countdown → Footer`.** The countdown used to
sit directly under the hero, which already states "26–27 Jan · Kochi, Kerala" — so the page
said the same two facts twice in a row. That reads as a stutter, not as emphasis. The clock
now closes the page, where it is a call to act.

- **The nav `links` order is LOAD-BEARING, not cosmetic.** `recompute()` in
  `MakerHeader.vue` loops the array and keeps *overwriting* `current`, so the **last** link
  whose section has crossed the 40% line wins. Leave `countdown` first and the rail
  highlights "Domains" while the reader is in the countdown. `links`, the page order and the
  footer quick links must all agree.
- **The countdown is ONE segmented control, not four cards.** It was four `flex-wrap` blocks
  with `min-width: 5.25rem`, so at any width that could not seat all four they wrapped into a
  ragged 2×2 with *unequal* cells. It is now one bordered container holding
  `grid-template-columns: repeat(auto-fit, minmax(3.75rem, 1fr))`.

  **`auto-fit` + a rem minimum, NOT `repeat(4, 1fr)`.** A rigid four-column track cannot
  reflow, so at 200% text the cells stay a quarter of the container while the labels inside
  them double — "SECONDS" clips, and clipped is strictly worse than the ragged wrap this
  replaced. Because the minimum is in `rem` it scales with the reader's text size, so the
  track count follows the text: **4 across normally, a clean 2×2 at 150%, one column at
  200%** — always equal cells, never an orphan.

  **3.75rem is derived, not picked.** Narrowest supported viewport is 320px; `.container`
  eats 2 × 1.5rem, leaving 272px; `auto-fit` then seats four columns with ~13px to spare.
  **4.5rem drops 320px to a 3 + 1 orphan** — the exact failure this layout exists to prevent.
  Re-check 320px, 150% and 200% if you touch it.

  Reading labels are 14px now. "MINUTES" and "SECONDS" need about 65px, and four cells at
  320px leave about 54px, so those words clipped. Under 400px the grid uses
  `minmax(8.5rem, 1fr)` instead: two equal columns at normal text, one column at 200%
  because the minimum grows with rem. Leave 3.75rem in place above 400px.

  **The dividers are the 1px grid GAPS**, with the container painting `--separator-on-dark`
  and each cell painting `--color-charcoal` over it. A `border-left` per cell cannot survive
  reflow: the first cell of the second row draws a stray leading rule. Verified at 320/390px
  and at 150%/200% text.

  The date stays the largest fact — that ranking is deliberate and predates this work.
- **Three negative margins are gone.** The countdown stack used `gap: 1.5rem` and then clawed
  three gaps back with `-0.5rem` / `-0.75rem` / `-0.75rem`. That is a gap that was simply the
  wrong size, paid for three times. It is `gap: 0` plus graduated per-child margins.
- **The hero stack is graduated, not uniform.** `gap: 1.25rem` gave logo, headline, subtitle,
  date band and two buttons *equal* separation — equal spacing is the absence of hierarchy.
  The logo also dropped from `clamp(210px, 24vw, 320px)` to `clamp(150px, 17vw, 220px)`: a
  320px mark directly above an H1 naming the same brand competes with the sentence it
  introduces (HIG Branding: "branding always defers to content").
- **Grounds now step: white (About) → `--bg-grouped` (Domains) → ink (Countdown) →
  charcoal (Footer).** Two consequences that are easy to miss:
  - Domain chips flipped from `--color-surface` to white. `#F3F3F3` on a `#F7F7F7` ground is
    a 1% difference, i.e. invisible.
  - The footer moved ink → charcoal, which **erased two elements that were themselves
    charcoal**: the social chips and the newsletter input. Both are `--color-ink` now (ink is
    the *lighter* of the two). Check for this whenever a dark ground changes.
- **`--color-red` is size-dependent and that bit the footer.** `.footer-logo .colon` was
  `--color-red`, which measures **3.76:1** on charcoal — passing *only* because that line
  happens to be 24px, i.e. WCAG large text. It is `--color-red-on-dark` (5.40:1) now, which
  passes on its own merits. CLAUDE.md already designated that token; the footer just wasn't
  using it.
- **The secondary button is no longer cyan.** A cyan fill beside the red primary made two
  brand colours both mean "this is an action". Light grounds get a neutral
  `.btn-maker-secondary`; the hero gets `.btn-maker-on-dark`.

  **`.btn-maker-on-dark` is `rgba(0,0,0,0.55)` and the alpha is a measurement, not a mood.**
  The obvious choice — a translucent *white* veil — cannot be verified at all, because it
  LIGHTENS whatever the animated scene puts behind it. A **black** veil has a provable worst
  case: the lightest thing the scene can present is white, `rgba(0,0,0,.55)` over `#FFFFFF`
  composites to `#737373`, and white on `#737373` is **4.74:1**. That is a floor holding for
  every frame. Do not raise the transparency to show more artwork: 0.45 gives 3.36:1 and
  0.38 gives 2.68:1, both failing.
- **Stat cards were flattened.** They previously differed *only* by a 3px coloured top border
  while all four numerals were already ink — colour drawing a distinction that meant nothing,
  and spending the accent palette to do it. They also had a hover lift, which is a false
  affordance on something that is not interactive.
- **`h1..h6` no longer carries `text-transform: uppercase`, but it DOES still carry
  `font-family: var(--font-headline)`.** Removing the whole rule silently drops several
  headings to Outfit, because they set no local font-family. Display headings opt in with
  `.display-type`; body-level subheads use `.subhead` (Outfit 600, sentence case).
- **The newsletter input had NO label at all** — placeholder only, which is a real WCAG
  failure rather than a stylistic gap. It now has `id="newsletter-email"` bound to a
  `.visually-hidden` label, plus `autocomplete="email"`. `.visually-hidden` is the clip
  pattern extracted out of `.skip-link`, which now shares it.
- **`--rail-h` is 58px, not 56px.** The rail's real footprint is a 44px pill + 2×6px padding
  + 2×1px border. It is a `min-height`, so the rail was never clipped — but all three
  clearances built on it (root `scroll-padding-bottom`, hero bottom padding, footer bottom
  padding) were 2px short.
- **`@lucide/vue` ships NO brand icons.** `Twitter`, `Instagram` and `Youtube` are simply not
  exported (verified against the installed 1.33.0 declarations). The footer's `X` / `IG` /
  `YT` text glyphs stay for that reason; they are sized to 44px targets instead.
- **The nav rail deliberately stayed at the BOTTOM on every width.** Moving it to a top
  capsule on desktop was planned and then dropped: HIG's "avoid controls at the bottom of a
  window" targets *draggable desktop app windows*, not a fixed browser viewport, and the move
  needed a breakpoint-aware keyboard state machine, `env(safe-area-inset-top)`, a
  scroll-padding switch and a hero z-index fix to be safe. Not worth it; the rail works.
- Deleted as unused (each grepped to zero hits first): `.card-maker`, `.badge-maker*`,
  `.animate-spin-slow`, `.animate-float`, `--shadow-maker*`, `--color-gray-100/200`,
  `--border-width-thin/thick`.

**Verification for this kind of change** (there is still no test runner):
`npm run build` is the ONLY thing that catches a CSS syntax error. Then serve and check
DOM order, that every `a[href^="#"]` resolves (scope it to `a` — a bare selector also
matches the hero scene's 12 inline SVG `<use href="#fig-…">`), that the built client chunks
contain no `fig-st_` or `peep-at`, and re-measure every contrast pair whose *foreground or
background* moved. **Kill stray `node .output/server/index.mjs` processes between runs** — a
survivor holds the port, the new server dies with `EADDRINUSE`, and curl silently measures
the OLD build. That cost a full false "the reorder did not apply" diagnosis here.

### Real data, and what was fake before it

Audited and replaced 2026-08-31, on the owner's answers. Every one of these had shipped as a
plausible-looking invention.

| Was | Now |
|---|---|
| `forms.gle/makerfairekochi2027` in **5 places** | **CTAs removed.** The link did not exist. |
| `twitter.com/makerfaire`, `instagram.com/makerfaire`, `youtube.com/makerfaire` | Instagram `makerfairekochi` + a mail link. The old three were the **global Make Community** accounts. |
| Newsletter form | **Removed.** |
| No contact anywhere | `makerfairekochi@gmail.com` |
| `siteUrl` falling back to `''` | `https://makerfaire.in` |
| Venue implied by "Kochi, Kerala" | `EVENT.venueLabel` — "Venue to be announced", stated |
| No ticket info | `EVENT.admissionLabel` — "Free entry", plus a schema.org `Offer` |
| Footer logo **typeset in Bungee** | The real `mf-kochi-long` asset |

- **The newsletter was a no-op, not merely unwired.** `handleSubscribe` set a flag, cleared the
  field, showed "You're on the list", and reset after five seconds. There was no endpoint and no
  storage — **every address typed into it was silently discarded.** Removing it was the honest
  outcome. If it returns, it needs a provider AND the rail's keyboard avoidance back.
- **A dead primary CTA is worse than no primary CTA.** The five proposal buttons pointed at a
  `forms.gle` link that did not exist, so they were removed rather than pointed at a guess. They
  now point at the real `/interestform` (see "Interest form and admin" below). The rule stands:
  never ship a CTA to a destination that is not live.

- **`@lucide/vue` ships no brand icons** — `Instagram`, `Twitter`, `Youtube` are not exported
  (verified against the installed 1.33.0 declarations). The Instagram glyph is therefore an
  **inline SVG**; `Mail` beside it is a Lucide icon, so the two match in stroke weight. The old
  `X` / `IG` / `YT` were literal text in boxes and looked exactly like the placeholders they were.
- **`siteUrl` is the LAST link in the env chain, on purpose.** `URL` / `CF_PAGES_URL` /
  `VERCEL_URL` still win, so Netlify, Cloudflare Pages and Vercel **preview** deploys keep
  describing themselves correctly; only a build with none of them set — production, or
  `nuxt generate` locally — falls through to `https://makerfaire.in`. That is what stopped
  og:image baking as `http://localhost/img/logo/...`.
- **`offers` is not decoration in the JSON-LD.** Google generally will not render an event rich
  result without it, and free is expressed as `price: '0'` — omitting `offers` reads as
  *unknown*, not *free*. `url`, `image` and `organizer` were added at the same time for the same
  reason. `location.name` is `EVENT.venueLabel`; swap in the venue and add
  `streetAddress`/`postalCode`/`geo` the moment it exists.
- **Do not TYPESET the logo.** The footer rendered the mark as
  `Make<span class="colon">:</span> Maker Faire <span class="location">Kochi</span>` — a
  licensed trademark redrawn in the wrong typeface, with a hand-picked red colon and cyan city,
  which drifted from the official mark every time anyone touched the CSS. It is the
  `mf-kochi-long` asset now, in the same `<picture>` pattern as the hero (webp 1x/2x, PNG
  fallback), `loading="lazy"` because it is below the fold.

  The asset is **not transparent** — it carries its own white plaque and cyan frame (corner
  pixel is `#00AEEF`, mean alpha 0.999). That is why it needs no colour handling on the dark
  ground, and it is also why the whole `--color-red` vs `--color-red-on-dark` question the
  typeset version raised disappears with it. Do not "remove the white box": the plaque is
  part of the licensed lockup.

- **A `border-bottom` is not an underline on a 44px target.** The contact email is
  `display: inline-flex` with a `min-height: 44px` hit area; a border sits at the bottom of the
  *box*, so it detached and floated well below the address. `text-decoration: underline` with
  `text-underline-offset` hugs the glyphs however tall the target is.

### Still true regardless of the hero

- **The nav rail's keyboard avoidance was REMOVED, and must return with any form.** There is
  no `<input>`, `<textarea>` or contenteditable anywhere on the site any more (the newsletter
  is gone), so the code was unreachable. The lesson it encoded is still true and is preserved
  as a comment in `MakerHeader.vue`: on a phone the on-screen keyboard pins a fixed bottom rail
  directly over the field being typed in, so the rail must hide — and it must key off
  `visualViewport`, **not** `focusin`/`focusout`. Focus tracking looks simpler and is broken:
  removing a focused element (a `v-if` on submit, say) does not reliably fire `focusout`, so
  the rail stays hidden forever, taking the site's only navigation with it. Guard it with an
  `activeElement` check so a pinch zoom, which also shrinks the visual viewport, does not hide
  the nav.
- **`IntersectionObserver` `rootMargin` percentages resolve against WIDTH**, including top/bottom.
  `-40% 0px -60% 0px` is a negative-height root on a landscape viewport and never fires. Active
  section tracking uses a rAF-throttled scroll listener instead.
- **`viewport-fit=cover` must stay** in the viewport meta or every `env(safe-area-inset-*)`
  resolves to 0 and the rail collides with the iOS home indicator.
- **og:image is built from `useRequestURL()`** in `app.vue`, not hardcoded, so it stays correct on
  preview deploys and behind a CDN. Scrapers drop relative image URLs.
- **`app/components/hero/NetHero.vue` auto-imports as `HeroNetHero`** (Nuxt `pathPrefix`).
  `app.vue` imports it explicitly instead.

### Interest form and admin

`/interestform` (public, SSR) and `/admin` (owner-only, `ssr: false`). Code lives in
`app/modules/interest`, `app/modules/admin`, `shared/interest` and `server/`. Setup is in
`supabase/README.md`. Validation smoke test: `npm run test:interest`.

- **`/admin` is ONE account, on purpose.** There was an organizer sign-up + owner-approval flow;
  it was deleted on the owner's instruction. The owner is created manually in Supabase Auth with
  email + password; public sign-ups stay OFF. The app never stores or receives the password
  outside `supabase.auth.signInWithPassword`.
- **Never put the owner email in `runtimeConfig.public`.** Public config is serialized into the
  HTML of every page, homepage included. It was there once; verify with
  `curl -s localhost:3000/ | grep -c <owner email>` → 0.
- **One owner means one UUID, not everyone with a role string.** `GET /api/admin/session`
  validates the authenticated email against server-only config, then binds that Auth UUID. RLS calls
  `private.is_admin_owner()`, which compares `auth.uid()` to the singleton `admin_owner` row.
  On owner rotation, the server rejects the old email immediately; the new owner's first login
  moves the binding and invalidates the old live JWT's direct database access.
- **Updates may change `status` and nothing else** — enforced by a trigger comparing
  `to_jsonb(new) - 'status'` with `old`, so new columns are covered automatically.
- **Text caps live in TWO places that must agree:** `MAX_LEN` in `shared/interest/validate.ts`
  and the `interest_responses_len_caps` CHECK in `20260924160000_single_owner.sql`.
- **Answers from hidden sections are dropped server-side.** Tick "exhibit", type a project,
  untick it: the browser still holds the text. `validateInterestInput` nulls it.
- **CSV export prefixes `= + - @` with `'`.** The cells are public input; unescaped they run as
  formulas when the owner opens the file.
- **Dashboard days are the VIEWER's local calendar day.** `toISOString().slice(0, 10)` is UTC and
  files anything 00:00–05:29 IST under yesterday.
- **The dashboard pages through results.** PostgREST returns at most 1000 rows per request, so a
  single `select('*')` would silently truncate every chart past 1000 responses.
- **Rate limits do not read `x-forwarded-for`** — its first entry is client-supplied. They use the
  host-set `x-nf-client-connection-ip` / `cf-connecting-ip` / `x-real-ip`. They are in-memory
  per instance, so serverless cold starts reset them; good enough for a v1 interest form.
- **Request limits are STREAMING limits.** `Content-Length` can be omitted on a chunked request,
  so checking that header alone is not a body cap. `readJsonBodyLimited` counts incoming bytes
  and cancels the form reader at the 64 KB ceiling.

## Still open

**Waiting on the owner (the site ships correct-but-incomplete until these land):**

- **X and YouTube handles** — footer currently shows Instagram + email only.
- **Registration.** `/interestform` gathers interest only; tickets / exhibitor registration are
  a separate, later flow and must not reuse `interest_responses`.
- **The venue.** Then update `EVENT.venueLabel` and the JSON-LD `Place` (street, pincode, geo).
- **A 1200x630 share image.** `twitter:card` is `summary_large_image`, which expects ~1.91:1,
  but `og:image` is the **512x512 square** logo — previews crop badly or downgrade.
- **A sitemap.** `robots.txt` allows everything and declares no `Sitemap:`; none exists.

**Engineering:**

- Real-device iOS pass: safe area, 200% zoom, forced-colors. (Keyboard is moot — no inputs.)
- LCP measurement on throttled 4G. The scene is inline SSR so it costs no extra request,
  but inline SVG is **not** an LCP candidate — the Bungee headline almost certainly is.
- Portrait crops to the middle ~500 scene units, which shows the bench crowd and the
  flywheel but loses the cheena vala. Acceptable, not ideal; a portrait-specific crop
  would need a second composition.
- **Save-Data visitors still download the whole scene.** `Save-Data` suppresses the
  *animation*, not the ~143KB of inline SVG — so the visitor who asked to save data saves
  none. The fix is a static-image hero for that request. The three stills it would have used
  were **deleted on 2026-08-30** (261 KB, deployed and never requested), so building it now
  means re-rendering them first: `scripts/preview.cjs` plus a headless screenshot, then
  encode to avif/webp/jpg.
- `remotion/src/PeepsTest.tsx` and its `<Composition>` in `Root.tsx` are the original
  feasibility probe and can go.
- Dark mode ("Night catch") is designed in `docs/net-hero-experience.md` but not built.

## Docs

- `docs/openpeeps-hero-plan.md` — the Open Peeps feasibility study this scene came from
- `docs/pill-nav-hero-plan.md` — the earlier build, incl. the original contrast audit
- `docs/net-hero-experience.md` — original hero concept and tokens
- `docs/net-film-remotion-plan.md` — how the superseded film was produced
