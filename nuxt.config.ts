// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },
  css: ['~/assets/css/main.css'],

  // The hero scene is a server component: ~400KB of SVG path data that must be
  // sent once in the SSR HTML and never again in the client bundle.
  experimental: { componentIslands: true },

  hooks: {
    /**
     * No prefetch hints for three.js or any scene chunk. SceneSlot imports them
     * only when a slot nears the viewport AND motion, Save-Data and WebGL allow
     * it; an idle-time <link rel=prefetch> would still download ~150 KB for
     * exactly the visitors (Save-Data, reduced motion) who will never run it.
     */
    'build:manifest'(manifest) {
      // Keys are relative to app/ ("three/core/stage.ts"); three.js itself lands
      // in a shared chunk ("_abc123.js") those entries import. Clearing prefetch
      // on everything they reach is safe: it only drops idle-time hints, and a
      // chunk the page needs up front is still modulepreloaded.
      const seen = new Set<string>()
      const off = (key: string) => {
        const chunk = manifest[key]
        if (!chunk || seen.has(key)) return
        seen.add(key)
        chunk.prefetch = false
        chunk.imports?.forEach(off)
      }
      Object.keys(manifest).filter(k => /^(app\/)?three\//.test(k)).forEach(off)
    },
  },

  /**
   * Admin is owner-only. SPA mode so the lock middleware always runs in
   * the browser before any dashboard HTML is painted (no SSR leak of shell).
   */
  routeRules: {
    '/admin': { ssr: false },
    '/admin/**': { ssr: false },
  },

  runtimeConfig: {
    supabaseServiceRoleKey: process.env.NUXT_SUPABASE_SERVICE_ROLE_KEY || '',
    /**
     * The one account allowed into /admin. Server-only on purpose: anything
     * under `public` is serialized into the HTML of every page, homepage included.
     */
    adminOwnerEmail: process.env.NUXT_ADMIN_OWNER_EMAIL || '',
    /**
     * Confirmation mail via Brevo HTTP API (not SMTP — Workers cannot open
     * SMTP sockets). Leave the key empty to skip sending.
     */
    brevoApiKey: process.env.NUXT_BREVO_API_KEY || '',
    mailFrom: process.env.NUXT_MAIL_FROM || '',
    mailReplyTo: process.env.NUXT_MAIL_REPLY_TO || '',
    public: {
      supabaseUrl: process.env.NUXT_PUBLIC_SUPABASE_URL || '',
      supabaseAnonKey: process.env.NUXT_PUBLIC_SUPABASE_ANON_KEY || '',
      /**
       * Public origin for social metadata.
       *
       * `useRequestURL()` in app.vue is correct under SSR, but `nuxt generate`
       * has NO request — it resolved to `http://localhost` and baked
       * `http://localhost/img/logo/...` into og:image and twitter:image, so
       * every share of a statically generated deploy had a broken preview.
       * Verified by grepping the generated index.html.
       *
       * Left empty by default so SSR keeps deriving the origin per request
       * (which survives a proxy or CDN). The three host variables below are
       * provided automatically by Netlify, Cloudflare Pages and Vercel
       * respectively, so a static deploy on any of them is correct with no
       * configuration; set NUXT_PUBLIC_SITE_URL to override.
       */
      siteUrl:
        process.env.NUXT_PUBLIC_SITE_URL ||
        process.env.URL ||
        process.env.CF_PAGES_URL ||
        (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '') ||
        /**
         * Production origin, and the LAST link in the chain on purpose. The three
         * host variables above are set by Netlify / Cloudflare Pages / Vercel on
         * preview deploys, so a preview still describes itself correctly; only a
         * build with none of them set -- i.e. production, or `nuxt generate`
         * locally -- falls through to here. That is what stopped og:image being
         * baked as `http://localhost/img/logo/...` on a static deploy.
         */
        'https://makerfaire.in',
    },
  },
  app: {
    head: {
      title: 'Maker Faire Kochi 2027',
      meta: [
        { charset: 'utf-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover' },
        { name: 'theme-color', content: '#F6F6F3' },
        { name: 'description', content: 'Maker Faire Kochi 2027 is Kerala’s first licensed Maker Faire, 5 and 6 February 2027 at The Grounds @ Chakola Mill, Kochi. Built together by TinkerHub Foundation, MakerGram and Kerala Startup Mission.' },
        { property: 'og:title', content: 'Maker Faire Kochi 2027' },
        { property: 'og:description', content: 'Where are the makers? Kerala’s first licensed Maker Faire comes to Kochi on 5 and 6 February 2027. Built together by TinkerHub Foundation, MakerGram and Kerala Startup Mission.' },
        { property: 'og:type', content: 'website' },
        { name: 'twitter:card', content: 'summary_large_image' },
        { name: 'twitter:title', content: 'Maker Faire Kochi 2027' },
        { name: 'twitter:description', content: 'Where are the makers? Kerala’s first licensed Maker Faire. Kochi, 5–6 February 2027. Built together by TinkerHub Foundation, MakerGram and KSUM.' }
      ],
      link: [
        { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
        { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' },
        // The Google Fonts stylesheet itself is added by server/plugins/fonts.ts,
        // outside unhead, so it can load without blocking render.
        { rel: 'apple-touch-icon', href: '/img/logo/apple-touch-icon.png' },
        // Browsers still request /favicon.ico even when a PNG is declared, so that
        // file has to be the Kochi mark. The previous ico was the Nuxt starter.
        { rel: 'icon', type: 'image/png', href: '/favicon-32.png', sizes: '32x32' },
        { rel: 'icon', href: '/favicon.ico', sizes: '48x48' },
        { rel: 'icon', type: 'image/png', href: '/img/logo/mf-kochi-square-512.png', sizes: '512x512' }
      ]
    }
  }
})
