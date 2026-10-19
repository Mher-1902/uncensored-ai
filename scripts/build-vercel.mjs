import {readFile, writeFile} from 'node:fs/promises';

// Bindings are intentionally not read here. Browser requests use the app's own /api functions.
process.env.SITE_API_BASE = '/api';
if (!process.env.SITE_ORIGIN && process.env.VERCEL_PROJECT_PRODUCTION_URL) {
  process.env.SITE_ORIGIN = `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
}
if (process.env.VERCEL_ENV === 'production' && !process.env.SITE_ORIGIN) {
  throw Error('Set SITE_ORIGIN to the final HTTPS homepage before a production deployment.');
}
await import('./build.mjs');
const config = JSON.parse(await readFile('dist/config.json', 'utf8'));
config.space = null;
await writeFile('dist/config.json', `${JSON.stringify(config)}\n`);
// Preview/local copies should not compete with the canonical production homepage.
if (process.env.VERCEL_ENV !== 'production') {
  await writeFile('dist/robots.txt', 'User-agent: *\nDisallow: /\n');
  const html = await readFile('dist/index.html', 'utf8');
  await writeFile('dist/index.html', html.replace('</head>', '<meta name="robots" content="noindex, nofollow"></head>'));
}
