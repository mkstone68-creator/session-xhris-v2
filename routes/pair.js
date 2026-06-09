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
    fetchLatestWaWebVersion,
    fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");

// Récupère la version WhatsApp Web ACTUELLE (en direct depuis web.whatsapp.com).
// CRUCIAL : une version périmée fait rejeter le pairing par WhatsApp (failure 405).
async function getWAVersion() {
    try {
        const { version, isLatest } = await fetchLatestWaWebVersion();
        console.log(`[PAIR] Version WA Web (live): ${version} (latest: ${isLatest})`);
        return version;
    } catch (e) {
        console.log(`[PAIR] fetchLatestWaWebVersion échec (${e.message}), fallback baileys...`);
        try {
            const { version } = await fetchLatestBaileysVersion();
            console.log(`[PAIR] Version baileys: ${version}`);
            return version;
        } catch (e2) {
            console.log(`[PAIR] fallback version figée`);
            return undefined; // baileys utilisera sa version par défaut
        }
    }
}

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
    let restartCount   = 0;
    const MAX_RESTARTS = 2;

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
    }, 120000);

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
            // Code custom configurable via variable d'env PAIR_CUSTOM_CODE.
            // Si vide ou absent → Baileys génère un code valide lui-même.
            // (alphabet Crockford : pas de 0/I/O/U si tu mets un code custom)
            const customCode = process.env.PAIR_CUSTOM_CODE || "";
            let code = customCode
                ? await Prince.requestPairingCode(num, customCode)
                : await Prince.requestPairingCode(num);
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
        const waVersion = await getWAVersion();

        Prince = princeConnect({
            version: waVersion,
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

        let lastCredsUpdate = Date.now();
        let credsUpdateCount = 0;
        Prince.ev.on('creds.update', async (...args) => {
            lastCredsUpdate = Date.now();
            credsUpdateCount++;
            await saveCreds(...args);
        });

        // DEBUG : capturer le nœud de failure COMPLET pour voir la vraie raison du rejet
        try {
            Prince.ws.on('CB:failure', (node) => {
                console.log('[PAIR][RAW] CB:failure node:', JSON.stringify(node?.attrs || node));
            });
            Prince.ws.on('CB:stream:error', (node) => {
                console.log('[PAIR][RAW] stream:error node:', JSON.stringify(node?.attrs || node));
            });
            Prince.ws.on('CB:xmlstreamend', () => {
                console.log('[PAIR][RAW] xmlstreamend (WhatsApp a coupé le flux)');
            });
        } catch (e) { console.log('[PAIR][RAW] listener setup error:', e.message); }

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
                console.log(`[PAIR] Connexion ouverte pour ${num} — attente stabilisation session...`);

                // Attente minimale après l'open (handshake initial)
                await delay(8000);
                if (dead) return;

                // Attendre la "quiétude" des creds.update : une session fraîche émet
                // encore des creds.update ~15-30s après l'open ; capturer trop tôt
                // produit une session incomplète rejetée en 401.
                const QUIET_MS = 5000;     // 5s sans nouvelle update = session stable
                const MAX_WAIT_MS = 35000; // plafond de sécurité
                const startWait = Date.now();
                while (!dead && (Date.now() - lastCredsUpdate) < QUIET_MS) {
                    if (Date.now() - startWait > MAX_WAIT_MS) {
                        console.log(`[PAIR] Plafond d'attente atteint pour ${num}, capture quand même.`);
                        break;
                    }
                    await delay(1000);
                }
                if (dead) return;
                console.log(`[PAIR] Session stabilisée pour ${num} (${credsUpdateCount} updates).`);

                let sessionData = null;
                for (let i = 0; i < 12 && !sessionData; i++) {
                    try {
                        const credsPath = path.join(sessionDir, id, "creds.json");
                        if (fs.existsSync(credsPath)) {
                            const data = fs.readFileSync(credsPath);
                            if (data && data.length > 100) sessionData = data;
                        }
                    } catch (e) { console.error("[PAIR] Read creds error:", e.message); }
                    if (!sessionData) await delay(2000);
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
                    // Laisser WA finaliser l'enregistrement de l'appareil avant de couper
                    await delay(3000);
                    dead = true; clearTimeout(globalTimeout);
                    try { Prince.ws?.close(); } catch (_) {}
                    await cleanUp();
                }
                return;
            }

            if (connection === "close") {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                console.log(`[PAIR] Connexion fermée, code: ${statusCode}`);

                // 515 = restart required APRÈS pairing réussi → reconnexion pour finaliser
                if (statusCode === 515) {
                    console.log("[PAIR] 515 restart required — reconnexion...");
                    if (!dead) setTimeout(() => { reconnectAfterPair(); }, 2000);
                    return;
                }

                // 401 = compte déconnecté/suspendu → NE PAS réessayer (boucle infinie sinon)
                if (statusCode === 401) {
                    console.log("[PAIR] 401 loggedOut — ce numéro est déconnecté ou suspendu. Arrêt.");
                    if (!dead) {
                        dead = true;
                        clearTimeout(globalTimeout);
                        await cleanUp();
                        sendOnce(401, { code: "Ce numéro est déconnecté ou suspendu sur WhatsApp. Utilisez un numéro actif." });
                    }
                    return;
                }

                // 405 = pairing refusé → NE PAS boucler à l'infini
                if (statusCode === 405) {
                    console.log("[PAIR] 405 — pairing refusé par WhatsApp.");
                    if (!dead) {
                        dead = true;
                        clearTimeout(globalTimeout);
                        await cleanUp();
                        sendOnce(405, { code: "Pairing refusé par WhatsApp. Réessayez ou utilisez le QR." });
                    }
                    return;
                }

                // Fermeture avant le code : relance LIMITÉE (pas de boucle infinie)
                if (!codeRequested && !responseSent && !dead) {
                    if (restartCount < MAX_RESTARTS) {
                        restartCount++;
                        console.log(`[PAIR] Fermeture avant code — relance ${restartCount}/${MAX_RESTARTS}...`);
                        setTimeout(() => { startPairing().catch(e => console.error(e.message)); }, 3000);
                    } else {
                        console.log("[PAIR] Trop de tentatives — abandon.");
                        dead = true;
                        clearTimeout(globalTimeout);
                        await cleanUp();
                        sendOnce(503, { code: "Connexion instable — réessayez dans un instant." });
                    }
                }
            }
        });
    }

    async function reconnectAfterPair() {
        if (dead) return;
        try {
            const { state: st2, saveCreds: sc2 } = await useMultiFileAuthState(path.join(sessionDir, id));
            const waVer2 = await getWAVersion();
            const P2 = princeConnect({
                version: waVer2,
                auth: {
                    creds: st2.creds,
                    keys: makeCacheableSignalKeyStore(st2.keys, pino({ level: "silent" })),
                },
                printQRInTerminal: false,
                logger: pino({ level: "silent" }).child({ level: "silent" }),
                browser: Browsers.ubuntu("Chrome"),
                markOnlineOnConnect: false,
            });
            let lastCredsUpdate2 = Date.now();
            let credsUpdateCount2 = 0;
            P2.ev.on('creds.update', async (...args) => {
                lastCredsUpdate2 = Date.now();
                credsUpdateCount2++;
                await sc2(...args);
            });
            P2.ev.on("connection.update", async (u) => {
                if (dead) return;
                if (u.connection === "open") {
                    console.log(`[PAIR] Reconnexion ouverte pour ${num} — attente stabilisation session...`);

                    // Attente minimale après l'open (handshake initial)
                    await delay(8000);
                    if (dead) return;

                    // Quiétude des creds.update : ne capturer qu'une session stabilisée
                    // (sinon session incomplète → 401 à la prochaine utilisation).
                    const QUIET_MS = 5000;
                    const MAX_WAIT_MS = 35000;
                    const startWait = Date.now();
                    while (!dead && (Date.now() - lastCredsUpdate2) < QUIET_MS) {
                        if (Date.now() - startWait > MAX_WAIT_MS) {
                            console.log(`[PAIR] Plafond d'attente atteint pour ${num}, capture quand même.`);
                            break;
                        }
                        await delay(1000);
                    }
                    if (dead) return;
                    console.log(`[PAIR] Session stabilisée pour ${num} (${credsUpdateCount2} updates).`);

                    let sd = null;
                    for (let i = 0; i < 12 && !sd; i++) {
                        try {
                            const cp = path.join(sessionDir, id, "creds.json");
                            if (fs.existsSync(cp)) {
                                const d = fs.readFileSync(cp);
                                if (d && d.length > 100) sd = d;
                            }
                        } catch (_) {}
                        if (!sd) await delay(2000);
                    }
                    if (sd) {
                        try {
                            const b64 = zlib.gzipSync(sd).toString('base64');
                            await sendSessionMessage(P2, P2.user.id, 'XHRIS-MD!' + b64);
                            console.log(`[PAIR] Session envoyée pour ${num}`);
                        } catch (e) { console.error("[PAIR] Send error (reconnect):", e.message); }
                    }
                    // Laisser WA finaliser l'enregistrement de l'appareil avant de couper
                    await delay(3000);
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
