/* Cortes do Treino: deixa o app abrir sem internet e recebe vídeos do "Compartilhar" da galeria */
const VERSAO = 'cortes-v1';
const COMPARTILHADOS = 'cortes-compartilhados';
const BASICOS = [
  './', 'index.html', 'app.css', 'app.js', 'vendor/mp4-muxer.min.js', 'manifest.webmanifest',
  'icones/icone-192.png', 'icones/icone-512.png', 'icones/apple-touch-icon.png',
];

self.addEventListener('install', ev => {
  ev.waitUntil(caches.open(VERSAO).then(c => c.addAll(BASICOS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', ev => {
  ev.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSAO && k !== COMPARTILHADOS) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', ev => {
  const req = ev.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.method === 'POST' && url.pathname.endsWith('/receber')) { ev.respondWith(receber(req)); return; }
  if (req.method !== 'GET' || url.pathname.includes('/teste')) return;
  ev.respondWith(redePrimeiro(req));
});

// Internet primeiro (sempre a versão nova); sem internet ou lenta, usa a cópia guardada.
async function redePrimeiro(req) {
  const cache = await caches.open(VERSAO);
  try {
    const resp = await Promise.race([
      fetch(req),
      new Promise((_, falha) => setTimeout(() => falha(new Error('lento')), 3500)),
    ]);
    if (resp && resp.ok && resp.type === 'basic') cache.put(req, resp.clone());
    return resp;
  } catch (e) {
    const guardado = (await cache.match(req, { ignoreSearch: true }))
      || (req.mode === 'navigate' ? await cache.match('index.html') : null);
    if (guardado) return guardado;
    throw e;
  }
}

// Vídeos que chegam da galeria: ficam guardados até o app abrir e pegar.
async function receber(req) {
  try {
    const dados = await req.formData();
    const arquivos = dados.getAll('videos').filter(f => f && typeof f === 'object' && 'size' in f);
    const cache = await caches.open(COMPARTILHADOS);
    for (const k of await cache.keys()) await cache.delete(k);
    let i = 0;
    for (const f of arquivos) {
      await cache.put(new Request(`compartilhado/${i}`), new Response(f, {
        headers: {
          'Content-Type': f.type || 'video/mp4',
          'X-Nome': encodeURIComponent(f.name || `video-${i + 1}.mp4`),
          'X-Data': String(f.lastModified || Date.now()),
        },
      }));
      i++;
    }
    return Response.redirect(`./?compartilhado=${i}`, 303);
  } catch (e) {
    return Response.redirect('./?compartilhado=erro', 303);
  }
}
