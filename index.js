'use strict';
// ============================================================
// YAPSON-BOT6-V2 — Clone de bot6 + F3 (YapsonSearch intégré)
// ============================================================
// F1 : Lecture et formatage des paiements YapsonPress
// F2 : Confirmation automatique des dépôts en attente my-managment
// F3 : Cycle complet automatique :
//        1. Lire la date de la plus ancienne demande "Pending deposit requests"
//        2. Récupérer paiements YapsonPress depuis cette date jusqu'à (now - F3_MARGIN_MIN)
//        3. Marquer comme Approuvé dans YapsonPress ceux qui ne le sont pas
//        4. Retourner sur my-managment → confirmer les demandes matchées (avec correction montant)
//        5. Rejeter les demandes de plus de F3_REJECT_MIN minutes introuvables dans YapsonPress
// ============================================================

const express    = require('express');
const fetch      = require('node-fetch');
const { chromium } = require('playwright');

const app  = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Variables d'environnement ─────────────────────────────────
const YAPSON_TOKEN   = process.env.YAPSON_TOKEN   || '';
const YAPSON_URL     = (process.env.YAPSON_URL    || 'https://sms-mirror-production.up.railway.app').replace(/\/$/, '');
const MGMT_URL       = (process.env.MGMT_URL      || 'https://my-managment.com').replace(/\/$/, '');
// MGMT_USER/PASS supprimés — connexion par cookies uniquement
const FONCTION       = (process.env.FONCTION      || 'F1').toUpperCase();
const SENDERS        = (process.env.SENDERS       || 'Wave Business,+454,MobileMoney,MoovMoney').split(',').map(s => s.trim());
const INTERVAL_SEC   = parseInt(process.env.INTERVAL_SEC  || '30', 10);

// F2 options
const F2_CONF_MIN    = parseInt(process.env.F2_CONF_MIN   || '10', 10);
const F2_REJ_ON      = process.env.F2_REJ_ON === 'true';
const F2_REJ_MIN     = parseInt(process.env.F2_REJ_MIN    || '15', 10);

// F3 options
// F3_MARGIN_MIN : marge finale (valeurs autorisées : 2, 10, 15, 30 — défaut: 10)
const F3_MARGIN_ALLOWED = [2, 10, 15, 30];
const _f3margin = parseInt(process.env.F3_MARGIN_MIN || '10', 10);
const F3_MARGIN_MIN  = F3_MARGIN_ALLOWED.includes(_f3margin) ? _f3margin : 10;
// F3_REJECT_MIN : seuil de rejet des demandes introuvables (défaut: 50)
const F3_REJECT_MIN  = parseInt(process.env.F3_REJECT_MIN || '50', 10);

const PORT = parseInt(process.env.PORT || '3000', 10);

// ── État global ───────────────────────────────────────────────
let state = {
  status:    'starting',
  fonction:  FONCTION,
  polls:     0,
  confirmed: 0,
  rejected:  0,
  approved:  0,
  errors:    0,
  lastRun:   null,
  logs:      [],
  twofa:     false,
  twofaCode: '',
  cookiesReady: false,
  cookies:   null,   // JSON string des cookies my-managment
};

function log(msg, level = 'info') {
  const ts = new Date().toLocaleTimeString('fr-FR');
  const entry = `[${ts}] ${msg}`;
  console.log(entry);
  state.logs.unshift(entry);
  if (state.logs.length > 200) state.logs.pop();
}

// ── Utilitaires ───────────────────────────────────────────────
function normPhone(s) {
  const d = s.replace(/[^\d]/g, '');
  if (d.length === 13 && d.startsWith('2250')) return d.slice(3);
  if (d.length === 12 && d.startsWith('225'))  return '0' + d.slice(3);
  return d;
}

function parseAmount(s) {
  if (!s) return 0;
  const str = String(s).trim();
  // Extraire la partie numérique avant les lettres (ex: "8000.00 FCFA" → "8000.00")
  const numPart = str.match(/^[\d\s\u00a0.,]+/)?.[0] || str;
  // Supprimer espaces/nbsp (séparateurs milliers)
  const noSpaces = numPart.replace(/[\s\u00a0]/g, '');
  // Supprimer décimales (point/virgule + 1-2 chiffres en fin) : "8000.00" → "8000"
  const noDecimal = noSpaces.replace(/[.,]\d{1,2}$/, '');
  return parseInt(noDecimal.replace(/[^\d]/g, ''), 10) || 0;
}

function fmtAmt(n) {
  return n.toLocaleString('fr-FR');
}

function parseYapsonDate(str) {
  // Format attendu : "DD/MM/YYYY HH:MM" ou ISO
  if (!str) return null;
  const m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})/);
  if (m) {
    return new Date(`${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}T${m[4].padStart(2,'0')}:${m[5]}:00`);
  }
  return new Date(str);
}

