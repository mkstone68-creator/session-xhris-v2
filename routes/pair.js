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

// Code de pairing personnalisé. DOIT être 8 chars de l'alphabet Crockford Base32
// (pas de I, O, U, L ni 0) sinon WhatsApp le rejette en silence.
// Pour écarter la piste "custom code", remplacer par null (Baileys génère le code).
const PAIRING_CODE = "XHR1SMD2";

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

    const log = (...a) => console.log('[PAIR]', ...a);

    if (!num) {
        return res.status(400).json({ code: "Numéro manquant" });
    }

    let responseSent   = false;
    let sessionCleaned = false;
    let dead = false;
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

    // Termine proprement (ferme la socket, annule le timeout). N'envoie une réponse
    // HTTP que si on n'a pas déjà renvoyé le code.
    function finish(statusCode, body, sock) {
        dead = true;
        clearTimeout(globalTimeout);
        try { sock?.ws?.close(); } catch (_) {}
        if (statusCode) sendOnce(statusCode, body);
    }

    // Timeout uniquement sur la livraison du CODE : une fois le code renvoyé, on
    // l'annule pour laisser l'utilisateur saisir le code et le pairing aboutir.
    const globalTimeout = setTimeout(() => {
        if (!dead && !responseSent) {
            dead = true;
            log(`Timeout — aucun code livré en 55s pour ${num}`);
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

        // ── Demande du pairing code juste après la création du socket ────────
        // Pattern éprouvé (type Levanter) : on attend ~3s que la socket s'initialise,
        // puis on demande le code UNE fois, hors event. Pas de connecting/qr.
        if (!Prince.authState.creds.registered && !responseSent) {
            try {
                log(`Demande du code pour ${num}...`);
                await delay(3000);
                if (dead) return;
                const code = PAIRING_CODE
                    ? await Prince.requestPairingCode(num, PAIRING_CODE)
                    : await Prince.requestPairingCode(num);
                if (dead) return;
                log(`Code généré pour ${num}: ${code}`);
                sendOnce(200, { code });
                clearTimeout(globalTimeout);
            } catch (err) {
                log(`requestPairingCode ERROR pour ${num}: ${err?.message || err}`);
                console.error('[PAIR] Full error:', err);
                // On ferme pour laisser le handler 'close' retenter une reconnexion,
                // sinon le timeout global renverra une erreur propre.
                try { Prince.ws?.close(); } catch (_) {}
                return;
            }
        }

        // ── Listeners attachés APRÈS la demande de code ──────────────────────
        Prince.ev.on("connection.update", async (s) => {
            if (dead) return;
            const { connection, lastDisconnect } = s;
            if (connection) log(`connection.update -> ${connection}`);

            // ── Connexion établie : lire les creds et envoyer la session ─────
            if (connection === "open") {
                log(`Connexion ouverte pour ${num}`);
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
                    } catch (e) { log(`Read creds error: ${e.message}`); }
                    if (!sessionData) await delay(3000);
                }

                if (!sessionData) {
                    log(`Impossible de lire la session pour ${num}`);
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
                            log(`Session envoyée pour ${num}`);
                        } catch (e) {
                            log(`Send error (essai ${i + 1}): ${e.message}`);
                            if (i < 4) await delay(3000);
                        }
                    }
                } catch (e) {
                    log(`Session build error: ${e.message}`);
                } finally {
                    await cleanUp();
                    finish(null, null, Prince);
                }
                return;
            }

            // ── Connexion fermée ─────────────────────────────────────────────
            if (connection === "close") {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                log(`Connexion fermée pour ${num}, code: ${statusCode}`);
                if (dead) return;

                // 515 = "restart required" après un pairing réussi → reconnexion normale
                if (statusCode === 515) {
                    log(`Restart requis (515) — reconnexion pour finaliser...`);
                    connectToWA();
                    return;
                }

                // numéro invalide / déconnecté / interdit
                if (statusCode === 401 || statusCode === 403 || statusCode === 405) {
                    log(`Numéro invalide ou déjà connecté (code ${statusCode})`);
                    await cleanUp();
                    finish(401, { code: "Numéro invalide ou déjà connecté — vérifiez le numéro" }, Prince);
                    return;
                }

                // autres fermetures : reconnexion avec retry limité
                if (retries++ < MAX_RETRIES) {
                    log(`Reconnexion ${retries}/${MAX_RETRIES}...`);
                    await delay(3000);
                    connectToWA();
                } else {
                    log(`Trop d'échecs de connexion pour ${num}`);
                    await cleanUp();
                    finish(503, { code: "Connexion instable — réessayez dans un instant" }, Prince);
                }
            }
        });
    }

    try {
        await connectToWA();
    } catch (err) {
        log(`Fatal error: ${err?.message || err}`);
        console.error('[PAIR] Full fatal error:', err);
        await cleanUp();
        finish(500, { code: "Service is Currently Unavailable" }, null);
    }
});

module.exports = router;
