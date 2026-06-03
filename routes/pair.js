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

    let responseSent  = false;
    let sessionCleaned = false;
    let dead = false;
    let codeRequested = false; // garde-fou : un seul code demandé, mais retry possible
    let retries = 0;
    const MAX_RETRIES = 5;

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

    // Termine proprement le flux (ferme la socket, nettoie le timeout).
    // N'envoie une réponse HTTP que si on n'a pas déjà renvoyé le code.
    function finish(statusCode, body, sock) {
        dead = true;
        clearTimeout(globalTimeout);
        try { sock?.ws?.close(); } catch (_) {}
        if (statusCode) sendOnce(statusCode, body);
    }

    // Timeout uniquement sur la livraison du CODE. Une fois le code envoyé,
    // on l'annule pour laisser le pairing + la récupération de session aboutir
    // (l'utilisateur peut mettre du temps à saisir le code sur son téléphone).
    const globalTimeout = setTimeout(() => {
        if (!dead && !responseSent) {
            dead = true;
            sendOnce(504, { code: "Timeout — réessayez dans un instant" });
        }
    }, 55000);

    async function connectToWA() {
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

        // Demande le pairing code quand la socket dialogue déjà avec WhatsApp.
        // On NE traite PAS le QR comme une erreur : en mode pairing code un QR
        // peut être émis en parallèle, c'est normal. On l'utilise juste comme
        // signal "socket prête" si le code n'a pas encore été demandé.
        async function requestCode() {
            if (codeRequested || dead || Prince.authState.creds.registered) return;
            codeRequested = true;
            try {
                console.log(`📲 Demande du pairing code pour ${num}...`);
                // code de pairing personnalisé "XHRISBOT" (8 chars A-Z/0-9 → affiché XHRI-SBOT)
                const code = await Prince.requestPairingCode(num, "XHRISBOT");
                if (dead) return;
                console.log(`✅ Code généré pour ${num}: ${code}`);
                sendOnce(200, { code });
                clearTimeout(globalTimeout); // code livré : on laisse le pairing aboutir
            } catch (err) {
                console.error("requestPairingCode error:", err?.message || err);
                codeRequested = false; // socket pas encore prête → retry sur le prochain event
            }
        }

        Prince.ev.on("connection.update", async (s) => {
            if (dead) return;
            const { connection, lastDisconnect, qr } = s;

            // 'connecting' : la WS vient de s'ouvrir → fenêtre fiable pour demander le code
            if (connection === "connecting" && !Prince.authState.creds.registered) {
                setTimeout(() => { requestCode(); }, 800);
            }

            // QR émis = handshake terminé → on demande le code (et SURTOUT on n'échoue pas)
            if (qr && !Prince.authState.creds.registered) {
                requestCode();
            }

            // ── Connexion établie : lire les creds et envoyer la session ─────────
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
                    await cleanUp();
                    finish(500, { code: "Impossible de lire la session" }, Prince);
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
                    await cleanUp();
                    finish(null, null, Prince);
                }
                return;
            }

            // ── Connexion fermée ─────────────────────────────────────────────
            if (connection === "close") {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                console.log(`🔌 Connexion fermée, code: ${statusCode}`);
                if (dead) return;

                // 515 = "restart required" APRÈS un pairing réussi → reconnexion normale
                // pour finaliser et récupérer la session.
                if (statusCode === 515) {
                    console.log("🔄 Restart requis (515) — reconnexion pour finaliser...");
                    connectToWA();
                    return;
                }

                // numéro invalide / déconnecté / interdit
                if (statusCode === 401 || statusCode === 403 || statusCode === 405) {
                    await cleanUp();
                    finish(401, { code: "Numéro invalide ou déjà connecté — vérifiez le numéro" }, Prince);
                    return;
                }

                // autres fermetures : reconnexion avec retry limité
                if (retries++ < MAX_RETRIES) {
                    if (!responseSent) codeRequested = false; // redemander un code si pas encore livré
                    await delay(3000);
                    connectToWA();
                } else {
                    await cleanUp();
                    finish(503, { code: "Connexion instable — réessayez dans un instant" }, Prince);
                }
            }
        });
    }

    try {
        await connectToWA();
    } catch (err) {
        console.error("Fatal error:", err);
        await cleanUp();
        finish(500, { code: "Service is Currently Unavailable" }, null);
    }
});

module.exports = router;