function parseMgmtDate(str) {
  // Format my-managment : "2026-05-02 00:37:13" (YYYY-MM-DD HH:MM:SS — heure locale Abidjan UTC+0)
  if (!str) return null;
  // Format ISO-like: YYYY-MM-DD HH:MM:SS
  let m = str.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    // Heure locale Abidjan = UTC, donc pas de décalage
    return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]||'00'}Z`);
  }
  // Format DD/MM/YYYY HH:MM
  m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})/);
  if (m) {
    return new Date(`${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}T${m[4].padStart(2,'0')}:${m[5]}:00Z`);
  }
  return null;
}

// ── Parseurs SMS ──────────────────────────────────────────────
function parseMsg(sender, content) {
  if (sender === 'Wave Business') {
    const m = content.match(/\((0\d{9})\)\s+a\s+pay[eé]\s+([\d\s\u00a0.,]+)\s*F/i);
    if (m) return { phone: m[1], amount: parseAmount(m[2]) };
  }
  if (sender === '+454' || sender.includes('MobileMoney') || sender.includes('Orange')) {
    // Format Orange Money: "transfert de 500.00 FCFA du 0758006523"
    // ou: "transfert de 1 000.00 FCFA du 0708043759"
    const m1 = content.match(/transfert de ([\d\s .,]+)\s*FCFA\s+du\s+(0\d{9})/i);
    if (m1) return { phone: normPhone(m1[2]), amount: parseAmount(m1[1]) };
    // Format alternatif: montant puis numéro
    const m2 = content.match(/([\d\s .,]+)\s*FCFA.*?(0\d{9})/i);
    if (m2) return { phone: normPhone(m2[2]), amount: parseAmount(m2[1]) };
    // Format: numéro puis montant
    const m3 = content.match(/(0\d{9}).*?([\d\s .,]+)\s*FCFA/i);
    if (m3) return { phone: normPhone(m3[1]), amount: parseAmount(m3[2]) };
  }
  if (sender.includes('MoovMoney')) {
    // Format MoovMoney: "transfert de 5000 FCFA du 0787043223" ou similaire
    const m1 = content.match(/de\s+([\d\s .,]+)\s*FCFA\s+du\s+(0\d{9})/i);
    if (m1) return { phone: normPhone(m1[2]), amount: parseAmount(m1[1]) };
    const m2 = content.match(/(0\d{9}).*?([\d\s .,]+)\s*FCFA/i);
    if (m2) return { phone: normPhone(m2[1]), amount: parseAmount(m2[2]) };
    const m3 = content.match(/([\d\s .,]+)\s*FCFA.*?(0\d{9})/i);
    if (m3) return { phone: normPhone(m3[2]), amount: parseAmount(m3[1]) };
  }
  // Pattern générique : numéro 10 chiffres + montant
  const gen = content.match(/(0\d{9}).*?(\d[\d\s\u00a0]{2,})/);
  if (gen) return { phone: gen[1], amount: parseAmount(gen[2]) };
  return null;
}

// ── API YapsonPress ───────────────────────────────────────────
async function yapsonFetchMessages(fromTs, toTs) {
  const token = YAPSON_TOKEN || state.yapsonToken;
  if (!token) throw new Error('YAPSON_TOKEN manquant');

  const res = await fetch(`${YAPSON_URL}/api/messages`, {
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error(`YapsonPress API ${res.status}`);
  const data = await res.json();
  // L'API retourne un tableau direct (index 0,1,2...) ou data.messages
  const messages = Array.isArray(data) ? data : (data.messages || data.data || Object.values(data));

  return messages.filter(msg => {
    if (!SENDERS.some(s => (msg.sender || '').includes(s))) return false;
    // timestamp est en millisecondes (ex: 1777683351000)
    let ts = msg.timestamp;
    if (!ts) ts = new Date(msg.created_at || msg.date || '').getTime();
    if (!ts || isNaN(ts)) return false;
    return ts >= fromTs && ts <= toTs;
  });
}

async function yapsonApprove(msgId) {
  const token = YAPSON_TOKEN || state.yapsonToken;
  // Route réelle: PATCH /api/messages/{id}/status avec body {"status":"approuve"}
  const res = await fetch(`${YAPSON_URL}/api/messages/${msgId}/status`, {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'approuve' }),
  });
  return res.ok;
}

// ── Playwright : session my-managment ────────────────────────
let browser = null;
let page    = null;

async function ensureBrowser() {
  if (!browser || !browser.isConnected()) {
    log('🚀 Lancement Chromium…');
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  }
  if (!page || page.isClosed()) {
    page = await browser.newPage();
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'fr-FR,fr;q=0.9' });
  }
}

async function mgmtLogin() {
  // Connexion par injection de cookies (reCAPTCHA bloque le login auto)
  if (!state.cookies) {
    log('🍪 Cookies my-managment requis — en attente via le dashboard…');
    state.status = 'waiting_cookies';
    state.cookiesReady = false;
    // Attendre jusqu'à 30 minutes que les cookies soient fournis
    for (let i = 0; i < 1800; i++) {
      if (state.cookies) break;
      await new Promise(r => setTimeout(r, 1000));
    }
    if (!state.cookies) throw new Error('Cookies timeout — non fournis dans les 30 min');
  }

  log('🍪 Injection des cookies my-managment…');
  await ensureBrowser();

  // Parser les cookies (JSON array)
  let cookieList;
  try {
    cookieList = JSON.parse(state.cookies);
    if (!Array.isArray(cookieList)) throw new Error('Format invalide');
  } catch(e) {
    log(`❌ Cookies invalides: ${e.message}`);
    state.cookies = null;
    state.cookiesReady = false;
    throw new Error('Cookies JSON invalides');
  }

  // Naviguer sur le domaine d'abord
  await page.goto(MGMT_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });

  // Injecter les cookies
  const context = page.context();
  await context.clearCookies();
  const cleaned = cookieList.map(c => ({
    name:     c.name,
    value:    c.value,
    domain:   c.domain || '.my-managment.com',
    path:     c.path   || '/',
    httpOnly: c.httpOnly || false,
    secure:   c.secure   || false,
    sameSite: ['Strict','Lax','None'].includes(c.sameSite) ? c.sameSite : 'Lax',
  }));
  await context.addCookies(cleaned);

  // Recharger et vérifier
  await page.goto(`${MGMT_URL}/fr/admin/report/pendingrequestrefill`, { waitUntil: 'networkidle', timeout: 30000 });
  const currentUrl = page.url();
  if (currentUrl.includes('login')) {
    log('❌ Cookies refusés — session expirée, fournir de nouveaux cookies');
    state.cookies = null;
    state.cookiesReady = false;
    state.status = 'waiting_cookies';
    throw new Error('Cookies refusés par my-managment');
  }

  log('✅ Connecté à my-managment via cookies');
  state.cookiesReady = true;
  state.status = 'running';
}

async function ensureLoggedIn() {
  await ensureBrowser();
  if (!state.cookiesReady || !state.cookies) {
    await mgmtLogin();
    return;
  }
  try {
    const url = page.url();
    if (!url || url.includes('login') || url === 'about:blank') {
      await mgmtLogin();
    }
  } catch {
    await mgmtLogin();
  }
}

// ── API my-managment : Confirmer et Rejeter directement ──────

async function mgmtConfirm(rowData) {
  // POST /admin/banktransfer/approvemoney via page.evaluate (utilise les cookies de session)
  // rowData: { id, summa, summaUser, reportId, subagentId, currency }
  const result = await page.evaluate(async (data) => {
    const fd = new FormData();
    fd.append('id',          String(data.id));
    fd.append('summa',       String(data.summa));       // montant YapsonPress
    fd.append('summa_user',  String(data.summaUser));   // montant original my-managment
    fd.append('comment',     '');
    fd.append('is_out',      'false');
    fd.append('report_id',   data.reportId  || '');
    fd.append('subagent_id', data.subagentId|| '');
    fd.append('currency',    data.currency  || '');
    const res = await new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/admin/banktransfer/approvemoney');
      xhr.onload = () => resolve({ status: xhr.status, response: xhr.responseText.substring(0, 200) });
      xhr.onerror = () => resolve({ status: 0, response: 'error' });
      xhr.send(fd);
    });
    return res;
  }, rowData);
  return result;
}

async function mgmtReject(id) {
  // POST /admin/banktransfer/rejectmoney via page.evaluate
  const result = await page.evaluate(async (reqId) => {
    const res = await new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/admin/banktransfer/rejectmoney');
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.onload = () => resolve({ status: xhr.status, response: xhr.responseText.substring(0, 200) });
      xhr.onerror = () => resolve({ status: 0, response: 'error' });
      xhr.send(JSON.stringify({ id: reqId, comment: '', is_out: false }));
    });
    return res;
  }, id);
  return result;
}

// ── F1 : Formatage paiements YapsonPress ─────────────────────
async function runF1() {
  log('▶ F1 — Lecture paiements YapsonPress…');
  const toTs   = Date.now();
  const fromTs = toTs - (24 * 60 * 60 * 1000); // dernières 24h par défaut
  const msgs   = await yapsonFetchMessages(fromTs, toTs);
  const result = [];
  for (const msg of msgs) {
    const parsed = parseMsg(msg.sender, msg.body || msg.content || '');
    if (parsed) result.push(`${parsed.phone} → ${fmtAmt(parsed.amount)} F`);
  }
  log(`F1 — ${result.length} paiement(s) formaté(s)`);
  return result;
}

// ── F2 : Confirmation dépôts en attente ──────────────────────
async function runF2() {
  log('▶ F2 — Confirmation dépôts en attente…');
  await ensureLoggedIn();

  await page.goto(`${MGMT_URL}/fr/admin/report/pendingrequestrefill`, { waitUntil: 'networkidle', timeout: 30000 });

  // Désactiver auto-refresh, mettre 500 lignes
  try {
    const autoEl = await page.$('input[name="autorefresh"], #autorefresh');
    if (autoEl) await autoEl.uncheck();
    const selectEl = await page.$('select[name*="length"], select.dataTables_length');
    if (selectEl) await selectEl.selectOption('500');
    const applyBtn = await page.$('button:has-text("APPLIQUER"), input[value="APPLIQUER"]');
    if (applyBtn) { await applyBtn.click(); await page.waitForTimeout(1500); }
  } catch(e) { log(`⚠ Setup tableau: ${e.message}`); }

  // Lire le tableau
  const rows = await page.$$eval('table tbody tr', trs => trs.map(tr => {
    const cells = [...tr.querySelectorAll('td')].map(td => td.innerText.trim());
    return cells;
  }));

  const now = Date.now();
  let confirmed = 0;
  let rejected  = 0;

  for (const cells of rows) {
    if (cells.length < 4) continue;
    const phone    = normPhone(cells[1] || cells[0]);
    const amtRaw   = cells[2] || cells[3];
    const dateStr  = cells[0] || '';
    const dateTs   = parseMgmtDate(dateStr)?.getTime() || 0;
    const ageMin   = (now - dateTs) / 60000;

    // Récupérer le bouton CONFIRMER ou REJETER de cette ligne
    // TODO: adapter les sélecteurs selon la structure réelle du tableau
    log(`F2 — Ligne: ${phone} | ${amtRaw} | âge: ${ageMin.toFixed(0)} min`);
  }

  log(`F2 — ${confirmed} confirmé(s), ${rejected} rejeté(s)`);
  state.confirmed += confirmed;
  state.rejected  += rejected;
}

// ── F3 : Cycle complet YapsonSearch automatique ──────────────
async function runF3() {
  log('▶ F3 — Cycle complet YapsonSearch…');
  await ensureLoggedIn();

  // ─── ÉTAPE 1 : Lire la date de la plus ancienne demande pending ───
  log('F3 [1/5] Lecture du tableau Pending deposit requests…');
  await page.goto(`${MGMT_URL}/fr/admin/report/pendingrequestrefill`, { waitUntil: 'networkidle', timeout: 30000 });

  // Désactiver auto-refresh (toggle Vue.js) et appliquer
  try {
    // Trouver le toggle "Mise à jour auto" et le désactiver s'il est ON
    const toggleInput = await page.$('input[type="checkbox"].toggle, .toggle input, input#autoUpdate, input[class*="toggle"]');
    if (toggleInput) {
      const isOn = await toggleInput.isChecked();
      if (isOn) await toggleInput.dispatchEvent('click');
    } else {
      // Chercher par le label visible
      const toggleEl = await page.$('.toggle--is-checked, [class*="toggle"][class*="active"]');
      if (toggleEl) await toggleEl.dispatchEvent('click');
    }
    await page.waitForTimeout(500);
    // Appliquer pour charger les données
    const applyBtn = await page.$('button:has-text("APPLIQUER")');
    if (applyBtn) { await applyBtn.click(); await page.waitForTimeout(2000); }
  } catch(e) { log(`⚠ Setup tableau: ${e.message.substring(0,80)}`); }

  // Extraire toutes les lignes en attente avec les données cachées (id, report_id etc.)
  const pendingRows = await page.$$eval('table tbody tr', (trs) => {
    return trs.map(tr => {
      const cells = [...tr.querySelectorAll('td')].map(td => td.innerText.trim());
      const hasConfirm = tr.innerText.includes('Confirmer') || tr.innerText.includes('Confirm');

      // Extraire les data-attributes ou onclick pour récupérer id, report_id, subagent_id, currency
      // Les liens Confirmer/Rejeter ont souvent ces infos en attributs Vue :data-* ou @click
      const links = [...tr.querySelectorAll('a')];
      const confirmLink = links.find(a => a.innerText?.trim() === 'Confirmer');
      const rejectLink  = links.find(a => a.innerText?.trim() === 'Rejeter');

      // Chercher les attributs data-* sur la ligne ou ses cellules
      const allEls = [tr, ...tr.querySelectorAll('[data-id],[data-report],[data-subagent],[data-currency],[onclick]')];
      let rowId = null, reportId = null, subagentId = null, currency = null;
      for (const el of allEls) {
        if (el.dataset?.id)       rowId     = el.dataset.id;
        if (el.dataset?.reportId) reportId  = el.dataset.reportId;
        if (el.dataset?.subagent) subagentId= el.dataset.subagent;
        if (el.dataset?.currency) currency  = el.dataset.currency;
        // Chercher dans les attributs Vue/onclick
        const onclick = el.getAttribute('onclick') || '';
        const vClick  = el.getAttribute('@click') || el.getAttribute('v-on:click') || '';
        const src = onclick + vClick;
        if (src) {
          const mId  = src.match(/['"](\d{10,})['"]/);
          if (mId && !rowId) rowId = mId[1];
        }
      }

      return { cells, hasConfirm, rowId, reportId, subagentId, currency,
               hasConfirmLink: !!confirmLink, hasRejectLink: !!rejectLink };
    }).filter(r => r.hasConfirm && r.cells.length >= 5);
  });

  if (pendingRows.length === 0) {
    log('F3 — Aucune demande en attente. Fin.');
    return;
  }
  log(`F3 — ${pendingRows.length} demande(s) en attente trouvée(s)`);

  // La plus ancienne = dernière ligne du tableau (triées par DATE DE CRÉATION desc)
  // col0 format: "2026-05-02 00:37:13"
  const now = Date.now();
  let oldestTs  = now;
  let oldestStr = null;

  for (const row of pendingRows) {
    const dateStr = row.cells[0]; // col0 = DATE DE CRÉATION
    // Format: "2026-05-02 00:37:13" → ISO
    const d = parseMgmtDate(dateStr);
    if (d && !isNaN(d.getTime()) && d.getTime() < oldestTs) {
      oldestTs  = d.getTime();
      oldestStr = dateStr;
    }
  }

  if (!oldestStr) {
    log('F3 ❌ Impossible de lire la date de création. Fin.');
    return;
  }
  log(`F3 — Plus ancienne demande : ${oldestStr} (il y a ${((now - oldestTs)/60000).toFixed(0)} min)`);

  // ─── ÉTAPE 2 : Récupérer paiements YapsonPress dans la fenêtre de temps ───
  const marginMin = f3Config.marginMin; // dynamique depuis dashboard
  const rejectMin = f3Config.rejectMin;
  const toTs   = now - (marginMin * 60 * 1000); // now - marge
  const fromTs = oldestTs;

  log(`F3 [2/5] Fetch YapsonPress de ${new Date(fromTs).toLocaleTimeString('fr-FR')} à ${new Date(toTs).toLocaleTimeString('fr-FR')} (marge ${marginMin}min)…`);

  let yapMessages;
  try {
    yapMessages = await yapsonFetchMessages(fromTs, toTs);
  } catch(e) {
    log(`F3 ❌ Erreur YapsonPress: ${e.message}`);
    return;
  }
  log(`F3 — ${yapMessages.length} message(s) YapsonPress dans la fenêtre`);

  // Parser les paiements
  const payments = []; // { phone, amount, msgId, approved }
  for (const msg of yapMessages) {
    const parsed = parseMsg(msg.sender || '', msg.content || msg.body || msg.message || '');
    if (!parsed) continue;
    payments.push({
      phone:    parsed.phone,
      amount:   parsed.amount,
      msgId:    msg.id || msg._id,
      approved: msg.status === 'approuve' || msg.status === 'approved',
      sender:   msg.sender,
    });
  }
  log(`F3 — ${payments.length} paiement(s) parsé(s) : ${payments.map(p => `${p.phone}→${fmtAmt(p.amount)}F`).join(' | ')}`);

  // ─── ÉTAPE 3 : Marquer comme Approuvé dans YapsonPress ───
  log('F3 [3/5] Approbation dans YapsonPress…');
  let approvedCount = 0;
  for (const p of payments) {
    if (!p.approved && p.msgId) {
      const ok = await yapsonApprove(p.msgId);
      if (ok) { approvedCount++; p.approved = true; }
    }
  }
  log(`F3 — ${approvedCount} paiement(s) approuvé(s) dans YapsonPress`);
  state.approved += approvedCount;

  // ─── ÉTAPE 4 : Retour my-managment → confirmer les demandes matchées ───
  log('F3 [4/5] Confirmation des demandes dans my-managment…');

  // Rester sur la page pending (ou renaviguer si besoin)
  if (!page.url().includes('pendingrequestrefill')) {
    await page.goto(`${MGMT_URL}/fr/admin/report/pendingrequestrefill`, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(1000);
  }

  // Construire un map phone → amount depuis YapsonPress pour lookup rapide
  const yapMap = {}; // phone → [{ amount, msgId }]
  for (const p of payments) {
    if (!yapMap[p.phone]) yapMap[p.phone] = [];
    yapMap[p.phone].push(p);
  }

  let confirmedCount = 0;
  let rejectedCount  = 0;

  // Re-lire les lignes avec Locators (nécessaire pour .locator() sur les enfants)
  const rowLocators = page.locator('table tbody tr');
  const rowCount = await rowLocators.count();

  for (let ri = 0; ri < rowCount; ri++) {
    const rowHandle = rowLocators.nth(ri);
    try {
      const cells = await rowHandle.locator('td').allInnerTexts();
      if (cells.length < 5) continue;

      let reqPhone  = null;
      let reqAmount = null;
      let reqDate   = null;

      reqDate   = parseMgmtDate(cells[0]);
      const phoneMatch = cells[1].match(/(0\d{9})/);
      if (phoneMatch) reqPhone = normPhone(phoneMatch[1]);
      reqAmount = parseAmount(cells[2]);

      if (!reqPhone) continue;
      const ageMin = reqDate ? (now - reqDate.getTime()) / 60000 : 999;

      // Chercher ce numéro dans les paiements YapsonPress
      const matches = yapMap[reqPhone];

      if (matches && matches.length > 0) {
        // Chercher le SMS dont le montant correspond EXACTEMENT à reqAmount
        // Sinon prendre le plus proche (même numéro, montant le plus proche)
        const exactMatch = matches.find(p => p.amount === reqAmount);
        const best = exactMatch || matches.reduce((a, b) =>
          Math.abs(a.amount - (reqAmount||0)) <= Math.abs(b.amount - (reqAmount||0)) ? a : b
        );

        // YapsonPress fait référence — son montant (sans décimales) est le bon
        const montantYapson = best.amount;
        const montantCorrigé = montantYapson; // toujours YapsonPress

        if (reqAmount && reqAmount !== montantCorrigé) {
          log(`F3 — Correction montant ${reqPhone}: my-managment=${fmtAmt(reqAmount)}F → YapsonPress=${fmtAmt(montantCorrigé)}F`);
          // Corriger le champ montant dans my-managment si différent
          try {
            const amountInput = await rowHandle.$('input[type="number"], input[name*="amount"], input[name*="montant"], input[name*="Amount"]');
            if (amountInput) {
              await amountInput.triple_click();
              await amountInput.fill(String(montantCorrigé));
              await page.waitForTimeout(300);
            }
          } catch(e) { log(`⚠ Saisie montant: ${e.message.substring(0,60)}`); }
        }

        // Confirmer — logique exacte bot6 : chercher ligne, cliquer, attendre bouton CONFIRMER
        try {
          // Trouver le lien Confirmer dans la ligne
          let confirmLink = null;
          for (const a of await rowHandle.locator('a').all()) {
            if ((await a.textContent()).trim() === 'Confirmer') { confirmLink = a; break; }
          }
          if (!confirmLink) { log(`F3 ⚠ Lien Confirmer non trouvé pour ${reqPhone}`); continue; }

          await confirmLink.click();
          await page.waitForTimeout(800);

          // Chercher le bouton CONFIRMER dans la modale (boucle comme bot6)
          let modalBtn = null;
          for (let i = 0; i < 30; i++) {
            for (const b of await page.$$('button')) {
              const t = (await b.textContent()).trim().toUpperCase();
              const box = await b.boundingBox();
              if (t === 'CONFIRMER' && box && box.width > 100) { modalBtn = b; break; }
            }
            if (modalBtn) break;
            await page.waitForTimeout(300);
          }

          if (!modalBtn) { log(`F3 ⚠ Modale CONFIRMER non trouvée pour ${reqPhone}`); continue; }

          // Corriger le montant si nécessaire
          if (montantCorrigé && montantCorrigé !== reqAmount) {
            const mi = await page.$('input[placeholder="Montant"],input[placeholder="montant"]');
            if (mi) { await mi.fill(''); await mi.fill(String(montantCorrigé)); await page.waitForTimeout(200); }
            const ci = await page.$('input[placeholder="Commentaire"],textarea[placeholder="Commentaire"]');
            if (ci) { await ci.fill(''); await ci.fill(String(montantCorrigé)); await page.waitForTimeout(200); }
          }

          await modalBtn.click();
          // Attendre que la modale disparaisse
          for (let i = 0; i < 30; i++) {
            let found = false;
            for (const b of await page.$$('button')) if ((await b.textContent()).trim().toUpperCase() === 'CONFIRMER') { found = true; break; }
            if (!found) break;
            await page.waitForTimeout(300);
          }
          await page.waitForTimeout(1000);
          confirmedCount++;
          log(`F3 ✅ Confirmé : ${reqPhone} → ${fmtAmt(montantCorrigé)}F`);
        } catch(e) { log(`⚠ Confirmation ${reqPhone}: ${e.message.substring(0,80)}`); }

      } else {
        // ─── ÉTAPE 5 : Rejeter si > rejectMin minutes et introuvable ───
        if (ageMin >= rejectMin) {
          log(`F3 — Rejet: ${reqPhone} introuvable, âge ${ageMin.toFixed(0)} min >= ${rejectMin} min`);
          try {
            // Rejeter — logique exacte bot6 : cliquer Rejeter, attendre OK
            let rejectLink = null;
            for (const a of await rowHandle.locator('a').all()) {
              if ((await a.textContent()).trim() === 'Rejeter') { rejectLink = a; break; }
            }
            if (!rejectLink) { log(`F3 ⚠ Lien Rejeter non trouvé pour ${reqPhone}`); continue; }

            await rejectLink.click();

            // Chercher le bouton OK (boucle comme bot6)
            let okBtn = null;
            for (let i = 0; i < 40; i++) {
              for (const b of await page.$$('button, a.btn, .btn')) {
                if ((await b.textContent()).trim() === 'OK' && await b.isVisible()) { okBtn = b; break; }
              }
              if (okBtn) break;
              await page.waitForTimeout(200);
            }

            if (!okBtn) { log(`F3 ⚠ Bouton OK rejet non trouvé pour ${reqPhone}`); continue; }

            await page.waitForTimeout(300);
            const ci = await page.$('input[placeholder="Commentaire"],textarea[placeholder="Commentaire"]');
            if (ci) { await ci.fill('Expiré'); await page.waitForTimeout(200); }

            for (const b of await page.$$('button, a.btn, .btn')) {
              if ((await b.textContent()).trim() === 'OK' && await b.isVisible()) { await b.click(); break; }
            }
            await page.waitForTimeout(2000);
            rejectedCount++;
            log(`F3 ❌ Rejeté: ${reqPhone} (âge: ${ageMin.toFixed(0)} min)`);
          } catch(e) { log(`⚠ Rejet ${reqPhone}: ${e.message.substring(0,80)}`); }
        } else {
          log(`F3 ⏳ En attente: ${reqPhone} introuvable mais âge ${ageMin.toFixed(0)} min < ${rejectMin} min`);
        }
      }
    } catch(e) {
      log(`⚠ Erreur ligne: ${e.message}`);
    }
  }

  log(`F3 [5/5] ✅ Résultat : ${confirmedCount} confirmé(s), ${rejectedCount} rejeté(s), ${approvedCount} approuvé(s) YapsonPress`);
  state.confirmed += confirmedCount;
  state.rejected  += rejectedCount;
}

// ── Contrôle pause / resume ───────────────────────────────────
let paused = false;

function setPaused(val) {
  paused = val;
  if (paused) {
    state.status = 'paused';
    log("⏸ Bot mis en pause par l'utilisateur");
  } else {
    state.status = state.cookiesReady ? 'running' : 'waiting_cookies';
    log("▶ Bot relancé par l'utilisateur");
  }
}

// ── Boucle principale ─────────────────────────────────────────
async function mainLoop() {
  log(`🤖 Bot démarré — Fonction: ${FONCTION} | Intervalle: ${INTERVAL_SEC}s`);
  if (FONCTION === 'F3') {
    log(`⚙ F3 config: marge=${f3Config.marginMin}min | seuil rejet=${f3Config.rejectMin}min`);
  }
  state.status = state.cookies ? 'running' : 'waiting_cookies';

  while (true) {
    // Si en pause, attendre sans rien faire
    if (paused) {
      await new Promise(r => setTimeout(r, 2000));
      continue;
    }

    try {
      state.polls++;
      state.lastRun = new Date().toISOString();

      if (FONCTION === 'F1') {
        await runF1();
      } else if (FONCTION === 'F2') {
        await runF2();
      } else if (FONCTION === 'F3') {
        await runF3();
      } else {
        log(`❌ FONCTION inconnue: ${FONCTION}`);
      }
    } catch(e) {
      state.errors++;
      log(`❌ Erreur cycle: ${e.message}`);
      if (!paused) state.status = 'error';
      // Si erreur de cookies → attendre nouveaux cookies
      if (e.message.includes('ookies')) {
        log('🍪 En attente de nouveaux cookies…');
      } else {
        await new Promise(r => setTimeout(r, 5000));
      }
    }

    await new Promise(r => setTimeout(r, INTERVAL_SEC * 1000));
  }
}

// ── Dashboard HTTP ────────────────────────────────────────────
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Yapson Bot6-V2 Dashboard</title>
<meta http-equiv="refresh" content="10">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0f1117;color:#e2e8f0;font-family:monospace;padding:20px}
  h1{color:#89b4fa;font-size:1.3rem;margin-bottom:16px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:20px}
  .card{background:#1e1e2e;border-radius:10px;padding:14px;text-align:center}
  .card .val{font-size:1.6rem;font-weight:bold;color:#a6e3a1}
  .card .lbl{font-size:11px;color:#6c7086;margin-top:4px}
  .status{display:inline-block;padding:4px 12px;border-radius:20px;font-size:12px;font-weight:bold;margin-bottom:16px}
  .status.running{background:#a6e3a1;color:#1e1e2e}
  .status.error{background:#f38ba8;color:#1e1e2e}
  .status.waiting_2fa{background:#fab387;color:#1e1e2e;animation:pulse 1s infinite}
  .status.starting{background:#89b4fa;color:#1e1e2e}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
  .logs{background:#0a0e18;border-radius:10px;padding:14px;max-height:300px;overflow-y:auto}
  .logs div{font-size:11.5px;color:#94a3b8;line-height:1.8;border-bottom:1px solid #1e1e2e;padding:2px 0}
  form{background:#1e1e2e;border-radius:10px;padding:16px;margin-bottom:20px}
  form h2{color:#fab387;font-size:13px;margin-bottom:10px}
  input{background:#313244;color:#cdd6f4;border:1px solid #45475a;border-radius:6px;padding:8px 12px;font-size:13px;width:200px}
  button{background:#89b4fa;color:#1e1e2e;border:none;border-radius:6px;padding:8px 16px;font-size:13px;font-weight:bold;cursor:pointer;margin-left:8px}
  .badge{display:inline-block;background:#313244;border-radius:6px;padding:2px 8px;font-size:11px;margin:2px}
  .status.paused{background:#fab387;color:#1e1e2e}
  .status.waiting_cookies{background:#f38ba8;color:#1e1e2e;animation:pulse 1s infinite}
  .status.connected{background:#a6e3a1;color:#1e1e2e}
  .btn-stop{background:#f38ba8;color:#1e1e2e;border:none;border-radius:8px;padding:8px 20px;font-size:13px;font-weight:bold;cursor:pointer;margin-right:8px}
  .btn-start{background:#a6e3a1;color:#1e1e2e;border:none;border-radius:8px;padding:8px 20px;font-size:13px;font-weight:bold;cursor:pointer;margin-right:8px}
  .btn-neutral{background:#89b4fa;color:#1e1e2e;border:none;border-radius:8px;padding:8px 20px;font-size:13px;font-weight:bold;cursor:pointer}
</style>
</head>
<body>
<h1>🤖 Yapson Bot6-V2 Dashboard</h1>
<span class="status {{STATUS_CLASS}}">{{STATUS_LABEL}}</span>
<span class="badge">Fonction: {{FONCTION}}</span>
<span class="badge">Polls: {{POLLS}}</span>
<span class="badge">Dernière exécution: {{LAST_RUN}}</span>

{{CONTROL_BUTTONS}}

{{COOKIES_FORM}}

{{F3_CONFIG_FORM}}

<div class="grid">
  <div class="card"><div class="val">{{CONFIRMED}}</div><div class="lbl">✅ Confirmés</div></div>
  <div class="card"><div class="val">{{APPROVED}}</div><div class="lbl">🟢 Approuvés (YapsonPress)</div></div>
  <div class="card"><div class="val">{{REJECTED}}</div><div class="lbl">❌ Rejetés</div></div>
  <div class="card"><div class="val">{{ERRORS}}</div><div class="lbl">⚠ Erreurs</div></div>
</div>

<div class="logs">
{{LOGS}}
</div>

</body>
</html>`;

