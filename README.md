# PRINCE-Session-Generator

> WhatsApp session generator for **PRINCE-MDX** and any Baileys-based bot.  
> Supports **pair code** and **QR code** login, with session data delivered directly to your WhatsApp.

<a href='https://github.com/Mayelprince/PRINCE-MDXI/fork' target="_blank">
  <img alt='FORK REPO' src='https://img.shields.io/badge/-FORK REPO-black?style=for-the-badge&logo=github&logoColor=white'/>
</a>

---

## Features

- 🔗 **Pair Code login** — no QR scan needed, enter code in WhatsApp → Linked Devices
- 📷 **QR Code login** — traditional QR scan
- 🗜️ **Long session** — full zlib/base64 inline string (works anywhere, no DB needed)
- ⚡ Session data sent directly to your WhatsApp number after authentication

---

## Environment Variables

Set these in your hosting dashboard or `.env` file:

| Variable | Required | Description |
|---|---|---|
| `PORT` | Optional | Port to listen on. Default: `5000` |

---

## API Endpoints

| Endpoint | Description |
|---|---|
| `GET /` | Home landing page |
| `GET /pair` | Pair code login page |
| `GET /qr` | Generates and displays QR code |
| `GET /code?number=2547xxx` | Returns pair code JSON `{ code }` |
| `GET /health` | Server health status |

---

## Usage in Your Bot

### Loading the Session

```js
// lib/session.js
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const sessionDir = path.join(__dirname, '..', 'session');
const credsPath = path.join(sessionDir, 'creds.json');

if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

async function loadSession(SESSION_ID) {
    if (!SESSION_ID || typeof SESSION_ID !== 'string') {
        throw new Error('SESSION_ID is missing or invalid');
    }

    if (fs.existsSync(credsPath)) fs.unlinkSync(credsPath);

    const PREFIX = 'PRINCE-MDX!';

    if (!SESSION_ID.startsWith(PREFIX)) {
        throw new Error(`Invalid session format. Expected to start with "${PREFIX}"`);
    }

    const payload = SESSION_ID.slice(PREFIX.length);

    // LONG SESSION — decode zlib/base64 inline
    const compressedData = Buffer.from(payload, 'base64');
    const decompressedData = zlib.gunzipSync(compressedData);
    fs.writeFileSync(credsPath, decompressedData, 'utf8');
    console.log('Session loaded successfully');
}

module.exports = { loadSession };
```

### In Your Bot Start File

```js
// index.js
const { loadSession } = require('./lib/session');
const { useMultiFileAuthState, fetchLatestBaileysVersion, default: makeWASocket } = require('@whiskeysockets/baileys');

async function connectToWhatsApp() {
    await loadSession(process.env.SESSION_ID);

    const { state, saveCreds } = await useMultiFileAuthState('./session');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: !process.env.SESSION_ID,
        // ... your other options
    });

    sock.ev.on('creds.update', saveCreds);
    // ... rest of your bot logic
}

connectToWhatsApp();
```

### Example `.env` for Your Bot

```env
SESSION_ID=PRINCE-MDX!H4sIAAAAA...  # long session (full zlib string)
```

---

## Deployment

<a href='https://dashboard.heroku.com/new?template=https://github.com/Mayelprince/PRINCE-MDXI' target="_blank">
  <img alt='HEROKU DEPLOY' src='https://img.shields.io/badge/-HEROKU DEPLOY-black?style=for-the-badge&logo=heroku&logoColor=white'/>
</a>
<br>
<a href='https://dashboard.render.com' target="_blank">
  <img alt='DEPLOY TO RENDER' src='https://img.shields.io/badge/-DEPLOY TO RENDER-black?style=for-the-badge&logo=render&logoColor=white'/>
</a>
<br>
<a href='https://app.koyeb.com' target="_blank">
  <img alt='DEPLOY TO KOYEB' src='https://img.shields.io/badge/-DEPLOY TO KOYEB-black?style=for-the-badge&logo=koyeb&logoColor=white'/>
</a>

---

## Owner

<a href="https://github.com/Mayelprince">
  <img src="https://github.com/Mayelprince.png" width="150" height="150" alt="Mayel Prince" style="border-radius:50%"/>
</a>

[`ℹ️ Visit Bot Repo`](https://github.com/Mayelprince/PRINCE-MDXI)

---

## Join the Community

<a href='https://whatsapp.com/channel/0029VbCKzJ66hENmMeROfT0e' target="_blank">
  <img alt='JOIN WACHANNEL' src='https://img.shields.io/badge/-JOIN WACHANNEL-black?style=for-the-badge&logo=whatsapp&logoColor=white'/>
</a>

---

## Repo Star History

[![PRINCE-Session](https://api.star-history.com/svg?repos=Mayelprince/PRINCE-MDXI&type=Timeline)](#)
