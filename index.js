const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const http = require('http');
const url = require('url');
const https = require('https');

const SESSION_DIR = './session';
const PORT = 3000;

// =====================================================
// CONFIG
// =====================================================
let MASTER_NUMBER = '01917255275';
let BOT_ACTIVE = true;
let PAUSE_UNTIL = null;
let DAILY_LIMIT = 3;
let KEYWORDS = ['আপডেট', 'update', 'status', 'info', 'তথ্য', 'খোঁজ', 'search', 'warranty', 'ওয়ারেন্টি', 'guarantee'];
let GROUPS = [];

// =====================================================
// CONFIG SHEET (memory)
// =====================================================
const CONFIG_SHEET_ID = '1lsTcuBvuxPxUqDqD04sMPJI9Hjuo0V77teQ3dvPc7LQ';
const CONFIG_SHEET_NAME = 'memory';

// =====================================================
// MODULE LOADER
// =====================================================
const modules = {};
const moduleOrder = ['bogie1_sheet', 'bogie2_ocr', 'bogie3_cache', 'bogie4_intent', 'bogie5_reply', 'bogie6_admin', 'bogie7_ai'];

console.log('🚃 Loading bogies...\n');
moduleOrder.forEach(name => {
  try {
    modules[name] = require(`./modules/${name}.js`);
    console.log(`  🚃 ${name} connected`);
  } catch (e) {}
});
console.log('');

// =====================================================
// NUMBER MATCHER
// =====================================================
function matchNumber(num1, num2) {
  const clean = (n) => { let c = (n || '').replace(/[^0-9]/g, ''); if (c.startsWith('880')) c = '0' + c.substring(3); return c; };
  return clean(num1).slice(-10) === clean(num2).slice(-10) && clean(num1).length >= 10 && clean(num2).length >= 10;
}

// =====================================================
// CACHE
// =====================================================
let sheetCache = null;
let lastCacheTime = null;
async function refreshCache() {
  if (modules['bogie1_sheet']) {
    try {
      const result = await modules['bogie1_sheet'].downloadSheetCSV('16_zjNAu2cQ5Dqj4ijU4fnBe_Gt7iTodCjhkjfQNBQD0', '0');
      if (result && result.length > 0) { sheetCache = result; lastCacheTime = new Date(); console.log(`📦 Cache: ${result.length} rows`); }
    } catch (e) {}
  }
}

// =====================================================
// CONFIG LOADER (memory sheet থেকে)
// =====================================================
async function loadConfigFromSheet() {
  try {
    const sheetUrl = `https://docs.google.com/spreadsheets/d/${CONFIG_SHEET_ID}/export?format=csv&gid=294604320`;
    const res = await new Promise((resolve, reject) => {
      https.get(sheetUrl, (response) => {
        let data = '';
        response.on('data', (chunk) => data += chunk);
        response.on('end', () => resolve(data));
      }).on('error', reject);
    });
    const rows = res.split('\n').filter(r => r.trim());
    const config = {};
    rows.forEach(row => {
      const cols = row.split(',').map(c => c.replace(/^"|"$/g, '').trim());
      if (cols.length >= 2) config[cols[0].toLowerCase()] = cols[1];
    });
    if (config['master']) MASTER_NUMBER = config['master'].replace(/[^0-9]/g, '');
    if (config['limit']) DAILY_LIMIT = parseInt(config['limit']);
    if (config['keywords']) KEYWORDS = config['keywords'].split(',').map(k => k.trim());
    if (config['groups']) GROUPS = config['groups'].split(',').map(g => g.trim());
    if (config['active'] !== undefined) BOT_ACTIVE = config['active'].toLowerCase() === 'true';
    console.log(`  👑 Master: ${MASTER_NUMBER} | Limit: ${DAILY_LIMIT} | Active: ${BOT_ACTIVE}`);
  } catch (e) {}
}