// ── Config F3 dynamique (modifiable depuis le dashboard) ──────
// Valeurs par défaut issues des variables d'environnement
let f3Config = {
  marginMin: F3_MARGIN_MIN,   // 2, 10, 15 ou 30
  rejectMin: F3_REJECT_MIN,   // 50 par défaut
};

// runF3 lit f3Config au lieu des constantes figées
// (déjà câblé via f3Config.marginMin et f3Config.rejectMin ci-dessous)

app.get('/', (req, res) => {
  const statusLabels = {
    running:     '🟢 Actif',
    error:       '🔴 Erreur',
    waiting_2fa: '📱 2FA requis',
    starting:    '🔵 Démarrage',
    connected:   '🟢 Connecté',
  };

  // Boutons Stop / Start
  const isPaused = paused;
  const controlButtons = `
<div style="margin-bottom:16px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
  ${isPaused
    ? '<form method="POST" action="/control" style="display:inline"><input type="hidden" name="action" value="start"><button class="btn-start" type="submit">▶ Relancer</button></form>'
    : '<form method="POST" action="/control" style="display:inline"><input type="hidden" name="action" value="stop"><button class="btn-stop" type="submit">⏸ Arrêter</button></form>'
  }
  <form method="POST" action="/control" style="display:inline">
    <input type="hidden" name="action" value="reset_cookies">
    <button class="btn-neutral" type="submit" title="Forcer la re-injection des cookies">🍪 Réinitialiser cookies</button>
  </form>
  <span style="font-size:11px;color:#6c7086">Cookies: ${state.cookiesReady ? '✅ Actifs' : '❌ Non fournis'}</span>
</div>`;

  // Formulaire cookies (si pas de cookies ou reset demandé)
  const cookiesForm = !state.cookiesReady ? `
<form method="POST" action="/cookies" style="background:#1e1e2e;border-radius:10px;padding:16px;margin-bottom:16px">
  <div style="color:#f38ba8;font-size:13px;font-weight:bold;margin-bottom:8px">🍪 Cookies my-managment requis</div>
  <div style="font-size:11px;color:#6c7086;margin-bottom:10px">
    1. Connecte-toi sur my-managment.com dans ton navigateur<br>
    2. F12 → Application → Cookies → my-managment.com<br>
    3. Copie tout en JSON (extension EditThisCookie) et colle ci-dessous
  </div>
  <textarea name="cookies" rows="4" placeholder='[{"name":"session","value":"...","domain":".my-managment.com",...}]'
    style="width:100%;background:#313244;color:#cdd6f4;border:1px solid #45475a;border-radius:6px;padding:8px;font-size:11px;font-family:monospace;resize:vertical"></textarea>
  <button type="submit" style="margin-top:8px;background:#a6e3a1;color:#1e1e2e;border:none;border-radius:6px;padding:8px 16px;font-size:13px;font-weight:bold;cursor:pointer">🍪 Injecter les cookies</button>
</form>` : '';

  const twoFaForm = ''; // supprimé — login par cookies uniquement

  // Formulaire de configuration F3 (visible uniquement si FONCTION=F3)
  const f3ConfigForm = (FONCTION === 'F3') ? `
<form method="POST" action="/f3-config" style="background:#1e1e2e;border-radius:10px;padding:14px;margin-bottom:16px;display:flex;align-items:center;gap:16px;flex-wrap:wrap">
  <span style="font-size:12px;color:#89b4fa;font-weight:bold">⚙ Config F3</span>
  <label style="font-size:12px;color:#cdd6f4">
    Marge YapsonPress :&nbsp;
    <select name="marginMin" style="background:#313244;color:#cdd6f4;border:1px solid #45475a;border-radius:6px;padding:6px 10px;font-size:13px">
      ${[2,10,15,30].map(v => `<option value="${v}"${f3Config.marginMin===v?' selected':''}>${v} min</option>`).join('')}
    </select>
  </label>
  <label style="font-size:12px;color:#cdd6f4">
    Seuil rejet :&nbsp;
    <select name="rejectMin" style="background:#313244;color:#cdd6f4;border:1px solid #45475a;border-radius:6px;padding:6px 10px;font-size:13px">
      ${[30,45,50,60].map(v => `<option value="${v}"${f3Config.rejectMin===v?' selected':''}>${v} min</option>`).join('')}
    </select>
  </label>
  <button type="submit" style="background:#a6e3a1;color:#1e1e2e;border:none;border-radius:6px;padding:7px 14px;font-size:12px;font-weight:bold;cursor:pointer">Appliquer</button>
  <span style="font-size:11px;color:#6c7086">Actuel : marge=${f3Config.marginMin}min | rejet>=${f3Config.rejectMin}min</span>
</form>` : '';

  const statusLabelsExtra = Object.assign({
    paused:          '⏸ En pause',
    waiting_cookies: '🍪 Cookies requis',
  }, statusLabels);

  const html = DASHBOARD_HTML
    .replace('{{STATUS_CLASS}}',     state.status)
    .replace('{{STATUS_LABEL}}',     statusLabelsExtra[state.status] || state.status)
    .replace('{{FONCTION}}',         state.fonction)
    .replace('{{POLLS}}',            state.polls)
    .replace('{{LAST_RUN}}',         state.lastRun ? new Date(state.lastRun).toLocaleTimeString('fr-FR') : '—')
    .replace('{{CONTROL_BUTTONS}}',  controlButtons)
    .replace('{{COOKIES_FORM}}',     cookiesForm)
    .replace('{{TWOFA_FORM}}',       twoFaForm)
    .replace('{{F3_CONFIG_FORM}}',   f3ConfigForm)
    .replace('{{CONFIRMED}}',        state.confirmed)
    .replace('{{APPROVED}}',         state.approved)
    .replace('{{REJECTED}}',         state.rejected)
    .replace('{{ERRORS}}',           state.errors)
    .replace('{{LOGS}}',             state.logs.slice(0, 60).map(l => `<div>${l}</div>`).join(''));

  res.send(html);
});

