// Money Map — service worker
//
// ATTENZIONE: questo file esiste solo per ricevere le notifiche.
// Non deve mettere in cache NIENTE e non deve intercettare le richieste.
// Un service worker che fa cache e' esattamente il motivo per cui prima
// l'app continuava a mostrare versioni vecchie per ore: qui non c'e'
// nessun listener "fetch", ed e' voluto.

self.addEventListener("install", (e) => {
  // entra in servizio subito, senza aspettare la chiusura delle schede
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      // se in passato fosse rimasta una cache, si butta
      const nomi = await caches.keys();
      await Promise.all(nomi.map((n) => caches.delete(n)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener("push", (e) => {
  let dati = {};
  try {
    dati = e.data ? e.data.json() : {};
  } catch (err) {
    dati = { titolo: "Money Map", testo: e.data ? e.data.text() : "" };
  }
  const titolo = dati.titolo || "Money Map";
  const opzioni = {
    body: dati.testo || "",
    icon: "icon-192.png",
    badge: "icon-192.png",
    tag: dati.tag || "money-map",
    renotify: false,
    data: { url: dati.url || "./" },
  };
  e.waitUntil(self.registration.showNotification(titolo, opzioni));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const destinazione = (e.notification.data && e.notification.data.url) || "./";
  e.waitUntil(
    (async () => {
      const aperte = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // se l'app e' gia' aperta si porta in primo piano invece di aprirne un'altra
      for (const c of aperte) {
        if ("focus" in c) return c.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(destinazione);
    })()
  );
});
