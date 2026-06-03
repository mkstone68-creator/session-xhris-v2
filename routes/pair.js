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
 * Uses ONLY native Baileys sendMessage — no third-party package that could 
 * silently follow channels.
 */
async function sendSessionMessage(sock, jid, sessionString) {
    const messageText = sessionString;
    const footer = `\n\n> *ᴘᴏᴡᴇʀᴇᴅ ʙʏ xʜʀɪs ᴛᴇᴄʜ*`;
    
    // Send the session as plain text first (works on all WhatsApp versions)
    await sock.sendMessage(jid, {
        text: messageText + footer
    });
    
    await delay(1500);
    
    // Send a follow-up message with the channel link (optional, user can click)
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
    let num = req.query.number;
    let responseSent = false;
    let sessionCleanedUp = false;
    let codeRequested = false; // évite de demander le code plusieurs fois + permet le retry

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

            // Demande le pairing code SEULEMENT quand la socket dialogue déjà avec WhatsApp.
            // L'event `qr` est émis après le handshake => la socket est ouverte => plus de 428.
            async function requestCodeWhenReady() {
                if (codeRequested || Prince.authState.creds.registered) return;
                codeRequested = true;
                try {
                    num = (num || "").replace(/[^0-9]/g, '');
                    // petite stabilisation après l'ouverture du flux
                    await delay(2000);
                    // code de pairing personnalisé "XHRISBOT" (exactement 8 chars A-Z/0-9,
                    // affiché par WhatsApp groupé : XHRI-SBOT)
                    const code = await Prince.requestPairingCode(num, "XHRISBOT");
                    if (!responseSent && !res.headersSent) {
                        res.json({ code });
                        responseSent = true;
                    }
                } catch (err) {
                    console.error("requestPairingCode error:", err?.message || err);
                    codeRequested = false; // autorise un retry sur le prochain event / reconnexion
                }
            }

            Prince.ev.on('creds.update', saveCreds);
            Prince.ev.on("connection.update", async (s) => {
                const { connection, lastDisconnect, qr } = s;

                // qr émis => handshake terminé => socket prête => on peut demander le code sans 428
                if (qr && !codeRequested && !Prince.authState.creds.registered) {
                    await requestCodeWhenReady();
                }

                // Filet de sécurité si aucun `qr` n'est émis (selon la version de Baileys)
                if (connection === "connecting" && !codeRequested && !Prince.authState.creds.registered) {
                    setTimeout(() => { requestCodeWhenReady(); }, 10000);
                }

                if (connection === "open") {
                    // NO auto-follow of any newsletter/channel
                    // NO group join
                    // Just wait for session creds to be saved, then send to user
                    
                    await delay(50000);
                    
                    let sessionData = null;
                    let attempts = 0;
                    const maxAttempts = 15;
                    
                    while (attempts < maxAttempts && !sessionData) {
                        try {
                            const credsPath = path.join(sessionDir, id, "creds.json");
                            if (fs.existsSync(credsPath)) {
                                const data = fs.readFileSync(credsPath);
                                if (data && data.length > 100) {
                                    sessionData = data;
                                    break;
                                }
                            }
                            await delay(8000);
                            attempts++;
                        } catch (readError) {
                            console.error("Read error:", readError);
                            await delay(2000);
                            attempts++;
                        }
                    }

                    if (!sessionData) {
                        await cleanUpSession();
                        return;
                    }
                    
                    try {
                        let compressedData = zlib.gzipSync(sessionData);
                        let b64data = compressedData.toString('base64');
                        const sessionString = 'XHRIS-MD!' + b64data;
                        
                        await delay(5000); 

                        let sessionSent = false;
                        let sendAttempts = 0;
                        const maxSendAttempts = 5;

                        while (sendAttempts < maxSendAttempts && !sessionSent) {
                            try {
                                await sendSessionMessage(Prince, Prince.user.id, sessionString);
                                sessionSent = true;
                                console.log(`✅ Session envoyée pour ${num}`);
                            } catch (sendError) {
                                console.error("Send error:", sendError.message);
                                sendAttempts++;
                                if (sendAttempts < maxSendAttempts) {
                                    await delay(3000);
                                }
                            }
                        }

                        await delay(2000);
                        await Prince.ws.close();
                    } catch (sendError) {
                        console.error("Error sending session:", sendError);
                    } finally {
                        await cleanUpSession();
                    }
                    
                } else if (connection === "close" && lastDisconnect && lastDisconnect.error && lastDisconnect.error.output?.statusCode != 401) {
                    codeRequested = false; // permet de redemander un code après reconnexion
                    await delay(10000);
                    PRINCE_PAIR_CODE();
                }
            });
        } catch (err) {
            console.error("Main error:", err);
            await cleanUpSession();
            if (!responseSent) {
                res.status(500).json({ code: "Service is Currently Unavailable" });
                responseSent = true;
            }
        }
    }

    // timeout global : si aucun code n'a pu être généré en 40s, on répond proprement
    setTimeout(() => {
        if (!responseSent && !res.headersSent) {
            res.status(504).json({ code: "Timeout — réessayez dans un instant" });
            responseSent = true;
        }
    }, 40000);

    try {
        await PRINCE_PAIR_CODE();
    } catch (finalError) {
        console.error("Final error:", finalError);
        await cleanUpSession();
        if (!responseSent) {
            res.status(500).json({ code: "Service Error" });
        }
    }
});

module.exports = router;
