import {defineConfig} from 'vite';

// Only this local research page needs WASM/blob workers and model downloads.
// Do not relax the deployed site's CSP or OAuth isolation headers.
export const prototypeHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self' ws://127.0.0.1:5186 https://huggingface.co https://*.hf.co; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
};
export default defineConfig({
  server: {host:'127.0.0.1',port:5186,strictPort:true,headers:prototypeHeaders},
  preview: {host:'127.0.0.1',port:5186,strictPort:true,headers:prototypeHeaders},
  build: {target:'es2022'},
});