app.post('/2fa', (req, res) => {
  const code = (req.body.code || '').trim();
  if (code.length >= 4) {
    state.twofaCode = code;
    log(`📱 Code 2FA reçu: ${code}`);
  }
  res.redirect('/');
});

app.post('/control', (req, res) => {
  const action = req.body.action || '';
  if (action === 'stop') {
    setPaused(true);
    log('⏸ Arrêt demandé depuis le dashboard');
  } else if (action === 'start') {
    setPaused(false);
    log('▶ Relance demandée depuis le dashboard');
  } else if (action === 'reset_cookies') {
    state.cookies = null;
    state.cookiesReady = false;
    state.status = 'waiting_cookies';
    log('🍪 Cookies réinitialisés — en attente de nouveaux cookies');
  }
  res.redirect('/');
});

app.post('/cookies', (req, res) => {
  const raw = (req.body.cookies || '').trim();
  if (!raw) { res.redirect('/'); return; }
  // Valider que c'est du JSON valide
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('Doit être un tableau JSON');
    state.cookies = raw;
    state.cookiesReady = false; // sera mis à true après injection réussie
    log(`🍪 ${parsed.length} cookie(s) reçu(s) — injection en cours…`);
    // Déclencher le login immédiatement en background
    mgmtLogin().catch(e => log(`❌ Injection cookies: ${e.message}`));
  } catch(e) {
    log(`❌ JSON cookies invalide: ${e.message}`);
  }
  res.redirect('/');
});

app.post('/f3-config', (req, res) => {
  const allowed = [2, 10, 15, 30];
  const newMargin = parseInt(req.body.marginMin || '10', 10);
  const newReject = parseInt(req.body.rejectMin || '50', 10);
  if (allowed.includes(newMargin)) {
    f3Config.marginMin = newMargin;
    log(`⚙ F3 marge mise à jour : ${newMargin} min`);
  }
  if (newReject >= 10 && newReject <= 120) {
    f3Config.rejectMin = newReject;
    log(`⚙ F3 seuil rejet mis à jour : ${newReject} min`);
  }
  res.redirect('/');
});

app.get('/status', (req, res) => res.json(state));

app.listen(PORT, () => {
  log(`🌐 Dashboard disponible sur le port ${PORT}`);
  mainLoop().catch(e => { console.error('Fatal:', e); process.exit(1); });
});
