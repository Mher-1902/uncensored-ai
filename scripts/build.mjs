import {build} from 'vite';
import {readFile,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
const siteOrigin=new URL(process.env.SITE_ORIGIN||'https://offscript-ephemeral.sukiasyanmher7.chatgpt.site').origin;
await build();
await build({build:{ssr:'src/entry-server.tsx',outDir:'.runtime/prerender',emptyOutDir:true}});
{
  const {render}=await import(pathToFileURL(resolve('.runtime/prerender/entry-server.js')).href);
  let html=await readFile('dist/index.html','utf8');
  html=html.replace('<div id="root"></div>',`<div id="root">${render()}</div>`).replaceAll('__SITE_ORIGIN__',siteOrigin);
  await writeFile('dist/index.html',html);
  await writeFile('dist/sitemap.xml',`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${siteOrigin}/</loc></url></urlset>\n`);
  await writeFile('dist/robots.txt',`User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: ${siteOrigin}/sitemap.xml\n`);
  // A configured public API origin needs both browser permission and server CORS.
  const apiBase=process.env.SITE_API_BASE||JSON.parse(await readFile('dist/config.json','utf8')).apiBase;
  if(apiBase){
    const url=new URL(apiBase);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw Error('SITE_API_BASE must be a plain HTTPS API base URL.');
    const config=JSON.parse(await readFile('dist/config.json','utf8'));config.apiBase=url.href.replace(/\/$/,'');
    await writeFile('dist/config.json',JSON.stringify(config)+'\n');
    const headers=await readFile('dist/_headers','utf8');await writeFile('dist/_headers',headers.replace("connect-src 'self'",`connect-src 'self' ${url.origin}`));
  }
}
