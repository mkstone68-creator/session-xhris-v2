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


// XHRIS channel — used ONLY for the clickable button URL, NEVER for auto-follow
const XHRIS_CHANNEL_URL = 'https://whatsapp.com/channel/0029Vark1I1AYlUR1G8YMX31';
const XHRIS_REPO_URL = 'https://github.com/Eric-Xhris/XHRIS-MD-V2';

const sessionDir = path.join(__dirname, "session");

/**
 * Send the session string to the user.
 * Uses ONLY native Baileys sendMessage — no third-party package.
 */
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
    const id = princeId();
    const num = (req.query.number || "").replace(/[^0-9]/g, '');
    let responseSent = false;
    let sessionCleanedUp = false;
    let codeRequested = false;

    async function cleanUpSession() {
        if (!sessionCleanedUp) {
            await removeFile(path.join(sessionDir, id));
            sessionCleanedUp = true;
        }
    }

    async function PRINCE_PAIR_CODE() {
        const { state, saveCreds } = await useMultiFileAuthState(path.join(sessionDir, id));
        try {
            let Prince = princeConnect({
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
                connectTimeoutMs: 60000,
                keepAliveIntervalMs: 30000
            });

            /**
             * POURQUOI on demande le code dans "connecting" et PAS dans "qr" :
             *
             * Baileys choisit le flow (QR vs pairing-code) au moment du handshake.
             * Si on attend l'event `qr`, Baileys est déjà en QR-flow → requestPairingCode()
             * reçoit "Connection Closed" à 100% (c'est exactement ce que les logs montrent).
             * Il faut appeler requestPairingCode() pendant `connecting`, AVANT que le QR
             * soit généré, pour forcer le pairing-code-flow côté serveur WhatsApp.
             *
             * Le retry loop gère les 428 (serveur pas encore prêt) avec backoff.
             */
            async function requestCode() {
                if (codeRequested || Prince.authState.creds.registered) return;
                codeRequested = true;
                
                const maxAttempts = 8;
                for (let attempt = 0; attempt < maxAttempts; attempt++) {
                    try {
                        // pause croissante : 3s, 4s, 5s… pour laisser TCP/TLS s'établir
                        await delay(3000 + attempt * 1000);
                        const code = await Prince.requestPairingCode(num, "XHRISBOT");
                        if (!responseSent && !res.headersSent) {
                            res.json({ code });
                            responseSent = true;
                        }
                        return; // succès
                    } catch (err) {
                        const msg = err?.message || String(err);
                        console.error(`requestPairingCode error (attempt ${attempt + 1}/${maxAttempts}):`, msg);
                        // Si c'est le dernier essai, on laisse le timeout global répondre
                    }
                }
                // Tous les essais épuisés — autoriser un retry si la connexion rebascule
                codeRequested = false;
            }

            Prince.ev.on('creds.update', saveCreds);
            Prince.ev.on("connection.update", async (s) => {
                const { connection, lastDisconnect } = s;

                // Déclencher dès "connecting" — avant que Baileys ne génère un QR
                if (connection === "connecting" && !codeRequested && !Prince.authState.creds.registered) {
                    requestCode(); // non-awaité intentionnellement
                }

                if (connection === "open") {
                    // Laisser saveCreds écrire le fichier
                    await delay(8000);
                    
                    let sessionData = null;
                    for (let i = 0; i < 10; i++) {
                        try {
                            const credsPath = path.join(sessionDir, id, "creds.json");
                            if (fs.existsSync(credsPath)) {
                                const data = fs.readFileSync(credsPath);
                                if (data && data.length > 100) {
                                    sessionData = data;
                                    break;
                                }
                            }
                        } catch (e) {
                            console.error("Read error:", e);
                        }
                        await delay(3000);
                    }

                    if (!sessionData) {
                        await cleanUpSession();
                        return;
                    }
                    
                    try {
                        const compressedData = zlib.gzipSync(sessionData);
                        const b64data = compressedData.toString('base64');
                        const sessionString = 'XHRIS-MD!' + b64data;
                        
                        await delay(3000);

                        let sessionSent = false;
                        for (let i = 0; i < 5 && !sessionSent; i++) {
                            try {
                                await sendSessionMessage(Prince, Prince.user.id, sessionString);
                                sessionSent = true;
                                console.log(`✅ Session envoyée pour ${num}`);
                            } catch (sendError) {
                                console.error("Send error:", sendError.message);
                                if (i < 4) await delay(3000);
                            }
                        }

                        await delay(2000);
                        await Prince.ws.close();
                    } catch (err) {
                        console.error("Error sending session:", err);
                    } finally {
                        await cleanUpSession();
                    }
                    
                } else if (connection === "close") {
                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    if (statusCode !== 401) {
                        codeRequested = false;
                        await delay(5000);
                        PRINCE_PAIR_CODE();
                    }
                }
            });
        } catch (err) {
            console.error("Main error:", err);
            await cleanUpSession();
            if (!responseSent && !res.headersSent) {
                res.status(500).json({ code: "Service is Currently Unavailable" });
                responseSent = true;
            }
        }
    }

    // Timeout global 55s (< Railway timeout de 60s → évite le 502/504 Railway)
    setTimeout(() => {
        if (!responseSent && !res.headersSent) {
            res.status(504).json({ code: "Timeout — réessayez dans un instant" });
            responseSent = true;
        }
    }, 55000);

    try {
        await PRINCE_PAIR_CODE();
    } catch (finalError) {
        console.error("Final error:", finalError);
        await cleanUpSession();
        if (!responseSent && !res.headersSent) {
            res.status(500).json({ code: "Service Error" });
        }
    }
});

module.exports = router;
