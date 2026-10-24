# Nuxt Minimal Starter
Build for makerfaire kochi

## Microsoft Clarity

Set `NUXT_PUBLIC_CLARITY_PROJECT_ID=z2fgjxhxv5` in `.env` locally and in the
production hosting environment. The ID is public configuration, not a secret.
Leaving it empty disables tracking. The script loads once, after hydration and an idle
turn, and is disabled in development and on direct visits to `/admin` or `/lab`.
Application forms and the admin layout carry explicit content masking.

On Cloudflare, add that exact variable to the **Production** environment and make
it available to the build, then trigger a new deployment. Adding a variable does
not change an existing deployment. Nuxt reads the ID at build time as well as
accepting a matching runtime override, so builds keep the ID even when Cloudflare
does not expose build variables to the running Worker. Configure Preview separately
if those deployments should also collect analytics.

Verify production in browser Network tools: the project tag should load from
`https://www.clarity.ms/tag/z2fgjxhxv5`, followed by Clarity collection requests.
Use Clarity's consent settings or your consent manager for cookie consent.
Clarity records the page and interactions but cannot replay the inside of the
WebGL canvas; the 3D animation continues to run normally.
See [Microsoft's setup guide](https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-setup)
and [content masking documentation](https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-masking).

Look at the [Nuxt documentation](https://nuxt.com/docs/getting-started/introduction) to learn more.

## Setup

Make sure to install dependencies:

```bash
# npm
npm install

# pnpm
pnpm install

# yarn
yarn install

# bun
bun install
```

## Development Server

Start the development server on `http://localhost:3000`:

```bash
# npm
npm run dev

# pnpm
pnpm dev

# yarn
yarn dev

# bun
bun run dev
```

## Production

Build the application for production:

```bash
# npm
npm run build

# pnpm
pnpm build

# yarn
yarn build

# bun
bun run build
```

Locally preview production build:

```bash
# npm
npm run preview

# pnpm
pnpm preview

# yarn
yarn preview

# bun
bun run preview
```

Check out the [deployment documentation](https://nuxt.com/docs/getting-started/deployment) for more information.