// =====================================================
// SEARCH LIMIT
// =====================================================
const searchLimit = new Map();
function checkLimit(userId, serialNumber) {
  const today = new Date().toDateString();
  const key = `${userId}_${serialNumber}_${today}`;
  if (!searchLimit.has(key)) { searchLimit.set(key, { count: 1 }); return { allowed: true, remaining: DAILY_LIMIT - 1 }; }
  const data = searchLimit.get(key);
  if (data.count >= DAILY_LIMIT) return { allowed: false, remaining: 0 };
  data.count++;
  return { allowed: true, remaining: DAILY_LIMIT - data.count };
}
setInterval(() => { const today = new Date().toDateString(); for (const [key] of searchLimit) if (!key.includes(today)) searchLimit.delete(key); }, 3600000);

// =====================================================
// SERIAL EXTRACT
// =====================================================
function extractSerials(text) {
  let cleanText = text;
  KEYWORDS.forEach(kw => { cleanText = cleanText.replace(new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), ' '); });
  const words = cleanText.split(/[\s,.;:!?()\[\]{}\-|]+/);
  const serials = [];
  for (const word of words) {
    const cleaned = word.replace(/[^A-Za-z0-9]/g, '');
    if (cleaned.length < 11 || cleaned.length > 20) continue;
    if ((cleaned.match(/\d/g) || []).length < 11) continue;
    if (/^(01|8801|096)\d+$/.test(cleaned)) continue;
    if (/^(INV|CMP|SO|CHL)/i.test(cleaned)) continue;
    if (!/\d/.test(cleaned[0]) || !/\d/.test(cleaned.slice(-1))) continue;
    serials.push(cleaned.toUpperCase());
  }
  if (serials.length === 0) { const longNumber = text.match(/\d{11,20}/); if (longNumber && !/^(01|8801|096)\d+$/.test(longNumber[0])) serials.push(longNumber[0]); }
  return serials;
}

// =====================================================
// DATE HELPERS
// =====================================================
function parseDate(str) {
  if (!str) return null;
  str = String(str).trim();
  let m = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/); if (m) return new Date(parseInt(m[1]), parseInt(m[2])-1, parseInt(m[3]));
  m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); if (m) return new Date(parseInt(m[3]), parseInt(m[1])-1, parseInt(m[2]));
  return null;
}
function monthsBetween(d1, d2) { return (d2.getFullYear() - d1.getFullYear()) * 12 + (d2.getMonth() - d1.getMonth()); }

// =====================================================
// WARRANTY
// =====================================================
function checkWarranty(entries, client) {
  const lastEntry = entries[entries.length - 1];
  const salesDate = lastEntry.salesDate || entries.find(e => e.salesDate)?.salesDate;
  if (!salesDate) return { status: 'unknown', message: '❌ Sales date not found in sheet.' };
  const purchaseDate = parseDate(salesDate);
  if (!purchaseDate) return { status: 'unknown', message: '❌ Invalid sales date format.' };
  const complaintDate = parseDate(lastEntry.inDate) || new Date();
  const months = monthsBetween(purchaseDate, complaintDate);
  const isRaynsIT = client && client.toLowerCase().includes('rayns it');
  const warrantyPeriod = isRaynsIT ? 15 : 13;
  if (months <= warrantyPeriod) return { status: 'in', message: `🛡️ *Warranty Status:* In Warranty\n📅 Purchased: ${salesDate} (${months} months ago)\n✅ Coverage: ${warrantyPeriod} months${isRaynsIT ? ' (Rayns IT Ltd)' : ''}` };
  else { const expired = months - warrantyPeriod; return { status: 'out', message: `🛡️ *Warranty Status:* Out of Warranty\n📅 Purchased: ${salesDate} (${months} months ago)\n⛔ Expired: ${expired} months ago\n📋 Policy: ${warrantyPeriod} months${isRaynsIT ? ' (Rayns IT Ltd)' : ''}` }; }
}

