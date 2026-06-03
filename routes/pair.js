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

// Attend que la WebSocket interne de Baileys soit vraiment ouverte (readyState === 1)
// puis demande le pairing code. Retry toutes les 500ms jusqu'à 15s max.
async function waitForWsAndPair(Prince, num, maxWaitMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
        const ws = Prince.ws;
        // readyState 1 = OPEN dans le standard WebSocket
        if (ws && (ws.readyState === 1 || ws.readyState === ws.OPEN)) {
            // Pause supplémentaire : laisse le handshake Noise Protocol WhatsApp finir
            await delay(1000);
            return await Prince.requestPairingCode(num);
        }
        await delay(500);
    }
    throw new Error("WebSocket non ouverte après " + maxWaitMs + "ms");
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
            browser: Browsers.ubuntu("Chrome"),
            shouldIgnoreJid: jid => !!jid?.endsWith('@g.us'),
            getMessage: async () => undefined,
            markOnlineOnConnect: false,
            connectTimeoutMs: 60_000,
            keepAliveIntervalMs: 30_000,
            retryRequestDelayMs: 3_000,
        });

        Prince.ev.on('creds.update', saveCreds);

        Prince.ev.on("connection.update", async (s) => {
            if (dead) return;
            const { connection, lastDisconnect, qr } = s;

            // ── Dès "connecting" : on lance l'attente WS + pairing ───────────
            // On ne demande PAS le code ici directement — on attend que la
            // WebSocket soit réellement ouverte (readyState === 1) avant d'appeler
            // requestPairingCode. Sans ça, WhatsApp reçoit la demande trop tôt
            // et génère un QR ou renvoie 405.
            if (connection === "connecting" && !pairingRequested) {
                pairingRequested = true;

                waitForWsAndPair(Prince, num)
                    .then(code => {
                        if (dead) return;
                        console.log(`✅ Code généré pour ${num}: ${code}`);
                        sendOnce(200, { code });
                    })
                    .catch(err => {
                        if (dead) return;
                        console.error("requestPairingCode error:", err?.message || err);
                        dead = true;
                        clearTimeout(globalTimeout);
                        try { Prince.ws?.close(); } catch (_) {}
                        cleanUp();
                        sendOnce(500, { code: "Impossible de générer le code — réessayez" });
                    });

                return;
            }

            // ── QR reçu : le pairing code n'a pas pu être demandé à temps ───
            if (qr) {
                console.error("QR reçu au lieu du pairing code — abandon");
                dead = true;
                clearTimeout(globalTimeout);
                try { Prince.ws?.close(); } catch (_) {}
                await cleanUp();
                sendOnce(503, { code: "Erreur pairing — réessayez" });
                return;
            }

            // ── Connexion établie : lire creds et envoyer la session ─────────
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
                    try { Prince.ws?.close(); } catch (_) {}
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
