const { 
    princeId,
    removeFile
} = require('../mayel');
const express = require('express');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
let router = express.Router();
const pino = require("pino");
const {
    default: princeConnect,
    useMultiFileAuthState,
    delay,
    Browsers,
    makeCacheableSignalKeyStore,
} = require("@whiskeysockets/baileys");

const XHRIS_CHANNEL_URL = 'https://whatsapp.com/channel/0029Vark1I1AYlUR1G8YMX31';
const XHRIS_REPO_URL   = 'https://github.com/Eric-Xhris/XHRIS-MD-V2';
const sessionDir = path.join(__dirname, "session");

async function sendSessionMessage(sock, jid, sessionString) {
    await sock.sendMessage(jid, {
        text: sessionString + `\n\n> *ᴘᴏᴡᴇʀᴇᴅ ʙʏ xʜʀɪs ᴛᴇᴄʜ*`
    });
    await delay(1500);
    await sock.sendMessage(jid, {
        text: `✅ *XHRIS MD V2 — Session générée*\n\n` +
              `📋 Copiez le message ci-dessus et utilisez-le comme votre SESSION_ID\n\n` +
              `🚀 Déployez votre bot sur : https://xhrishost.site\n` +
              `📺 Chaîne XHRIS MD : ${XHRIS_CHANNEL_URL}\n` +
              `🔧 Repo GitHub : ${XHRIS_REPO_URL}\n\n` +
              `> *ᴘᴏᴡᴇʀᴇᴅ ʙʏ xʜʀɪs ᴛᴇᴄʜ*`
    });
}

router.get('/', async (req, res) => {
    const id  = princeId();
    const num = (req.query.number || "").replace(/[^0-9]/g, '');

    if (!num) {
        return res.status(400).json({ code: "Numéro manquant" });
    }

    let responseSent   = false;
    let sessionCleaned = false;
    let dead = false;
    let pairingRequested = false;

    async function cleanUp() {
        if (!sessionCleaned) {
            sessionCleaned = true;
            await removeFile(path.join(sessionDir, id)).catch(() => {});
        }
    }

    function sendOnce(statusCode, body) {
        if (!responseSent && !res.headersSent) {
            responseSent = true;
            res.status(statusCode).json(body);
        }
    }

    const globalTimeout = setTimeout(() => {
        if (!dead) {
            dead = true;
            sendOnce(504, { code: "Timeout — réessayez dans un instant" });
        }
    }, 55000);

    try {
        const { state, saveCreds } = await useMultiFileAuthState(path.join(sessionDir, id));

        const Prince = princeConnect({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
            },
            printQRInTerminal: false,
            logger: pino({ level: "silent" }).child({ level: "silent" }),
            // macOS Safari est moins suspect que Ubuntu Chrome pour WhatsApp
            browser: Browsers.macOS("Safari"),
            shouldIgnoreJid: jid => !!jid?.endsWith('@g.us'),
            getMessage: async () => undefined,
            markOnlineOnConnect: false,
            connectTimeoutMs: 60_000,
            keepAliveIntervalMs: 30_000,
            retryRequestDelayMs: 3_000,
        });

        Prince.ev.on('creds.update', saveCreds);

        // ── FIX PRINCIPAL : écouter l'event 'open' de la WebSocket ──────────
        // "connection === connecting" arrive trop tôt (TCP connecté mais
        // handshake Noise Protocol pas encore terminé). On attend que la
        // socket WebSocket soit vraiment ouverte avant de demander le code.
        Prince.ws.on('open', async () => {
            if (dead || pairingRequested) return;
            pairingRequested = true;

            // Délai de 1.5s pour laisser le handshake Noise/WhatsApp se finir
            // après l'ouverture TCP — sans ça, requestPairingCode arrive
            // avant que le serveur WhatsApp soit prêt → 405
            await delay(1500);

            if (dead) return;

            try {
                const code = await Prince.requestPairingCode(num);
                console.log(`✅ Code généré pour ${num}: ${code}`);
                sendOnce(200, { code });
            } catch (err) {
                console.error("requestPairingCode error:", err?.message || err);
                if (!dead) {
                    dead = true;
                    clearTimeout(globalTimeout);
                    try { Prince.ws.close(); } catch (_) {}
                    await cleanUp();
                    sendOnce(500, { code: "Impossible de générer le code — réessayez" });
                }
            }
        });

        Prince.ev.on("connection.update", async (s) => {
            if (dead) return;
            const { connection, lastDisconnect, qr } = s;

            // ── QR reçu : requestPairingCode n'a pas marché ─────────────────
            if (qr) {
                console.error("QR reçu au lieu du pairing code — abandon");
                dead = true;
                clearTimeout(globalTimeout);
                try { Prince.ws.close(); } catch (_) {}
                await cleanUp();
                sendOnce(503, { code: "Erreur pairing — réessayez" });
                return;
            }

            // ── Connexion établie : envoyer la session ───────────────────────
            if (connection === "open") {
                console.log(`🔗 Connexion ouverte pour ${num}`);
                await delay(6000);
                if (dead) return;

                let sessionData = null;
                for (let i = 0; i < 10 && !sessionData; i++) {
                    try {
                        const credsPath = path.join(sessionDir, id, "creds.json");
                        if (fs.existsSync(credsPath)) {
                            const data = fs.readFileSync(credsPath);
                            if (data && data.length > 100) sessionData = data;
                        }
                    } catch (e) { console.error("Read creds error:", e); }
                    if (!sessionData) await delay(3000);
                }

                if (!sessionData) {
                    dead = true;
                    clearTimeout(globalTimeout);
                    await cleanUp();
                    sendOnce(500, { code: "Impossible de lire la session" });
                    return;
                }

                try {
                    const b64 = zlib.gzipSync(sessionData).toString('base64');
                    const sessionString = 'XHRIS-MD!' + b64;

                    await delay(2000);
                    if (dead) return;

                    let sent = false;
                    for (let i = 0; i < 5 && !sent; i++) {
                        try {
                            await sendSessionMessage(Prince, Prince.user.id, sessionString);
                            sent = true;
                            console.log(`📩 Session envoyée pour ${num}`);
                        } catch (e) {
                            console.error("Send error:", e.message);
                            if (i < 4) await delay(3000);
                        }
                    }
                } catch (e) {
                    console.error("Session build error:", e);
                } finally {
                    dead = true;
                    clearTimeout(globalTimeout);
                    try { Prince.ws.close(); } catch (_) {}
                    await cleanUp();
                }
                return;
            }

            // ── Connexion fermée ─────────────────────────────────────────────
            if (connection === "close") {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                console.log(`🔌 Connexion fermée, code: ${statusCode}`);

                if (statusCode === 401 || statusCode === 405) {
                    dead = true;
                    clearTimeout(globalTimeout);
                    await cleanUp();
                    sendOnce(401, { code: "Numéro invalide ou déjà connecté — vérifiez le numéro" });
                    return;
                }

                if (dead || responseSent) return;
            }
        });

    } catch (err) {
        console.error("Fatal error:", err);
        dead = true;
        clearTimeout(globalTimeout);
        await cleanUp();
        sendOnce(500, { code: "Service is Currently Unavailable" });
    }
});

module.exports = router;
