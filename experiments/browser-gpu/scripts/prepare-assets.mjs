import {readFile,mkdir,copyFile} from 'node:fs/promises';
const base=new URL('../',import.meta.url);
const dependency=new URL('node_modules/@wllama/wllama/',base);
const pkg=JSON.parse(await readFile(new URL('package.json',dependency),'utf8'));
if(pkg.version!=='3.8.1')throw Error('The reviewed browser runtime version is required.');
await mkdir(new URL('public/runtime/',base),{recursive:true});
await copyFile(new URL('esm/wasm/wllama.wasm',dependency),new URL('public/runtime/wllama.wasm',base));
await copyFile(new URL('LICENCE',dependency),new URL('public/runtime/WLLAMA-LICENCE.txt',base));
console.log('Prepared self-hosted WASM asset; no model download or execution.');
