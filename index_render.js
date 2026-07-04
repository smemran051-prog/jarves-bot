const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const http = require('http');
const url = require('url');
const PORT = process.env.PORT || 3000;
let BOT_ACTIVE = true;

const server = http.createServer((req, res) => {
  const p = url.parse(req.url, true).pathname;
  if (p === '/off') { BOT_ACTIVE = false; res.end('OFF'); }
  else if (p === '/on') { BOT_ACTIVE = true; res.end('ON'); }
  else { res.writeHead(200); res.end('Jarves Running'); }
});
server.listen(PORT, () => console.log(`🌐 Health: PORT ${PORT}`));

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('/tmp/jarves-auth');
  
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    browser: ['Jarves Bot', 'Chrome', '1.0.0']
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'open') console.log('✅ Jarves Ready!');
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) { console.log('🔄 Reconnecting...'); startBot(); }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
      const from = msg.key.remoteJid;
      if (!BOT_ACTIVE) return;
      if (text.toLowerCase().includes('update') || text.toLowerCase().includes('আপডেট')) {
        await sock.sendMessage(from, { text: '🔍 *Searching...*\n\nSheet module coming soon for Render.' });
      } else if (!from.includes('@g.us')) {
        await sock.sendMessage(from, { text: '🤖 *Jarves Here!*\n\nUse "আপডেট SERIAL" to search.' });
      }
    }
  });
}

startBot();