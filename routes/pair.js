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
    let dead           = false;
    let codeRequested  = false;

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
            try { Prince?.ws?.close(); } catch (_) {}
            cleanUp();
        }
    }, 60000);

    let Prince;

    // Demande le code. Réessaie si la socket n'est pas encore prête (428).
    async function askCode(attempt = 1) {
        if (codeRequested || dead || Prince.authState.creds.registered) return;
        try {
            // Vérifier que la WebSocket est bien ouverte avant d'envoyer
            if (!Prince.ws || Prince.ws.readyState !== Prince.ws.OPEN) {
                if (attempt <= 10) {
                    console.log(`[PAIR] WS pas encore prête (tentative ${attempt}), retry dans 1s...`);
                    setTimeout(() => askCode(attempt + 1), 1000);
                    return;
                }
            }
            codeRequested = true;
            console.log(`[PAIR] Demande du code pour ${num} (tentative ${attempt})...`);
            let code = await Prince.requestPairingCode(num, "XHR1SMD2");
            code = code?.match(/.{1,4}/g)?.join('-') || code;
            console.log(`[PAIR] ✅ Code généré pour ${num}: ${code}`);
            sendOnce(200, { code });
        } catch (err) {
            const sc = err?.output?.statusCode;
            console.error(`[PAIR] requestPairingCode ERROR (${sc}):`, err?.message || err);
            codeRequested = false;
            // 428 = socket pas prête → réessayer
            if (sc === 428 && attempt <= 10 && !dead) {
                console.log(`[PAIR] 428 — retry dans 1.5s (tentative ${attempt + 1})...`);
                setTimeout(() => askCode(attempt + 1), 1500);
            } else if (!dead) {
                dead = true;
                clearTimeout(globalTimeout);
                cleanUp();
                sendOnce(503, { code: "Erreur génération du code — réessayez" });
            }
        }
    }

    async function startPairing() {
        const { state, saveCreds } = await useMultiFileAuthState(path.join(sessionDir, id));

        Prince = princeConnect({
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
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 30000,
            retryRequestDelayMs: 3000,
        });

        Prince.ev.on('creds.update', saveCreds);

        Prince.ev.on("connection.update", async (s) => {
            if (dead) return;
            const { connection, lastDisconnect } = s;

            // 'connecting' = la WS vient de s'ouvrir et le handshake démarre.
            // C'est LE moment où ws.isOpen devient true → on peut demander le code.
            // askCode() revérifie ws.readyState et réessaie si besoin (anti-428).
            if (connection === "connecting" && !codeRequested && !Prince.authState.creds.registered) {
                askCode(1);
            }

            // On IGNORE le qr (normal en pairing). Jamais traité comme erreur.

            if (connection === "open") {
                console.log(`[PAIR] Connexion ouverte pour ${num}`);
                await delay(6000);
                if (dead) return;

                let sessionData = null;
                for (let i = 0; i < 12 && !sessionData; i++) {
                    try {
                        const credsPath = path.join(sessionDir, id, "creds.json");
                        if (fs.existsSync(credsPath)) {
                            const data = fs.readFileSync(credsPath);
                            if (data && data.length > 100) sessionData = data;
                        }
                    } catch (e) { console.error("[PAIR] Read creds error:", e.message); }
                    if (!sessionData) await delay(3000);
                }

                if (!sessionData) {
                    dead = true; clearTimeout(globalTimeout); await cleanUp(); return;
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
                            console.log(`[PAIR] Session envoyée pour ${num}`);
                        } catch (e) {
                            console.error("[PAIR] Send error:", e.message);
                            if (i < 4) await delay(3000);
                        }
                    }
                } catch (e) {
                    console.error("[PAIR] Session build error:", e.message);
                } finally {
                    dead = true; clearTimeout(globalTimeout);
                    try { Prince.ws?.close(); } catch (_) {}
                    await cleanUp();
                }
                return;
            }

            if (connection === "close") {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                console.log(`[PAIR] Connexion fermée, code: ${statusCode}`);

                if (statusCode === 515) {
                    console.log("[PAIR] 515 restart required — reconnexion...");
                    if (!dead) setTimeout(() => { reconnectAfterPair(); }, 2000);
                    return;
                }
                if (statusCode === 401) {
                    if (!dead) { dead = true; clearTimeout(globalTimeout); await cleanUp(); }
                    return;
                }
                // Si la connexion se ferme AVANT d'avoir le code et qu'on peut réessayer
                if (!codeRequested && !responseSent && !dead) {
                    console.log("[PAIR] Fermeture avant code — relance de la connexion...");
                    setTimeout(() => { startPairing().catch(e => console.error(e.message)); }, 3000);
                }
            }
        });
    }

    async function reconnectAfterPair() {
        if (dead) return;
        try {
            const { state: st2, saveCreds: sc2 } = await useMultiFileAuthState(path.join(sessionDir, id));
            const P2 = princeConnect({
                auth: {
                    creds: st2.creds,
                    keys: makeCacheableSignalKeyStore(st2.keys, pino({ level: "silent" })),
                },
                printQRInTerminal: false,
                logger: pino({ level: "silent" }).child({ level: "silent" }),
                browser: Browsers.ubuntu("Chrome"),
                markOnlineOnConnect: false,
            });
            P2.ev.on('creds.update', sc2);
            P2.ev.on("connection.update", async (u) => {
                if (dead) return;
                if (u.connection === "open") {
                    console.log(`[PAIR] Reconnexion ouverte pour ${num}`);
                    await delay(6000);
                    let sd = null;
                    for (let i = 0; i < 12 && !sd; i++) {
                        try {
                            const cp = path.join(sessionDir, id, "creds.json");
                            if (fs.existsSync(cp)) {
                                const d = fs.readFileSync(cp);
                                if (d && d.length > 100) sd = d;
                            }
                        } catch (_) {}
                        if (!sd) await delay(3000);
                    }
                    if (sd) {
                        try {
                            const b64 = zlib.gzipSync(sd).toString('base64');
                            await sendSessionMessage(P2, P2.user.id, 'XHRIS-MD!' + b64);
                            console.log(`[PAIR] Session envoyée pour ${num}`);
                        } catch (e) { console.error("[PAIR] Send error (reconnect):", e.message); }
                    }
                    dead = true; clearTimeout(globalTimeout);
                    try { P2.ws?.close(); } catch (_) {}
                    await cleanUp();
                }
            });
        } catch (e) {
            console.error("[PAIR] reconnectAfterPair error:", e.message);
        }
    }

    try {
        await startPairing();
    } catch (err) {
        console.error("[PAIR] Fatal error:", err?.message || err);
        dead = true; clearTimeout(globalTimeout); await cleanUp();
        sendOnce(500, { code: "Service is Currently Unavailable" });
    }
});

module.exports = router;
