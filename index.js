'use strict';

// ============================================================
// YAPSON-BOT6-V2 — Clone de bot6 + F3 (YapsonSearch intégré)
// ============================================================

const express = require('express');
const fetch = require('node-fetch');
const { chromium } = require('playwright');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Variables d'environnement ─────────────────────────────────
const YAPSON_TOKEN = process.env.YAPSON_TOKEN || '';
const YAPSON_URL = (process.env.YAPSON_URL || 'https://sms-mirror-production.up.railway.app').replace(/\/$/, '');
const MGMT_URL = (process.env.MGMT_URL || 'https://my-managment.com').replace(/\/$/, '');
const FONCTION = (process.env.FONCTION || 'F1').toUpperCase();
const SENDERS = (process.env.SENDERS || 'Wave Business,+454,MobileMoney,MoovMoney').split(',').map(s => s.trim());
const INTERVAL_SEC = parseInt(process.env.INTERVAL_SEC || '30', 10);

// F2 options
const F2_CONF_MIN = parseInt(process.env.F2_CONF_MIN || '10', 10);
const F2_REJ_ON = process.env.F2_REJ_ON === 'true';
const F2_REJ_MIN = parseInt(process.env.F2_REJ_MIN || '15', 10);

// F3 options
const F3_MARGIN_ALLOWED = [2, 10, 15, 30];
const _f3margin = parseInt(process.env.F3_MARGIN_MIN || '10', 10);
const F3_MARGIN_MIN = F3_MARGIN_ALLOWED.includes(_f3margin) ? _f3margin : 10;
const F3_REJECT_MIN = parseInt(process.env.F3_REJECT_MIN || '50', 10);

const PORT = parseInt(process.env.PORT || '3000', 10);

// ── État global ───────────────────────────────────────────────
let state = {
  status: 'starting',
  fonction: FONCTION,
  polls: 0,
  confirmed: 0,
  rejected: 0,
  approved: 0,
  errors: 0,
  lastRun: null,
  logs: [],
  twofa: false,
  twofaCode: '',
  cookiesReady: false,
  cookies: null,
  yapsonToken: YAPSON_TOKEN, // Token YapsonPress (modifiable depuis le dashboard)
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
  if (d.length === 12 && d.startsWith('225')) return '0' + d.slice(3);
  return d;
}

function parseAmount(s) {
  if (!s) return 0;
  const str = String(s).trim();
  const numPart = str.match(/^[\d\s\u00a0.,]+/)?.[0] || str;
  const noSpaces = numPart.replace(/[\s\u00a0]/g, '');
  const noDecimal = noSpaces.replace(/[.,]\d{1,2}$/, '');
  return parseInt(noDecimal.replace(/[^\d]/g, ''), 10) || 0;
}

function fmtAmt(n) {
  return n.toLocaleString('fr-FR');
}

function parseYapsonDate(str) {
  if (!str) return null;
  const m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})/);
  if (m) {
    return new Date(`${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}T${m[4].padStart(2,'0')}:${m[5]}:00`);
  }
  return new Date(str);
}

