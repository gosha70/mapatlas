// SPDX-License-Identifier: Apache-2.0

/**
 * A consumer's Next.js configuration, and deliberately an empty one.
 *
 * Nothing here transpiles, aliases or externalises `@mapatlas/*`: the claim this fixture exists
 * to test is that the packed packages work in a stock Next 14 App Router project, and every
 * option added here would be a workaround a real consumer would also have to discover.
 *
 * Lint is skipped during `next build` only because this project installs no ESLint — the
 * repository's own `npm run lint` already covers these files.
 *
 * @type {import("next").NextConfig}
 */
const config = {
  eslint: { ignoreDuringBuilds: true },
};

export default config;
