/* Mude a versão a cada atualização do app para o celular baixar a nova */
const VERSAO = 'inspecao-v18';
const ARQUIVOS = ['./', './manifest.webmanifest', './icon-192.png', './icon-512.png', './icon-maskable-512.png'];

/* o Cloudflare redireciona /index.html -> / ; resposta "redirecionada" não pode ser
   entregue a uma navegação (dá ERR_FAILED), então guardamos uma cópia limpa */
async function limpa(r) {
  if (!r || !r.redirected) return r;
  const body = await r.blob();
  return new Response(body, { status: r.status, statusText: r.statusText, headers: r.headers });
}

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(VERSAO);
    for (const u of ARQUIVOS) {
      try { const r = await fetch(u, { cache: 'reload' }); if (r.ok) await c.put(u, await limpa(r)); } catch (x) {}
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSAO).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // fontes do Google: guarda na primeira vez e usa offline
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(caches.open(VERSAO).then(async c => {
      const hit = await c.match(req); if (hit) return hit;
      try { const r = await fetch(req); c.put(req, r.clone()); return r; } catch (x) { return new Response('', { status: 504 }); }
    }));
    return;
  }
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/.well-known/') || url.pathname === '/assetlinks.json') return; // arquivo de verificação do Android

  // abrir o app (/, /index.html, qualquer página): entrega a página guardada
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      const c = await caches.open(VERSAO);
      const atualiza = fetch('./', { cache: 'no-cache' }).then(async r => { if (r.ok) { await c.put('./', await limpa(r.clone())); } return r; }).catch(() => null);
      const hit = await c.match('./');
      if (hit) { e.waitUntil(atualiza); return hit; }
      const r = await atualiza;
      return r ? limpa(r) : new Response('Sem internet. Abra o app uma vez com internet.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    })());
    return;
  }

  // demais arquivos do app: cache primeiro, atualiza em segundo plano
  e.respondWith((async () => {
    const c = await caches.open(VERSAO);
    const hit = await c.match(req, { ignoreSearch: true });
    const net = fetch(req).then(async r => { if (r.ok) await c.put(req, await limpa(r.clone())); return r; }).catch(() => null);
    if (hit) { e.waitUntil(net); return hit; }
    const r = await net;
    return r ? limpa(r) : new Response('', { status: 504 });
  })());
});