function parseMgmtDate(str) {
  if (!str) return null;
  let m = str.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]||'00'}Z`);
  }
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
    const m1 = content.match(/transfert de ([\d\s .,]+)\s*FCFA\s+du\s+(0\d{9})/i);
    if (m1) return { phone: normPhone(m1[2]), amount: parseAmount(m1[1]) };
    const m2 = content.match(/([\d\s .,]+)\s*FCFA.*?(0\d{9})/i);
    if (m2) return { phone: normPhone(m2[2]), amount: parseAmount(m2[1]) };
    const m3 = content.match(/(0\d{9}).*?([\d\s .,]+)\s*FCFA/i);
    if (m3) return { phone: normPhone(m3[1]), amount: parseAmount(m3[2]) };
  }
  if (sender.includes('MoovMoney')) {
    const m1 = content.match(/de\s+([\d\s .,]+)\s*FCFA\s+du\s+(0\d{9})/i);
    if (m1) return { phone: normPhone(m1[2]), amount: parseAmount(m1[1]) };
    const m2 = content.match(/(0\d{9}).*?([\d\s .,]+)\s*FCFA/i);
    if (m2) return { phone: normPhone(m2[1]), amount: parseAmount(m2[2]) };
    const m3 = content.match(/([\d\s .,]+)\s*FCFA.*?(0\d{9})/i);
    if (m3) return { phone: normPhone(m3[2]), amount: parseAmount(m3[1]) };
  }
  const gen = content.match(/(0\d{9}).*?(\d[\d\s\u00a0]{2,})/);
  if (gen) return { phone: gen[1], amount: parseAmount(gen[2]) };
  return null;
}

// ── API YapsonPress ───────────────────────────────────────────
// Normalise un timestamp YapsonPress en ms (l'API peut renvoyer secondes ou ms)
function normTs(raw) {
  if (!raw) return null;
  let ts = typeof raw === 'string' ? parseFloat(raw) : Number(raw);
  if (isNaN(ts)) return null;
  // ts < 1e11 = secondes Unix (ex: 1746418380), convertir en ms
  if (ts > 0 && ts < 1e11) ts = ts * 1000;
  return ts;
}

async function yapsonFetchMessages(fromTs, toTs) {
  const token = state.yapsonToken;
  if (!token) throw new Error('YAPSON_TOKEN manquant — configurez-le dans le dashboard');
  const res = await fetch(`${YAPSON_URL}/api/messages`, {
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error(`YapsonPress API ${res.status}`);
  const data = await res.json();
  const messages = Array.isArray(data) ? data : (data.messages || data.data || Object.values(data));
  return messages.filter(msg => {
    if (!SENDERS.some(s => (msg.sender || '').includes(s))) return false;
    const ts = normTs(msg.timestamp) || normTs(new Date(msg.created_at || msg.date || '').getTime());
    if (!ts || isNaN(ts)) return false;
    return ts >= fromTs && ts <= toTs;
  });
}

async function yapsonApprove(msgId) {
  const token = state.yapsonToken;
  const res = await fetch(`${YAPSON_URL}/api/messages/${msgId}/status`, {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'approuve' }),
  });
  return res.ok;
}

// ── Recherche approfondie d'un numéro dans TOUS les expéditeurs YapsonPress ──
// Utilisée avant tout rejet : si le paiement existe et est POSTÉRIEUR à la commande → confirmer
async function yapsonDeepSearch(phone, reqDateTs) {
  const token = state.yapsonToken;
  if (!token) return { found: false, payment: null };
  try {
    const res = await fetch(`${YAPSON_URL}/api/messages`, {
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    if (!res.ok) return { found: false, payment: null };
    const data = await res.json();
    const messages = Array.isArray(data) ? data : (data.messages || data.data || Object.values(data));

    // Parcourir TOUS les expéditeurs, sans filtre de date
    const candidates = [];
    for (const msg of messages) {
      const sender = msg.sender || '';
      if (!SENDERS.some(s => sender.includes(s))) continue;
      const parsed = parseMsg(sender, msg.content || msg.body || msg.message || '');
      if (!parsed) continue;
      if (normPhone(String(parsed.phone)) !== normPhone(String(phone))) continue;
      const ts = normTs(msg.timestamp) || normTs(new Date(msg.created_at || msg.date || '').getTime());
      if (!ts || isNaN(ts)) continue;
      candidates.push({
        phone: parsed.phone,
        amount: parsed.amount,
        msgId: msg.id || msg._id,
        approved: msg.status === 'approuve' || msg.status === 'approved',
        sender,
        ts,
      });
    }

    if (candidates.length === 0) return { found: false, payment: null };

    // Chercher un paiement dont le timestamp est >= date de la commande
    const afterOrder = candidates.filter(c => c.ts >= reqDateTs);
    if (afterOrder.length > 0) {
      afterOrder.sort((a, b) => b.ts - a.ts); // le plus récent en premier
      return { found: true, payment: afterOrder[0] };
    }

    // Paiements trouvés mais tous AVANT la commande
    return { found: false, payment: null };
  } catch(e) {
    return { found: false, payment: null };
  }
}


// ── Playwright : session my-managment ────────────────────────
let browser = null;
let page = null;

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
  if (!state.cookies) {
    log('🍪 Cookies my-managment requis — en attente via le dashboard…');
    state.status = 'waiting_cookies';
    state.cookiesReady = false;
    for (let i = 0; i < 1800; i++) {
      if (state.cookies) break;
      await new Promise(r => setTimeout(r, 1000));
    }
    if (!state.cookies) throw new Error('Cookies timeout — non fournis dans les 30 min');
  }
  log('🍪 Injection des cookies my-managment…');
  await ensureBrowser();
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
  await page.goto(MGMT_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
  const context = page.context();
  await context.clearCookies();
  const cleaned = cookieList.map(c => ({
    name: c.name,
    value: c.value,
    domain: c.domain || '.my-managment.com',
    path: c.path || '/',
    httpOnly: c.httpOnly || false,
    secure: c.secure || false,
    sameSite: ['Strict','Lax','None'].includes(c.sameSite) ? c.sameSite : 'Lax',
  }));
  await context.addCookies(cleaned);
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

// ── F1 ────────────────────────────────────────────────────────
async function runF1() {
  log('▶ F1 — Lecture paiements YapsonPress…');
  const toTs = Date.now();
  const fromTs = toTs - (24 * 60 * 60 * 1000);
  const msgs = await yapsonFetchMessages(fromTs, toTs);
  const result = [];
  for (const msg of msgs) {
    const parsed = parseMsg(msg.sender, msg.body || msg.content || '');
    if (parsed) result.push(`${parsed.phone} → ${fmtAmt(parsed.amount)} F`);
  }
  log(`F1 — ${result.length} paiement(s) formaté(s)`);
  return result;
}

// ── F2 ────────────────────────────────────────────────────────
async function runF2() {
  log('▶ F2 — Confirmation dépôts en attente…');
  await ensureLoggedIn();
  await page.goto(`${MGMT_URL}/fr/admin/report/pendingrequestrefill`, { waitUntil: 'networkidle', timeout: 30000 });
  try {
    const autoEl = await page.$('input[name="autorefresh"], #autorefresh');
    if (autoEl) await autoEl.uncheck();
    const selectEl = await page.$('select[name*="length"], select.dataTables_length');
    if (selectEl) await selectEl.selectOption('500');
    const applyBtn = await page.$('button:has-text("APPLIQUER"), input[value="APPLIQUER"]');
    if (applyBtn) { await applyBtn.click(); await page.waitForTimeout(1500); }
  } catch(e) { log(`⚠ Setup tableau: ${e.message}`); }
  const rows = await page.$$eval('table tbody tr', trs => trs.map(tr => {
    const cells = [...tr.querySelectorAll('td')].map(td => td.innerText.trim());
    return cells;
  }));
  const now = Date.now();
  let confirmed = 0;
  let rejected = 0;
  for (const cells of rows) {
    if (cells.length < 4) continue;
    const phone = normPhone(cells[1] || cells[0]);
    const amtRaw = cells[2] || cells[3];
    const dateStr = cells[0] || '';
    const dateTs = parseMgmtDate(dateStr)?.getTime() || 0;
    const ageMin = (now - dateTs) / 60000;
    log(`F2 — Ligne: ${phone} | ${amtRaw} | âge: ${ageMin.toFixed(0)} min`);
  }
  log(`F2 — ${confirmed} confirmé(s), ${rejected} rejeté(s)`);
  state.confirmed += confirmed;
  state.rejected += rejected;
}

// ── Config F3 dynamique ───────────────────────────────────────
let f3Config = {
  marginMin: F3_MARGIN_MIN,
  rejectMin: F3_REJECT_MIN,
};

// ── Injecter une valeur dans un input Vue.js (méthode fiable) ─
async function setVueInput(locator, value) {
  await locator.evaluate((el, val) => {
    el.focus();
    el.select && el.select();
    // Effacer via nativeSetter pour que Vue.js détecte le changement
    const tag = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const nativeSetter = Object.getOwnPropertyDescriptor(tag, 'value')?.set;
    if (nativeSetter) {
      nativeSetter.call(el, '');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      nativeSetter.call(el, val);
    } else {
      el.value = val;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
  }, String(value));
  await page.waitForTimeout(200);
}

// ── Attendre le bouton CONFIRMER dans la modale ───────────────
async function waitModalConfirmBtn(timeoutMs = 15000) {
  const t = Date.now();
  while (Date.now() - t < timeoutMs) {
    // Cacher le preloader si présent
    await page.evaluate(() => {
      document.querySelectorAll('.container-preloader').forEach(p => p.style.display = 'none');
    }).catch(() => {});
    // Chercher bouton CONFIRMER visible avec largeur suffisante
    for (const b of await page.$$('button')) {
      try {
        const txt = (await b.textContent()).trim().toUpperCase();
        const box = await b.boundingBox();
        if (txt === 'CONFIRMER' && box && box.width > 80) return b;
      } catch { /* ignore */ }
    }
    // Aussi chercher button.btn-success avec texte "Confirmer"
    for (const b of await page.$$('button.btn-success')) {
      try {
        const txt = (await b.textContent()).trim();
        const box = await b.boundingBox();
        if (txt === 'Confirmer' && box && box.width > 50) return b;
      } catch { /* ignore */ }
    }
    await page.waitForTimeout(300);
  }
  return null;
}

// ── Attendre fermeture de la modale ──────────────────────────
async function waitModalClose(timeoutMs = 15000) {
  const t = Date.now();
  while (Date.now() - t < timeoutMs) {
    await page.evaluate(() => {
      document.querySelectorAll('.container-preloader').forEach(p => p.style.display = 'none');
    }).catch(() => {});
    let found = false;
    for (const b of await page.$$('button')) {
      try {
        const txt = (await b.textContent()).trim().toUpperCase();
        if (txt === 'CONFIRMER') { found = true; break; }
      } catch { /* ignore */ }
    }
    if (!found) return true;
    await page.waitForTimeout(300);
  }
  return false;
}

// ── Corriger montant + commentaire dans la modale ouverte ────
async function fixModalAmount(montantYapson) {
  await page.waitForTimeout(500);
  const amtLocator = page.locator(
    'input[placeholder="Montant"], input[placeholder="montant"], input[placeholder="Amount"], ' +
    '[role="dialog"] input[type="number"], .modal input[type="number"]'
  ).first();
  const amtCount = await amtLocator.count();
  if (amtCount > 0) {
    await setVueInput(amtLocator, String(montantYapson));
    log(`F3 ✏ Montant modale → ${fmtAmt(montantYapson)}F`);
  } else {
    log(`F3 ⚠ Champ Montant introuvable dans la modale`);
  }
  // Remplir aussi le champ Commentaire avec le montant SMS (trace)
  const commLocator = page.locator(
    'input[placeholder="Commentaire"], textarea[placeholder="Commentaire"], ' +
    'input[placeholder="commentaire"], textarea[placeholder="commentaire"]'
  ).first();
  const commCount = await commLocator.count();
  if (commCount > 0) {
    await setVueInput(commLocator, String(montantYapson));
  }
}

// ── F3 ────────────────────────────────────────────────────────
async function runF3() {
  log('▶ F3 — Cycle complet YapsonSearch…');
  await ensureLoggedIn();

  // ── ÉTAPE 1 : Lire les demandes en attente dans my-managment ─
  log('F3 [1/5] Lecture du tableau Pending deposit requests…');
  await page.goto(`${MGMT_URL}/fr/admin/report/pendingrequestrefill`, { waitUntil: 'networkidle', timeout: 30000 });

  // Désactiver l'autorefresh et charger 500 lignes
  try {
    // Désactiver le toggle autorefresh
    const toggleInput = await page.$('input[type="checkbox"].toggle, .toggle input, input#autoUpdate, input[class*="toggle"]');
    if (toggleInput) {
      const isOn = await toggleInput.isChecked();
      if (isOn) await toggleInput.dispatchEvent('click');
    } else {
      const toggleEl = await page.$('.toggle--is-checked, [class*="toggle"][class*="active"]');
      if (toggleEl) await toggleEl.dispatchEvent('click');
    }
    await page.waitForTimeout(500);
    // Sélectionner 500 lignes via le multiselect Vue.js
    const ms = await page.$('.input-group.select-box .multiselect, .multiselect[data-v]');
    if (ms) {
      const current = await page.$eval('.multiselect__single', el => el.textContent.trim()).catch(() => '');
      if (current !== '500') {
        const selectBtn = await ms.$('.multiselect__select');
        if (selectBtn) { await selectBtn.click(); await page.waitForTimeout(400); }
        const options = await ms.$$('.multiselect__element');
        for (const opt of options) {
          const txt = (await opt.textContent()).trim();
          if (txt === '500') { await opt.$('span')?.click(); break; }
        }
        await page.waitForTimeout(300);
      }
    }
    const applyBtn = await page.$('button:has-text("Appliquer"), button:has-text("APPLIQUER")');
    if (applyBtn) { await applyBtn.click(); await page.waitForTimeout(3000); }
  } catch(e) { log(`⚠ Setup tableau: ${e.message.substring(0, 80)}`); }

  // Lire toutes les lignes
  const pendingRows = await page.$$eval('table tbody tr', (trs) => {
    return trs.map(tr => {
      const cells = [...tr.querySelectorAll('td')].map(td => td.innerText.trim());
      if (cells.length < 5) return null;
      const hasConfirm = [...tr.querySelectorAll('a')].some(a => a.textContent.trim() === 'Confirmer');
      if (!hasConfirm) return null;
      const phoneMatch = (cells[1] || '').match(/0\d{9}/);
      const phone = phoneMatch ? phoneMatch[0] : null;
      if (!phone) return null;
      return { date: cells[0], phone, amountRaw: cells[2] };
    }).filter(Boolean);
  });

  if (pendingRows.length === 0) { log('F3 — Aucune demande en attente. Fin.'); return; }
  log(`F3 — ${pendingRows.length} demande(s) en attente trouvée(s)`);

  // ── ÉTAPE 2 : Trouver la plus ancienne demande → timestamp de départ ─
  const now = Date.now();
  let oldestTs = now;
  let oldestStr = null;
  for (const row of pendingRows) {
    const d = parseMgmtDate(row.date);
    if (d && !isNaN(d.getTime()) && d.getTime() < oldestTs) {
      oldestTs = d.getTime();
      oldestStr = row.date;
    }
  }
  if (!oldestStr) { log('F3 ❌ Impossible de lire la date la plus ancienne. Fin.'); return; }
  log(`F3 — Plus ancienne demande : ${oldestStr} (il y a ${((now - oldestTs) / 60000).toFixed(0)} min)`);

  // ── ÉTAPE 3 : Fetch YapsonPress depuis oldestTs jusqu'à (now - marginMin) ─
  const marginMin = f3Config.marginMin;
  const rejectMin = f3Config.rejectMin;
  const fromTs = oldestTs;
  const toTs = now - (marginMin * 60 * 1000);
  log(`F3 [2/5] Fetch YapsonPress de ${new Date(fromTs).toLocaleTimeString('fr-FR')} à ${new Date(toTs).toLocaleTimeString('fr-FR')} (marge ${marginMin}min)…`);

  let yapMessages;
  try {
    yapMessages = await yapsonFetchMessages(fromTs, toTs);
  } catch(e) {
    log(`F3 ❌ Erreur YapsonPress: ${e.message}`);
    return;
  }
  log(`F3 — ${yapMessages.length} message(s) YapsonPress dans la fenêtre`);

  // Parser les messages YapsonPress → Map par numéro de téléphone
  const payments = [];
  for (const msg of yapMessages) {
    const parsed = parseMsg(msg.sender || '', msg.content || msg.body || msg.message || '');
    if (!parsed) continue;
    payments.push({
      phone: parsed.phone,
      amount: parsed.amount,
      msgId: msg.id || msg._id,
      approved: msg.status === 'approuve' || msg.status === 'approved',
      sender: msg.sender,
    });
  }
  log(`F3 — ${payments.length} paiement(s) parsé(s) depuis YapsonPress : ${payments.map(p => `${p.phone}→${fmtAmt(p.amount)}F`).join(' | ')}`);

  // ── ÉTAPE 4 : Approuver dans YapsonPress les paiements non encore approuvés ─
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

  // Construire un Map phone → liste de paiements YapsonPress
  const yapMap = {};
  for (const p of payments) {
    if (!yapMap[p.phone]) yapMap[p.phone] = [];
    yapMap[p.phone].push(p);
  }

  // ── ÉTAPE 5 : Confirmer/rejeter dans my-managment ─────────────
  log('F3 [4/5] Confirmation des demandes dans my-managment…');
  // Recharger la page pour avoir les données fraîches
  if (!page.url().includes('pendingrequestrefill')) {
    await page.goto(`${MGMT_URL}/fr/admin/report/pendingrequestrefill`, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(1000);
  }

  let confirmedCount = 0;
  let rejectedCount = 0;
  const rowLocators = page.locator('table tbody tr');
  const rowCount = await rowLocators.count();

  for (let ri = 0; ri < rowCount; ri++) {
    const rowHandle = rowLocators.nth(ri);
    try {
      const cells = await rowHandle.locator('td').allInnerTexts();
      if (cells.length < 5) continue;

      // Extraire téléphone et montant de my-managment
      const phoneMatch = (cells[1] || '').match(/(0\d{9})/);
      if (!phoneMatch) continue;
      const reqPhone = normPhone(phoneMatch[1]);
      const reqAmount = parseAmount(cells[2]);
      const reqDate = parseMgmtDate(cells[0]);
      const ageMin = reqDate ? (now - reqDate.getTime()) / 60000 : 999;

      // Chercher ce numéro dans les paiements YapsonPress
      const yapMatches = yapMap[reqPhone];

      if (yapMatches && yapMatches.length > 0) {
        // Trouver le meilleur match (exact d'abord, sinon le plus proche)
        const exactMatch = yapMatches.find(p => p.amount === reqAmount);
        const best = exactMatch || yapMatches.reduce((a, b) =>
          Math.abs(a.amount - (reqAmount || 0)) <= Math.abs(b.amount - (reqAmount || 0)) ? a : b
        );

        // Montant à appliquer : celui de YapsonPress, plafonné à 200 000
        let montantFinal = best.amount;
        if (montantFinal > 200000) {
          log(`F3 ⚠ Montant YapsonPress ${fmtAmt(montantFinal)}F > 200 000 → plafonné à 200 000F`);
          montantFinal = 200000;
        }

        if (reqAmount !== montantFinal) {
          log(`F3 — Correction montant ${reqPhone}: my-managment=${fmtAmt(reqAmount)}F → YapsonPress=${fmtAmt(montantFinal)}F`);
        }

        // Cliquer sur "Confirmer" dans la ligne
        try {
          let confirmLink = null;
          for (const a of await rowHandle.locator('a').all()) {
            if ((await a.textContent()).trim() === 'Confirmer') { confirmLink = a; break; }
          }
          if (!confirmLink) { log(`F3 ⚠ Lien Confirmer non trouvé pour ${reqPhone}`); continue; }
          await confirmLink.click();
          await page.waitForTimeout(800);

          // Attendre l'apparition du bouton CONFIRMER dans la modale
          const modalBtn = await waitModalConfirmBtn(15000);
          if (!modalBtn) { log(`F3 ⚠ Modale CONFIRMER non trouvée pour ${reqPhone}`); continue; }

          // Si montant différent : corriger dans la modale AVANT de cliquer
          if (reqAmount !== montantFinal) {
            await fixModalAmount(montantFinal);
            await page.waitForTimeout(300);
          }

          // Cliquer sur CONFIRMER dans la modale
          await modalBtn.click();

          // Attendre la fermeture de la modale
          await waitModalClose(15000);
          await page.waitForTimeout(1000);

          confirmedCount++;
          log(`F3 ✅ Confirmé : ${reqPhone} → ${fmtAmt(montantFinal)}F`);
        } catch(e) { log(`⚠ Confirmation ${reqPhone}: ${e.message.substring(0, 80)}`); }

      } else {
        // Numéro PAS dans la fenêtre YapsonPress principale
        if (ageMin >= rejectMin) {
          // ── VÉRIFICATION APPROFONDIE avant tout rejet ──────────────
          // Chercher le numéro dans TOUS les expéditeurs YapsonPress,
          // sans restriction de date, en vérifiant que le paiement
          // est postérieur ou contemporain à la commande.
          log(`F3 🔍 DeepSearch avant rejet : ${reqPhone} (âge ${ageMin.toFixed(0)} min)…`);
          const reqDateTs = reqDate ? reqDate.getTime() : (now - ageMin * 60000);
          const deepResult = await yapsonDeepSearch(reqPhone, reqDateTs);

          if (deepResult.found && deepResult.payment) {
            // Paiement trouvé APRÈS la commande → confirmer au lieu de rejeter
            const dp = deepResult.payment;
            let montantDeep = dp.amount;
            if (montantDeep > 200000) {
              log(`F3 ⚠ DeepSearch montant ${fmtAmt(montantDeep)}F > 200 000 → plafonné`);
              montantDeep = 200000;
            }
            log(`F3 🔍 DeepSearch ${reqPhone} : paiement trouvé chez ${dp.sender} le ${new Date(dp.ts).toLocaleTimeString('fr-FR')} → ${fmtAmt(montantDeep)}F — CONFIRMATION au lieu de rejet`);

            // Approuver dans YapsonPress si pas encore fait
            if (!dp.approved && dp.msgId) {
              await yapsonApprove(dp.msgId);
            }

            try {
              let confirmLink = null;
              for (const a of await rowHandle.locator('a').all()) {
                if ((await a.textContent()).trim() === 'Confirmer') { confirmLink = a; break; }
              }
              if (!confirmLink) { log(`F3 ⚠ Lien Confirmer (deep) non trouvé pour ${reqPhone}`); continue; }
              await confirmLink.click();
              await page.waitForTimeout(800);

              const modalBtn = await waitModalConfirmBtn(15000);
              if (!modalBtn) { log(`F3 ⚠ Modale CONFIRMER (deep) non trouvée pour ${reqPhone}`); continue; }

              // Corriger le montant si différent
              if (reqAmount !== montantDeep) {
                await fixModalAmount(montantDeep);
                await page.waitForTimeout(300);
              }

              await modalBtn.click();
              await waitModalClose(15000);
              await page.waitForTimeout(1000);

              confirmedCount++;
              log(`F3 ✅ Confirmé (via DeepSearch) : ${reqPhone} → ${fmtAmt(montantDeep)}F`);
            } catch(e) { log(`⚠ Confirmation deep ${reqPhone}: ${e.message.substring(0, 80)}`); }

          } else {
            // Vraiment introuvable → rejeter
            log(`F3 — Rejet définitif: ${reqPhone} introuvable dans YapsonPress (tous expéditeurs), âge ${ageMin.toFixed(0)} min`);
            try {
              let rejectLink = null;
              for (const a of await rowHandle.locator('a').all()) {
                if ((await a.textContent()).trim() === 'Rejeter') { rejectLink = a; break; }
              }
              if (!rejectLink) { log(`F3 ⚠ Lien Rejeter non trouvé pour ${reqPhone}`); continue; }
              await rejectLink.click();
              let okBtn = null;
              for (let i = 0; i < 40; i++) {
                for (const b of await page.$$('button, a.btn, .btn')) {
                  try {
                    if ((await b.textContent()).trim() === 'OK' && await b.isVisible()) { okBtn = b; break; }
                  } catch { /* ignore */ }
                }
                if (okBtn) break;
                await page.waitForTimeout(200);
              }
              if (!okBtn) { log(`F3 ⚠ Bouton OK rejet non trouvé pour ${reqPhone}`); continue; }
              await page.waitForTimeout(300);
              const ci = await page.$('input[placeholder="Commentaire"], textarea[placeholder="Commentaire"]');
              if (ci) { await ci.fill('Expiré'); await page.waitForTimeout(200); }
              for (const b of await page.$$('button, a.btn, .btn')) {
                try {
                  if ((await b.textContent()).trim() === 'OK' && await b.isVisible()) { await b.click(); break; }
                } catch { /* ignore */ }
              }
              await page.waitForTimeout(2000);
              rejectedCount++;
              log(`F3 ❌ Rejeté: ${reqPhone} (âge: ${ageMin.toFixed(0)} min)`);
            } catch(e) { log(`⚠ Rejet ${reqPhone}: ${e.message.substring(0, 80)}`); }
          }

        } else {
          log(`F3 ⏳ En attente: ${reqPhone} introuvable (fenêtre principale) — âge ${ageMin.toFixed(0)} min < ${rejectMin} min`);
        }
      }
    } catch(e) { log(`⚠ Erreur ligne ${ri}: ${e.message.substring(0, 80)}`); }
  }

  log(`F3 [5/5] ✅ Résultat : ${confirmedCount} confirmé(s), ${rejectedCount} rejeté(s), ${approvedCount} approuvé(s) YapsonPress`);
  state.confirmed += confirmedCount;
  state.rejected += rejectedCount;
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
  // Vérifier le token YapsonPress au démarrage
  if (!state.yapsonToken) {
    log('⚠ YAPSON_TOKEN manquant — configurez-le dans le dashboard (section Token YapsonPress)');
  } else {
    log(`🔑 Token YapsonPress chargé (${state.yapsonToken.length} chars)`);
  }
  state.status = state.cookies ? 'running' : 'waiting_cookies';

  while (true) {
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
      if (e.message.includes('ookies')) {
        log('🍪 En attente de nouveaux cookies…');
      } else {
        await new Promise(r => setTimeout(r, 5000));
      }
    }
    await new Promise(r => setTimeout(r, INTERVAL_SEC * 1000));
  }
}

// ── Dashboard HTML ────────────────────────────────────────────
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
.status.starting{background:#89b4fa;color:#1e1e2e}
.status.paused{background:#fab387;color:#1e1e2e}
.status.waiting_cookies{background:#f38ba8;color:#1e1e2e;animation:pulse 1s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
.logs{background:#0a0e18;border-radius:10px;padding:14px;max-height:300px;overflow-y:auto}
.logs div{font-size:11.5px;color:#94a3b8;line-height:1.8;border-bottom:1px solid #1e1e2e;padding:2px 0}
.section{background:#1e1e2e;border-radius:10px;padding:16px;margin-bottom:16px}
.section-title{font-size:12px;font-weight:bold;margin-bottom:10px}
.row{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
input,textarea{background:#313244;color:#cdd6f4;border:1px solid #45475a;border-radius:6px;padding:8px 12px;font-size:13px}
select{background:#313244;color:#cdd6f4;border:1px solid #45475a;border-radius:6px;padding:6px 10px;font-size:13px}
.btn{border:none;border-radius:6px;padding:8px 16px;font-size:13px;font-weight:bold;cursor:pointer}
.btn-stop{background:#f38ba8;color:#1e1e2e}
.btn-start{background:#a6e3a1;color:#1e1e2e}
.btn-neutral{background:#89b4fa;color:#1e1e2e}
.btn-green{background:#a6e3a1;color:#1e1e2e}
.btn-yellow{background:#f9e2af;color:#1e1e2e}
.badge{display:inline-block;background:#313244;border-radius:6px;padding:2px 8px;font-size:11px;margin:2px}
.token-ok{color:#a6e3a1;font-size:11px}
.token-ko{color:#f38ba8;font-size:11px}
.hint{font-size:10px;color:#6c7086;margin-top:6px}
</style>
</head>
<body>
<h1>🤖 Yapson Bot6-V2 Dashboard</h1>

<span class="status {{STATUS_CLASS}}">{{STATUS_LABEL}}</span>
<span class="badge">Fonction: {{FONCTION}}</span>
<span class="badge">Polls: {{POLLS}}</span>
<span class="badge">Dernière exécution: {{LAST_RUN}}</span>

{{CONTROL_BUTTONS}}

{{TOKEN_FORM}}

{{COOKIES_FORM}}

{{F3_CONFIG_FORM}}

<div class="grid">
  <div class="card"><div class="val">{{CONFIRMED}}</div><div class="lbl">✅ Confirmés</div></div>
  <div class="card"><div class="val">{{APPROVED}}</div><div class="lbl">🟢 Approuvés (YapsonPress)</div></div>
  <div class="card"><div class="val">{{REJECTED}}</div><div class="lbl">❌ Rejetés</div></div>
  <div class="card"><div class="val">{{ERRORS}}</div><div class="lbl">⚠ Erreurs</div></div>
</div>

<div class="logs">{{LOGS}}</div>
</body>
</html>`;