// =====================================================
// RESULT FORMATTER
// =====================================================
function formatSingleResult(serialNumber, data, prevProduct, prevClient) {
  const entries = data.entries;
  const last = entries[entries.length - 1];
  const currentProduct = last.product || 'N/A';
  const currentClient = last.client || 'N/A';
  const showProduct = !prevProduct || prevProduct !== currentProduct;
  const showClient = !prevClient || prevClient !== currentClient;
  let reply = '';
  if (entries.length === 1) {
    reply += `🔢 *Serial:* ${last.serial}\n`; if (showProduct) reply += `📦 *Product:* ${currentProduct}\n`; if (showClient) reply += `🏢 *Client:* ${currentClient}\n`;
    reply += `📥 *Lab In:* ${last.inDate || 'N/A'}\n🔧 *Work:* ${last.remarks || 'N/A'}\n📍 *Status:* ${last.status || 'N/A'}\n📤 *Lab Out:* ${last.labOut || 'Not yet'}`;
  } else {
    reply += `🔢 *Serial:* ${last.serial}\n`; if (showProduct) reply += `📦 *Product:* ${currentProduct}\n`; if (showClient) reply += `🏢 *Client:* ${currentClient}\n`;
    reply += `📊 *Total Service:* ${entries.length} times\n\n`;
    const previous = entries.slice(-2, -1);
    if (previous.length > 0) { reply += `📋 *Previous Service:*\n`; previous.forEach((entry) => { reply += `  ${entries.length - 1}. 📥 ${entry.inDate || '?'} | 📤 ${entry.labOut || '?'} | 🔧 ${entry.remarks || '-'}\n`; }); reply += `\n`; }
    reply += `─── *Latest Service* ───\n📥 *Lab In:* ${last.inDate || 'N/A'}\n🔧 *Work:* ${last.remarks || 'N/A'}\n📍 *Status:* ${last.status || 'N/A'}\n📤 *Lab Out:* ${last.labOut || 'Not yet'}`;
  }
  return { reply, product: currentProduct, client: currentClient };
}

// =====================================================
// HEALTH SERVER
// =====================================================
const server = http.createServer((req, res) => {
  const p = url.parse(req.url, true).pathname;
  if (p === '/off') { BOT_ACTIVE = false; PAUSE_UNTIL = null; res.writeHead(200); res.end('OFF'); }
  else if (p === '/on') { BOT_ACTIVE = true; PAUSE_UNTIL = null; res.writeHead(200); res.end('ON'); }
  else if (p === '/status') { res.writeHead(200); res.end(JSON.stringify({ active: BOT_ACTIVE, master: MASTER_NUMBER, uptime: Math.floor(process.uptime()/60)+'m' })); }
  else { res.writeHead(200); res.end('Jarves Running'); }
});
server.listen(PORT, () => console.log(`🌐 Health check on PORT ${PORT}\n`));

// =====================================================
// WHATSAPP CLIENT (লোকাল Edge)
// =====================================================
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: SESSION_DIR }),
  puppeteer: {
    headless: true,
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    args: ['--no-sandbox','--disable-gpu']
  },
  webVersionCache: { type: 'remote', remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html' }
});

client.on('qr', (qr) => { console.log('\n📱 Scan QR:\n'); qrcode.generate(qr, { small: true }); });

client.on('ready', async () => {
  console.log('✅ Jarves Ready!');
  console.log(`👑 Master: ${MASTER_NUMBER}\n🔢 Limit: ${DAILY_LIMIT}/day\n👥 Groups: All\n🔑 Keywords: ${KEYWORDS.join(', ')}`);
  await loadConfigFromSheet();
  await refreshCache();
  for (const [name, mod] of Object.entries(modules)) { if (mod.onReady) { try { await mod.onReady(client, {}); } catch (e) {} } }
  setInterval(refreshCache, 90 * 60 * 1000);
  setInterval(loadConfigFromSheet, 30 * 60 * 1000);
});

