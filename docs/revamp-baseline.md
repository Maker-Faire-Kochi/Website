# Revamp baseline (M0)

Measured 2026-10-22 on `feature/revamp` at 5bfd78c (identical to `origin/dev`), before any revamp change.
Production build (`npm run build`, `node .output/server/index.mjs`), Windows 11, Chrome stable, Lighthouse 12
mobile preset with simulated throttling, median of 3 runs. Later milestones compare against these numbers.

| Metric | Baseline |
|---|---|
| Home initial JS (gzip -9, all `/_nuxt/*.js` referenced by `/`) | 102,154 B |
| Home initial CSS (gzip) | 4,800 B |
| Home HTML (gzip) | 20,244 B |
| All built client JS+CSS (gzip) | 195,172 B |
| Web fonts transferred on first view | 120,448 B, 4 files (Google Fonts: Archivo, IBM Plex Mono; Bungee/Outfit/Space Grotesk requested but unused on first view) |
| LCP | 4,514 ms (LCP element: hero logo `mf-kochi-long@2x.webp`) |
| CLS | 0.000 |
| TBT | 0 ms |
| Lighthouse performance score | 70 |
| Hero frame time p95 (4x CPU throttle) | Not measured yet; captured with the Playwright harness added in M2 against this same commit |

Checks passing at baseline: `npm run build`, `npm run test:interest`, `npm run test:volunteer`.
