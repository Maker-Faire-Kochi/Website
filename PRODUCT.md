# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
Two audiences served equally by the homepage (confirmed 2026-10-22):
- **Makers across Kerala** deciding whether to show a project, run a workshop or take part — in Fab Labs, tinkering labs, campus chapters, startups and home workshops, across technical and non-technical crafts (wood, thread, clay, coir, food as much as electronics). Their job: understand what a Maker Faire is and register interest.
- **Visitors and families** deciding whether to come on 5–6 February 2027. Their job: understand what the event is, when and where, and that entry is free.
Secondary: volunteers (media team via `/volunteer`), the owner using `/admin`.

## Product Purpose
The public site for Maker Faire Kochi 2027, Kerala's first licensed Maker Faire: announce the event, explain what a Maker Faire is, and route makers to the interest form (`/interestform`) and volunteers to `/volunteer`. Success: visitors leave knowing what, when and where; makers act on Get Involved.

## Positioning
The first licensed Maker Faire in Kerala, built collectively by TinkerHub Foundation, MakerGram and Kerala Startup Mission, rooted in local making — the cheena vala as "the world's longest-running open hardware project", coir, boats, nets and rope alongside robotics and electronics.

## Operating Context
A single landing page of sheets (Hero, About, Domains, Noise, When, footer) with live, interactive three.js drawings; an interest form, a volunteer form, an owner-only admin dashboard, a themed 404. Nuxt 4, SSR, deployed to a static/edge host.

## Capabilities and Constraints
- Event facts live in `EVENT` (`app/composables/useCountdown.ts`): 5–6 February 2027, The Grounds @ Chakola Mill, Kochi, Kerala (map: https://maps.app.goo.gl/2oxa6AnE5HrnsaJ17); gates 9:00 AM IST; free entry. Never type them elsewhere; never invent new ones.
- Interest form gathers interest only; ticketing/exhibitor registration is a later, separate flow.
- Contact: makerfairekochi@gmail.com; Instagram `makerfairekochi`. No X/YouTube handles yet.
- Every 3D drawing must keep: poster fallback, reduced-motion / Save-Data / no-WebGL paths, keyboard equivalents, the Pause key, measured contrast (text always on paper).
- Undecided: a 1200×630 share image; a sitemap.

## Brand Commitments
- The supplied Maker Faire Kochi logo, intact (white plaque, cyan frame); never retypeset.
- Visual language (owner, 2026-10-22): a mix of the Make Some Noise campaign and the Maker Faire Kochi guidelines (`../maker-faire-kochi`): Dela Gothic One headlines + Inter text (+ Noto Sans Malayalam); paper/ink base with campaign warm yellow #FFE86C and electric blue #2B19D9 as whole-section fields; Maker red for the primary action, cyan structural only. 3D figures keep the straight slotted-beam hairline drawing language; curved playful beams rejected. The Make Some Noise line and NOISE-as-signal idea are user-selected. People appear only where making happens (never in the hero).
- Voice: plain, direct, generous ("A festival of invention, creativity and hands-on learning"); no hype.

## Evidence on Hand
Global network figures in About (200+ licensed faires, 40+ countries, 30+ featured a year, since 2006); organisers; the domain list. No testimonials, sponsors, speaker line-up, exhibitor list or attendance figures for Kochi exist — do not fabricate any.

## Product Principles
1. Facts first, then delight: the date, place, admission and what a Maker Faire is must be readable without any animation.
2. Making is broader than technology: every section gives craft equal standing with electronics.
3. Show, don't claim: interactive drawings of real making stand in for the photos and proof the event does not have yet.
4. Nothing is lost: redesigns keep every existing fact and string unless the owner removes it.

## Accessibility & Inclusion
WCAG 2.2 AA: measured contrast (`npm run test:contrast`), a Pause key for all motion, reduced-motion paths, keyboard equivalents for every pointer interaction, Malayalam script support.
