const CACHE_VERSION = '23.04.2026-1003'; // será substituído automaticamente pelo GitHub Actions
const CACHE_NAME = `meuchef-${CACHE_VERSION}`;

const urlsToCache = [
  '/meuchef/',
  '/meuchef/index.html',
  '/meuchef/manifest.json',
  '/meuchef/css/style.css',
  '/meuchef/components/script.js',
  '/meuchef/components/config.js',
  '/meuchef/imagens/topo.png',
  '/meuchef/imagens/chefbaron.png',
  '/meuchef/imagens/assbaron.png',
  '/meuchef/imagens/icon-192.png'
];

// Instalação do Service Worker
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
      .then(() => self.skipWaiting())
  );
});

// Interceptação de requisições
self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        if (response) return response;

        return fetch(event.request).then(response => {
          // Não cache requisições da API
          if (event.request.url.includes('api.anthropic.com')) return response;

          // Cache outros recursos estáticos
          if (response && response.status === 200) {
            const responseToCache = response.clone();
            caches.open(CACHE_NAME).then(cache => {
              cache.put(event.request, responseToCache);
            });
          }
          return response;
        }).catch(() => {
          // Fallback offline
          if (event.request.mode === 'navigate') {
            return caches.match('/meuchef/index.html');
          }
        });
      })
  );
});

// Limpeza de caches antigos + ativação imediata
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});
