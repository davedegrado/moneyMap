// Money Map — avvisi delle rate in arrivo
//
// Gira su GitHub Actions una volta al giorno. Legge le regole ricorrenti da
// Supabase, calcola quali cadono nei prossimi giorni e manda una notifica ai
// dispositivi iscritti. Non serve nessun server.
//
// Variabili d'ambiente richieste (GitHub → Settings → Secrets):
//   SUPABASE_URL          indirizzo del progetto
//   SUPABASE_SERVICE_KEY  chiave "secret" (scavalca le regole: solo qui, mai nell'app)
//   VAPID_PUBLIC          chiave pubblica, la stessa che sta dentro app.js
//   VAPID_PRIVATE         chiave privata
//   VAPID_SUBJECT         "mailto:tua@email"
// Opzionali:
//   GIORNI_PRIMA          quanti giorni di anticipo (predefinito: 2)
//   DRY_RUN               "1" per calcolare senza mandare niente

import webpush from "web-push";

const URL_BASE = process.env.SUPABASE_URL;
const CHIAVE = process.env.SUPABASE_SERVICE_KEY;
const ANTICIPO = Number(process.env.GIORNI_PRIMA || 2);
const PROVA = process.env.DRY_RUN === "1";

if (!URL_BASE || !CHIAVE) {
  console.error("Mancano SUPABASE_URL o SUPABASE_SERVICE_KEY");
  process.exit(1);
}

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT || "mailto:nessuno@example.com",
  process.env.VAPID_PUBLIC,
  process.env.VAPID_PRIVATE
);

async function leggi(tabella, query = "") {
  const r = await fetch(`${URL_BASE}/rest/v1/${tabella}?${query}`, {
    headers: { apikey: CHIAVE, Authorization: `Bearer ${CHIAVE}` },
  });
  if (!r.ok) throw new Error(`${tabella}: ${r.status} ${await r.text()}`);
  return r.json();
}

const iso = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const chiaveMese = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

// La prossima data di addebito di una regola, se cade entro l'anticipo.
// Le occorrenze sono mensili sul calendario, come nell'app.
function inArrivo(regola, oggi) {
  if (!regola.day) return null;              // senza giorno non si sa quando cade
  for (let salto = 0; salto <= 1; salto++) {
    const d = new Date(oggi.getFullYear(), oggi.getMonth() + salto, regola.day);
    const giorni = Math.round((d - oggi) / 86400000);
    if (giorni < 0) continue;
    if (giorni > ANTICIPO) return null;       // troppo lontana, si riprova domani
    const mese = chiaveMese(d);
    if (regola.start_key && mese < regola.start_key) return null;
    if (regola.end_key && mese > regola.end_key) return null;
    return { data: d, giorni };
  }
  return null;
}

const euro = (n) =>
  new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR" }).format(Number(n));

const quando = (g) => (g === 0 ? "oggi" : g === 1 ? "domani" : `fra ${g} giorni`);

async function main() {
  const oggi = new Date();
  oggi.setHours(0, 0, 0, 0);

  const regole = await leggi("recurring", "deleted_at=is.null&select=*");
  const conti = await leggi("wallets", "deleted_at=is.null&select=id,name");
  const membri = await leggi("wallet_members", "select=wallet_id,user_id");
  const iscrizioni = await leggi("push_subscriptions", "select=*");

  const nomeConto = new Map(conti.map((c) => [c.id, c.name]));
  const perUtente = new Map();
  iscrizioni.forEach((s) => {
    if (!perUtente.has(s.user_id)) perUtente.set(s.user_id, []);
    perUtente.get(s.user_id).push(s);
  });

  // chi va avvisato per un certo conto
  const utentiDi = (walletId) =>
    membri.filter((m) => m.wallet_id === walletId).map((m) => m.user_id);

  const daMandare = new Map();   // user_id -> righe di testo
  for (const r of regole) {
    const ev = inArrivo(r, oggi);
    if (!ev) continue;
    const conto = nomeConto.get(r.wallet_id) || "conto";
    const verso = r.to_wallet_id ? ` → ${nomeConto.get(r.to_wallet_id) || "conto"}` : "";
    const riga = `${r.name} ${euro(r.amount)} ${quando(ev.giorni)} · ${conto}${verso}`;
    for (const u of utentiDi(r.wallet_id)) {
      if (!daMandare.has(u)) daMandare.set(u, []);
      daMandare.get(u).push(riga);
    }
  }

  if (daMandare.size === 0) {
    console.log(`Nessuna scadenza entro ${ANTICIPO} giorni.`);
    return;
  }

  let inviate = 0, rimosse = 0;
  for (const [utente, righe] of daMandare) {
    const subs = perUtente.get(utente) || [];
    if (!subs.length) { console.log(`utente ${utente}: nessun dispositivo iscritto`); continue; }

    const titolo = righe.length === 1 ? "Rata in arrivo" : `${righe.length} scadenze in arrivo`;
    const testo = righe.join("\n");
    console.log(`→ ${utente} (${subs.length} dispositivi): ${righe.join(" | ")}`);
    if (PROVA) continue;

    for (const s of subs) {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify({ titolo, testo, tag: "rate-" + iso(oggi) })
        );
        inviate++;
      } catch (e) {
        // 404 e 410: il dispositivo non esiste piu', l'iscrizione va buttata
        if (e.statusCode === 404 || e.statusCode === 410) {
          await fetch(`${URL_BASE}/rest/v1/push_subscriptions?endpoint=eq.${encodeURIComponent(s.endpoint)}`, {
            method: "DELETE",
            headers: { apikey: CHIAVE, Authorization: `Bearer ${CHIAVE}` },
          });
          rimosse++;
        } else {
          console.error("invio fallito:", e.statusCode || "", e.body || e.message);
        }
      }
    }
  }
  console.log(`Inviate ${inviate}, iscrizioni scadute rimosse ${rimosse}.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
