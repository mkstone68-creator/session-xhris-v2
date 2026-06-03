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
    DisconnectReason
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

    let responseSent   = false;
    let sessionCleaned = false;
    // ── clé de contrôle GLOBALE à toute la requête ──────────────────────────
    let dead = false;  // mis à true dès qu'on ne veut plus rien faire

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

    // Timeout global 55s
    const globalTimeout = setTimeout(() => {
        if (!dead) {
            dead = true;
            sendOnce(504, { code: "Timeout — réessayez dans un instant" });
        }
    }, 55000);

    // ─────────────────────────────────────────────────────────────────────────
    // Une seule instance Baileys par requête HTTP — pas de récursion
    // ─────────────────────────────────────────────────────────────────────────
    let Prince = null;

    try {
        const { state, saveCreds } = await useMultiFileAuthState(path.join(sessionDir, id));

        Prince = princeConnect({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
            },
            printQRInTerminal: false,
            logger: pino({ level: "silent" }).child({ level: "silent" }),
            browser: Browsers.macOS("Safari"),
            shouldIgnoreJid: jid => !!jid?.endsWith('@g.us'),
            getMessage: async () => undefined,
            markOnlineOnConnect: true,
            connectTimeoutMs: 60_000,
            keepAliveIntervalMs: 30_000,
            retryRequestDelayMs: 2_000,
        });

        Prince.ev.on('creds.update', saveCreds);

        // ── état interne du pairing ──────────────────────────────────────────
        let pairingDone = false;

        Prince.ev.on("connection.update", async (s) => {
            if (dead) return;

            const { connection, lastDisconnect, qr } = s;

            // ── CONNECTING : demander le pairing code ────────────────────────
            // On le fait ici, avant que Baileys ne bascule vers le QR-flow.
            // Pas de retry loop infini — on laisse Baileys se reconnecter 
            // naturellement si ça échoue ; le guard `pairingDone` évite
            // les demandes multiples.
            if (connection === "connecting" && !pairingDone) {
                // attendre que le TLS/TCP soit établi (~3s)
                await delay(3000);
                if (dead || pairingDone) return;

                try {
                    const code = await Prince.requestPairingCode(num, "XHRISBOT");
                    pairingDone = true;
                    sendOnce(200, { code });
                    console.log(`✅ Code généré pour ${num}: ${code}`);
                } catch (err) {
                    // Pas grave : Baileys va se reconnecter et réémettre "connecting"
                    console.error("requestPairingCode error:", err?.message || err);
                    // On NE remet PAS pairingDone à false ici —
                    // ça sera fait dans "close" si besoin
                }
                return;
            }

            // ── QR : on ne veut pas du QR-flow, ignorer ─────────────────────
            if (qr && !pairingDone) {
                // Baileys a généré un QR, ça signifie que requestPairingCode
                // n'a pas été appelé à temps. Fermer et laisser le timeout répondre.
                console.error("QR généré au lieu du pairing code — fermeture");
                dead = true;
                try { Prince.ws.close(); } catch (_) {}
                sendOnce(503, { code: "Erreur pairing — réessayez" });
                return;
            }

            // ── OPEN : connexion établie → envoyer la session ────────────────
            if (connection === "open") {
                console.log(`🔗 Connexion ouverte pour ${num}`);
                // Laisser saveCreds écrire le fichier
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

            // ── CLOSE ────────────────────────────────────────────────────────
            if (connection === "close") {
                const code = lastDisconnect?.error?.output?.statusCode;
                console.log(`🔌 Connexion fermée, code: ${code}`);

                if (code === 401) {
                    // Session invalide — arrêt définitif
                    dead = true;
                    clearTimeout(globalTimeout);
                    await cleanUp();
                    sendOnce(401, { code: "Session invalide" });
                    return;
                }

                if (dead || pairingDone) return;

                // Reconnexion automatique gérée par Baileys (retryRequestDelayMs)
                // On reset pairingDone pour pouvoir redemander le code
                pairingDone = false;
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