// ── Route GET / ───────────────────────────────────────────────
app.get('/', (req, res) => {
  const statusLabelsMap = {
    running: '🟢 Actif',
    error: '🔴 Erreur',
    starting: '🔵 Démarrage',
    paused: '⏸ En pause',
    waiting_cookies: '🍪 Cookies requis',
    connected: '🟢 Connecté',
  };

  // ── Boutons contrôle ──
  const isPaused = paused;
  const controlButtons = `
<div class="section">
  <div class="row">
    ${isPaused
      ? '<form method="POST" action="/control" style="display:inline"><input type="hidden" name="action" value="start"><button class="btn btn-start" type="submit">▶ Relancer</button></form>'
      : '<form method="POST" action="/control" style="display:inline"><input type="hidden" name="action" value="stop"><button class="btn btn-stop" type="submit">⏸ Arrêter</button></form>'
    }
    <form method="POST" action="/control" style="display:inline">
      <input type="hidden" name="action" value="reset_cookies">
      <button class="btn btn-neutral" type="submit">🍪 Réinitialiser cookies</button>
    </form>
    <span style="font-size:11px;color:#6c7086">Cookies: ${state.cookiesReady ? '✅ Actifs' : '❌ Non fournis'}</span>
  </div>
</div>`;

  // ── Formulaire Token YapsonPress ──
  const hasToken = !!state.yapsonToken;
  const tokenMasked = hasToken
    ? state.yapsonToken.substring(0, 8) + '••••••••••••••••' + state.yapsonToken.slice(-4)
    : '';
  const tokenForm = `
<div class="section">
  <div class="section-title" style="color:#fab387">🔑 Token YapsonPress</div>
  <form method="POST" action="/yapson-token">
    <div class="row">
      <input type="text" name="token" placeholder="Bearer token YapsonPress…"
        value="${hasToken ? tokenMasked : ''}"
        style="width:380px;font-family:monospace"
        autocomplete="off">
      <button type="submit" class="btn btn-yellow">💾 Enregistrer</button>
      ${hasToken ? '<span class="token-ok">✅ Token actif</span>' : '<span class="token-ko">❌ Token manquant — erreurs 401</span>'}
    </div>
    <div class="hint">
      ⚠ Colle le token complet (sans "Bearer"). Il sera utilisé immédiatement sans redémarrage.
      ${hasToken ? `<br>Actuel : <code style="color:#cba6f7">${tokenMasked}</code>` : ''}
    </div>
  </form>
</div>`;

  // ── Formulaire Cookies ──
  const cookiesForm = !state.cookiesReady ? `
<div class="section">
  <div class="section-title" style="color:#f38ba8">🍪 Cookies my-managment requis</div>
  <div style="font-size:11px;color:#6c7086;margin-bottom:10px">
    1. Connecte-toi sur my-managment.com dans ton navigateur<br>
    2. F12 → Application → Cookies → my-managment.com<br>
    3. Copie tout en JSON (extension EditThisCookie) et colle ci-dessous
  </div>
  <form method="POST" action="/cookies">
    <textarea name="cookies" rows="4"
      placeholder='[{"name":"session","value":"...","domain":".my-managment.com",...}]'
      style="width:100%;font-family:monospace;font-size:11px;resize:vertical"></textarea>
    <button type="submit" class="btn btn-green" style="margin-top:8px">🍪 Injecter les cookies</button>
  </form>
</div>` : '';

  // ── Config F3 ──
  const f3ConfigForm = (FONCTION === 'F3') ? `
<div class="section">
  <form method="POST" action="/f3-config">
    <div class="row">
      <span class="section-title" style="color:#89b4fa;margin-bottom:0">⚙ Config F3</span>
      <label style="font-size:12px;color:#cdd6f4">
        Marge YapsonPress :&nbsp;
        <select name="marginMin">
          ${[2,10,15,30].map(v => `<option value="${v}"${f3Config.marginMin===v?' selected':''}>${v} min</option>`).join('')}
        </select>
      </label>
      <label style="font-size:12px;color:#cdd6f4">
        Seuil rejet :&nbsp;
        <select name="rejectMin">
          ${[30,45,50,60].map(v => `<option value="${v}"${f3Config.rejectMin===v?' selected':''}>${v} min</option>`).join('')}
        </select>
      </label>
      <button type="submit" class="btn btn-green">Appliquer</button>
      <span style="font-size:11px;color:#6c7086">Actuel : marge=${f3Config.marginMin}min | rejet>=${f3Config.rejectMin}min</span>
    </div>
  </form>
</div>` : '';

  const html = DASHBOARD_HTML
    .replace('{{STATUS_CLASS}}', state.status)
    .replace('{{STATUS_LABEL}}', statusLabelsMap[state.status] || state.status)
    .replace('{{FONCTION}}', state.fonction)
    .replace('{{POLLS}}', state.polls)
    .replace('{{LAST_RUN}}', state.lastRun ? new Date(state.lastRun).toLocaleTimeString('fr-FR') : '—')
    .replace('{{CONTROL_BUTTONS}}', controlButtons)
    .replace('{{TOKEN_FORM}}', tokenForm)
    .replace('{{COOKIES_FORM}}', cookiesForm)
    .replace('{{F3_CONFIG_FORM}}', f3ConfigForm)
    .replace('{{CONFIRMED}}', state.confirmed)
    .replace('{{APPROVED}}', state.approved)
    .replace('{{REJECTED}}', state.rejected)
    .replace('{{ERRORS}}', state.errors)
    .replace('{{LOGS}}', state.logs.slice(0, 60).map(l => `<div>${l}</div>`).join(''));

  res.send(html);
});

// ── Routes POST ───────────────────────────────────────────────
app.post('/yapson-token', (req, res) => {
  const raw = (req.body.token || '').trim();
  // Ignorer si c'est le token masqué (contient ••)
  if (!raw || raw.includes('•')) {
    log('🔑 Token inchangé (valeur masquée soumise)');
    res.redirect('/');
    return;
  }
  // Nettoyer "Bearer " éventuel
  const token = raw.replace(/^Bearer\s+/i, '').trim();
  if (token.length < 10) {
    log('❌ Token trop court — ignoré');
    res.redirect('/');
    return;
  }
  state.yapsonToken = token;
  log(`🔑 Token YapsonPress mis à jour (${token.length} chars) — actif immédiatement`);
  res.redirect('/');
});

app.post('/control', (req, res) => {
  const action = req.body.action || '';
  if (action === 'stop') {
    setPaused(true);
  } else if (action === 'start') {
    setPaused(false);
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
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('Doit être un tableau JSON');
    state.cookies = raw;
    state.cookiesReady = false;
    log(`🍪 ${parsed.length} cookie(s) reçu(s) — injection en cours…`);
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
