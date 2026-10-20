import {build} from 'vite';
import {readFile,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
const defaultOrigin='https://offscript-ai.vercel.app';
const siteOrigin=new URL(process.env.SITE_ORIGIN||defaultOrigin).origin;
await build();
await build({build:{ssr:'src/entry-server.tsx',outDir:'.runtime/prerender',emptyOutDir:true}});
{
  const {render,renderPrivacy,renderCookies}=await import(pathToFileURL(resolve('.runtime/prerender/entry-server.js')).href);
  let html=await readFile('dist/index.html','utf8');
  html=html.replace('<div id="root"></div>',`<div id="root">${render()}</div>`).replaceAll('__SITE_ORIGIN__',siteOrigin);
  await writeFile('dist/index.html',html);
  await writeFile('dist/privacy.html',renderPrivacy().replaceAll('__SITE_ORIGIN__',siteOrigin));
  await writeFile('dist/cookies.html',renderCookies().replaceAll('__SITE_ORIGIN__',siteOrigin));
  const xmlOrigin=siteOrigin.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
  await writeFile('dist/sitemap.xml',(await readFile('public/sitemap.xml','utf8')).replaceAll('__SITE_ORIGIN__',xmlOrigin));
  await writeFile('dist/robots.txt',(await readFile('public/robots.txt','utf8')).replaceAll('__SITE_ORIGIN__',siteOrigin));
  // A configured public API origin needs both browser permission and server CORS.
  const apiBase=process.env.SITE_API_BASE||JSON.parse(await readFile('dist/config.json','utf8')).apiBase;
  if(apiBase){
    const url=apiBase==='/api'?new URL(apiBase,siteOrigin):new URL(apiBase);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw Error('SITE_API_BASE must be /api or a plain HTTPS API base URL.');
    const config=JSON.parse(await readFile('dist/config.json','utf8'));config.apiBase=apiBase==='/api'?'/api':url.href.replace(/\/$/,'');
    await writeFile('dist/config.json',JSON.stringify(config)+'\n');
    if(apiBase!=='/api'){const headers=await readFile('dist/_headers','utf8');await writeFile('dist/_headers',headers.replace("connect-src 'self'",`connect-src 'self' ${url.origin}`));}
  }
}
