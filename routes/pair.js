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
            // IMPORTANT : on désactive le QR complètement pour forcer le pairing code
            // Baileys n'émettra pas l'event 'qr' si cette option est absente du flow
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

            // ── Premier event "connecting" reçu ─────────────────────────────
            // On attend 8 secondes fixes : c'est le temps nécessaire pour que
            // Baileys finisse le handshake Noise Protocol avec WhatsApp sur
            // une infra cloud (Railway, Heroku, etc.). Moins que ça = QR émis.
            // requestPairingCode doit arriver APRES que WhatsApp a envoyé le
            // challenge et reçu la réponse — pas juste après TCP connect.
            if (connection === "connecting" && !pairingRequested) {
                pairingRequested = true;
                console.log(`⏳ Attente handshake WS pour ${num}...`);

                setTimeout(async () => {
                    if (dead) return;
                    try {
                        const code = await Prince.requestPairingCode(num);
                        if (dead) return;
                        console.log(`✅ Code généré pour ${num}: ${code}`);
                        sendOnce(200, { code });
                    } catch (err) {
                        if (dead) return;
                        console.error("requestPairingCode error:", err?.message || err);
                        dead = true;
                        clearTimeout(globalTimeout);
                        try { Prince.ws?.close(); } catch (_) {}
                        await cleanUp();
                        sendOnce(500, { code: "Impossible de générer le code — réessayez" });
                    }
                }, 8000);

                return;
            }

            // ── QR reçu malgré tout ──────────────────────────────────────────
            // Si on arrive ici c'est que requestPairingCode est arrivé trop tard
            // OU que le numéro n'est pas éligible au pairing code WhatsApp.
            if (qr && !responseSent) {
                console.error("QR reçu — pairing code non supporté pour ce numéro");
                dead = true;
                clearTimeout(globalTimeout);
                try { Prince.ws?.close(); } catch (_) {}
                await cleanUp();
                sendOnce(503, { code: "Ce numéro ne supporte pas le pairing code — vérifiez que WhatsApp est actif sur ce numéro" });
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