// =====================================================
// MESSAGE HANDLER
// =====================================================
client.on('message', async (msg) => {
  try {
    const chat = await msg.getChat();
    let body = msg.body?.trim() || '';
    const from = msg.from || '';
    const isMaster = matchNumber(from, MASTER_NUMBER);
    const isSelf = matchNumber(from, msg.to);

    if (modules['bogie2_ocr'] && msg.hasMedia) { const ocrSerial = await modules['bogie2_ocr'].process(msg, client); if (ocrSerial) body = (body ? body + ' ' : '') + 'update ' + ocrSerial; }

    if ((isMaster || isSelf) && (body === '/off' || body.startsWith('/off '))) {
      const parts = body.split(' ');
      if (parts[1] === 'forever') { BOT_ACTIVE = false; PAUSE_UNTIL = null; await msg.reply('⏸️ Paused Forever'); }
      else if (parts[1]?.endsWith('h')) { const h = parseInt(parts[1]); PAUSE_UNTIL = Date.now() + h*3600000; BOT_ACTIVE = false; await msg.reply(`⏸️ Paused ${h}h`); }
      else if (parts[1]?.endsWith('m')) { const m = parseInt(parts[1]); PAUSE_UNTIL = Date.now() + m*60000; BOT_ACTIVE = false; await msg.reply(`⏸️ Paused ${m}m`); }
      else { BOT_ACTIVE = false; PAUSE_UNTIL = Date.now() + 1800000; await msg.reply('⏸️ Paused 30min'); }
      return;
    }
    if ((isMaster || isSelf) && body === '/on') { BOT_ACTIVE = true; PAUSE_UNTIL = null; await msg.reply('▶️ Resumed!'); return; }
    if (!BOT_ACTIVE && PAUSE_UNTIL && Date.now() > PAUSE_UNTIL) { BOT_ACTIVE = true; PAUSE_UNTIL = null; }
    if (!BOT_ACTIVE) { if ((isMaster || isSelf) && (body==='/status'||body==='/on'||body.startsWith('/off'))) {} else return; }

    if (isMaster || isSelf) {
      if (body === '/status') { const s = `📊 *Jarves Status*\n🤖 Active: ${BOT_ACTIVE?'✅':'⏸️'}\n⏱ Uptime: ${Math.floor(process.uptime()/60)}m\n👑 Master: ${MASTER_NUMBER}\n🔢 Limit: ${DAILY_LIMIT}/day\n📦 Cache: ${lastCacheTime ? lastCacheTime.toLocaleTimeString('bn-BD') : 'None'}\n🚃 Bogies: ${Object.keys(modules).length}`; await msg.reply(s); return; }
      if (body === '/refreshcache') { await msg.reply('🔄 Refreshing...'); await refreshCache(); await msg.reply(`✅ ${sheetCache?.length || 0} rows`); return; }
      if (body.startsWith('/setlimit ')) { const v = parseInt(body.split(' ')[1]); if(v>0) { DAILY_LIMIT=v; await msg.reply(`✅ Limit=${v}`); } else await msg.reply('❌ Invalid'); return; }
      if (body.startsWith('/addkeyword ')) { const kw=body.split(' ')[1].toLowerCase(); if(!KEYWORDS.includes(kw)) { KEYWORDS.push(kw); await msg.reply(`✅ "${kw}" added`); } else await msg.reply('⚠️ Exists'); return; }
      if (body.startsWith('/removekeyword ')) { const kw=body.split(' ')[1].toLowerCase(); KEYWORDS=KEYWORDS.filter(k=>k!==kw); await msg.reply(`✅ Removed`); return; }
      if (body === '/listkeywords') { await msg.reply(`🔑 ${KEYWORDS.join(', ')}`); return; }
      if (body.startsWith('/setmaster ')) { const num=body.split(' ')[1]; MASTER_NUMBER=num.replace(/[^0-9]/g,''); await msg.reply(`✅ Master=${MASTER_NUMBER}`); return; }
      if (body.startsWith('/addgroup ')) { const g=body.replace('/addgroup ','').trim(); if(!GROUPS.includes(g)) { GROUPS.push(g); await msg.reply(`✅ "${g}" added`); } else await msg.reply('⚠️ Exists'); return; }
      if (body.startsWith('/removegroup ')) { const g=body.replace('/removegroup ','').trim(); GROUPS=GROUPS.filter(x=>x!==g); await msg.reply(`✅ Removed`); return; }
      if (body === '/listgroups') { await msg.reply(`👥 ${GROUPS.length>0?GROUPS.join('\n'):'All groups'}`); return; }
      if (body.startsWith('/addsheet ') && modules['bogie1_sheet']) { const p=body.replace('/addsheet ','').trim().split(' '); if(p.length>=3) { const r=modules['bogie1_sheet'].addSheet(p[0],p[1],p.slice(2).join(' ')); await msg.reply(r.message); } else await msg.reply('❌ /addsheet <link> <type> <name>'); return; }
      if (body === '/listsheets' && modules['bogie1_sheet']) { await msg.reply(modules['bogie1_sheet'].listSheets()); return; }
      if (isSelf && !body.startsWith('/')) { await msg.reply('👑 Admin Panel\n\n/status /refreshcache /setlimit /setmaster\n/addgroup /removegroup /listgroups\n/addsheet /listsheets\n/addkeyword /removekeyword /listkeywords\n/off /on'); return; }
    }

    const keywordFound = KEYWORDS.some(kw => body.toLowerCase().includes(kw));
    if (keywordFound) {
      const serialNumbers = extractSerials(body);
      if (serialNumbers.length === 0) { if (!chat.isGroup) await msg.reply('❌ সিরিয়াল পাওয়া যায়নি'); return; }
      if (modules['bogie1_sheet']) {
        let reply = '', lastProduct = null, lastClient = null;
        for (let i = 0; i < serialNumbers.length; i++) {
          const serialNumber = serialNumbers[i];
          const { allowed } = checkLimit(from, serialNumber);
          if (!allowed) { reply += `⚠️ ${serialNumber}: limit\n\n`; continue; }
          let result = null;
          if (sheetCache) { const { entries } = modules['bogie1_sheet'].parseSheetData(sheetCache); const matches = entries.filter(e => e.serial.toLowerCase() === serialNumber.toLowerCase()); if (matches.length > 0) result = { found: true, data: { sheetId:'cache', serial:serialNumber, totalCount:matches.length, entries:matches, sheetName:'Cache', sheetType:'default' } }; }
          if (!result) result = await modules['bogie1_sheet'].searchSheets(serialNumber, body);
          if (result && result.found) {
            userContext.set(from, { lastSerial: serialNumber, lastResult: result, timestamp: Date.now() });
            if (/warranty|ওয়ারেন্টি|guarantee/i.test(body)) { const data = result.data; const clientName = data.entries[data.entries.length-1]?.client || ''; const w = checkWarranty(data.entries, clientName); reply += `─── *${serialNumber}* ───\n${w.message}\n\n`; }
            else { const formatted = formatSingleResult(serialNumber, result.data, lastProduct, lastClient); reply += formatted.reply + '\n\n'; lastProduct = formatted.product; lastClient = formatted.client; }
          } else { if (!chat.isGroup) reply += `❌ ${serialNumber}: Not found\n\n`; }
        }
        if (reply) await msg.reply(reply.trim());
        return;
      }
      await msg.reply('⚠️ Sheet module not loaded.');
      return;
    }
  } catch (e) { console.error(e.message); }
});

client.on('disconnected', () => { setTimeout(() => client.initialize(), 5000); });

console.log('🚂 Starting Jarves...\n');
client.initialize();