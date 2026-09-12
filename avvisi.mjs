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

// Una tabella o una colonna che ancora non esiste non deve far saltare tutto:
// gli avvisi che funzionano lo stesso devono partire comunque.
async function leggiSePuoi(tabella, query, seManca = []) {
  try {
    return await leggi(tabella, query);
  } catch (e) {
    console.warn(`! ${tabella} non leggibile (${String(e.message).slice(0, 120)}). Proseguo senza.`);
    return seManca;
  }
}

// Il periodo contabile dipende dal giorno d'inizio dell'utente e dalle sue
// eccezioni: serve per sapere a quale periodo appartiene una spunta.
function inizioPeriodo(startDay, overrides, y, m) {
  const chiave = `${y}-${String(m + 1).padStart(2, "0")}`;
  const g = Math.min(28, Math.max(1, overrides[chiave] || startDay || 1));
  return new Date(y, m, g);
}

function periodoDi(startDay, overrides, giorno) {
  const y = giorno.getFullYear(), m = giorno.getMonth();
  const inizio = inizioPeriodo(startDay, overrides, y, m);
  const d = giorno >= inizio ? new Date(y, m, 1) : new Date(y, m - 1, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
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

// per le manuali con una scadenza: quanto manca, o da quanto e' passata
function scadenzaTesto(day, oggi) {
  const questo = new Date(oggi.getFullYear(), oggi.getMonth(), day);
  const giorni = Math.round((questo - oggi) / 86400000);
  if (giorni === 0) return " · scade oggi";
  if (giorni > 0) return ` · entro ${quando(giorni)}`;
  return ` · scaduta da ${-giorni} ${-giorni === 1 ? "giorno" : "giorni"}`;
}

async function main() {
  const oggi = new Date();
  oggi.setHours(0, 0, 0, 0);

  const regole = await leggi("recurring", "deleted_at=is.null&select=*");
  const manuali = regole.filter((r) => r.manuale).length;
  console.log(`Regole attive: ${regole.length} (di cui ${manuali} da pagare a mano).`);
  if (regole.length && !("manuale" in regole[0])) {
    console.warn("! La colonna 'manuale' non esiste: rilancia schema.sql. Le ricorrenti manuali non verranno riconosciute.");
  }
  const spunte = await leggiSePuoi("recurring_paid", "select=recurring_id,period_key");
  const profili = await leggiSePuoi("profiles", "select=id,start_day");
  const eccezioni = await leggiSePuoi("period_overrides", "select=user_id,period_key,start_day");
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

  const pagata = new Set(spunte.map((x) => `${x.recurring_id}|${x.period_key}`));
  const giornoInizio = new Map(profili.map((p) => [p.id, p.start_day || 1]));
  const eccezioniDi = (u) => {
    const o = {};
    eccezioni.filter((e) => e.user_id === u).forEach((e) => { o[e.period_key] = e.start_day; });
    return o;
  };

  const daMandare = new Map();   // user_id -> righe di testo
  const aggiungi = (u, riga) => {
    if (!daMandare.has(u)) daMandare.set(u, []);
    if (!daMandare.get(u).includes(riga)) daMandare.get(u).push(riga);
  };

  for (const r of regole) {
    const conto = nomeConto.get(r.wallet_id) || "conto";
    const verso = r.to_wallet_id ? ` → ${nomeConto.get(r.to_wallet_id) || "conto"}` : "";
    const utenti = utentiDi(r.wallet_id);

    if (r.manuale) {
      // Va pagata a mano: si insiste ogni giorno finche' non e' spuntata.
      // Il periodo dipende dalle impostazioni di chi riceve l'avviso, quindi
      // si calcola per ciascuno.
      for (const u of utenti) {
        const periodo = periodoDi(giornoInizio.get(u) || 1, eccezioniDi(u), oggi);
        if (periodo < (r.start_key || "")) continue;
        if (r.end_key && periodo > r.end_key) continue;
        if (pagata.has(`${r.id}|${periodo}`)) continue;
        const scadenza = r.day ? scadenzaTesto(r.day, oggi) : "";
        aggiungi(u, `${r.name} ${euro(r.amount)} da pagare${scadenza} · ${conto}${verso}`);
      }
      continue;
    }

    const ev = inArrivo(r, oggi);
    if (!ev) continue;
    const riga = `${r.name} ${euro(r.amount)} ${quando(ev.giorni)} · ${conto}${verso}`;
    for (const u of utenti) aggiungi(u, riga);
  }

  if (daMandare.size === 0) {
    console.log(`Nessuna scadenza entro ${ANTICIPO} giorni e nessuna da pagare in sospeso.`);
    return;
  }

  let inviate = 0, rimosse = 0;
  for (const [utente, righe] of daMandare) {
    const subs = perUtente.get(utente) || [];
    if (!subs.length) { console.log(`utente ${utente}: nessun dispositivo iscritto`); continue; }

    const titolo = righe.length === 1 ? "Money Map" : `${righe.length} scadenze`;
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
