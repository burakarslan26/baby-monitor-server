/**
 * Bebek Telsizi WebSocket Sinyal Sunucusu
 * 
 * Bu sunucu, bebek ve ebeveyn telefonları arasında ses verisi aktarımını sağlar.
 * Her oda için iki cihaz (bir bebek modu, bir ebeveyn modu) bağlanabilir.
 * 
 * Self-healing özellikleri:
 * - Ping/Pong ile bağlantı canlılık kontrolü
 * - Zombie bağlantıları otomatik temizleme
 * - Detaylı loglama
 */

const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 10000;
const HEARTBEAT_INTERVAL = 30000;  // 30 saniye
const CONNECTION_TIMEOUT = 60000;  // 60 saniye veri gelmezse zombie kabul et

// HTTP sunucusu oluştur
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
        status: 'running',
        message: 'Bebek Telsizi Sunucusu Çalışıyor',
        rooms: rooms.size
    }));
});

// WebSocket sunucusu oluştur
const wss = new WebSocket.Server({ server });

// Oda yönetimi
const rooms = new Map();

// Bağlantı olayı
wss.on('connection', (ws, req) => {
    const clientId = `${req.socket.remoteAddress}:${Date.now()}`;
    console.log(`[${new Date().toISOString()}] Yeni bağlantı: ${clientId}`);
    
    let currentRoom = null;
    let currentMode = null;
    
    // Ping/Pong ile bağlantı kontrolü
    ws.isAlive = true;
    ws.lastActivity = Date.now();
    ws.clientId = clientId;
    
    ws.on('pong', () => {
        ws.isAlive = true;
        ws.lastActivity = Date.now();
    });

    // Mesaj olayı
    ws.on('message', (message) => {
        ws.lastActivity = Date.now();  // Son aktivite zamanını güncelle
        
        try {
            const data = JSON.parse(message);
            
            switch (data.type) {
                case 'join':
                    handleJoin(ws, data, (room, mode) => {
                        currentRoom = room;
                        currentMode = mode;
                    });
                    break;
                    
                case 'audio':
                    handleAudio(ws, data, currentRoom, currentMode);
                    break;
                    
                case 'ping':
                    // İstemciden gelen ping'e pong ile cevap ver
                    sendToClient(ws, { type: 'pong', timestamp: data.timestamp });
                    break;
                    
                case 'leave':
                    handleLeave(ws, currentRoom, currentMode);
                    currentRoom = null;
                    currentMode = null;
                    break;
            }
        } catch (error) {
            console.error(`[${clientId}] Mesaj işleme hatası:`, error.message);
            sendError(ws, 'Geçersiz mesaj formatı');
        }
    });

    // Bağlantı kapanma olayı
    ws.on('close', (code, reason) => {
        const duration = Math.round((Date.now() - ws.lastActivity) / 1000);
        console.log(`[${new Date().toISOString()}] Bağlantı kapandı: ${clientId}, kod: ${code}, süre: ${duration}sn`);
        if (currentRoom) {
            handleLeave(ws, currentRoom, currentMode);
        }
    });

    // Hata olayı
    ws.on('error', (error) => {
        console.error(`[${clientId}] WebSocket hatası:`, error.message);
    });
});

/**
 * Odaya katılma işlemi
 */
function handleJoin(ws, data, callback) {
    const { room, mode } = data;
    
    if (!room || !mode) {
        sendError(ws, 'Oda kodu ve mod gerekli');
        return;
    }

    if (mode !== 'baby' && mode !== 'parent') {
        sendError(ws, 'Geçersiz mod');
        return;
    }

    // Odayı oluştur veya al
    if (!rooms.has(room)) {
        rooms.set(room, { baby: null, parent: null, createdAt: Date.now() });
        console.log(`[${new Date().toISOString()}] Yeni oda oluşturuldu: ${room}`);
    }

    const roomData = rooms.get(room);

    // Aynı modda başka bir cihaz varsa uyar
    if (roomData[mode] && roomData[mode] !== ws) {
        console.log(`[${new Date().toISOString()}] Oda ${room}: ${mode} modu için eski bağlantı kapatılıyor`);
        // Eski bağlantıyı kapat
        try {
            roomData[mode].close(1000, 'Yeni cihaz bağlandı');
        } catch (e) {
            // Hata yoksay
        }
    }

    // Cihazı odaya ekle
    roomData[mode] = ws;
    roomData[`${mode}JoinedAt`] = Date.now();
    callback(room, mode);

    console.log(`[${new Date().toISOString()}] ${mode} modu ${room} odasına katıldı`);

    // Oda bilgisini gönder
    const peerCount = (roomData.baby ? 1 : 0) + (roomData.parent ? 1 : 0);
    sendToClient(ws, {
        type: 'room_info',
        room: room,
        peers: peerCount
    });

    // Karşı tarafa bildir
    const otherMode = mode === 'baby' ? 'parent' : 'baby';
    if (roomData[otherMode]) {
        console.log(`[${new Date().toISOString()}] Oda ${room}: ${mode} ve ${otherMode} eşleşti!`);
        sendToClient(roomData[otherMode], {
            type: 'peer_joined',
            mode: mode
        });
        
        // Yeni katılana da karşı tarafın bağlı olduğunu bildir
        sendToClient(ws, {
            type: 'peer_joined',
            mode: otherMode
        });
    }
}

/**
 * Ses verisi iletimi
 */
function handleAudio(ws, data, room, mode) {
    if (!room || !rooms.has(room)) {
        console.warn(`Ses iletimi: Oda bulunamadı: ${room}`);
        return;
    }

    const roomData = rooms.get(room);
    const targetMode = mode === 'baby' ? 'parent' : 'baby';
    const target = roomData[targetMode];

    if (!target) {
        console.warn(`Ses iletimi: ${targetMode} modu bağlı değil (oda: ${room})`);
        return;
    }

    if (target.readyState !== WebSocket.OPEN) {
        console.warn(`Ses iletimi: ${targetMode} bağlantısı açık değil (durum: ${target.readyState})`);
        return;
    }

    if (!data.data || data.data.length === 0) {
        console.warn(`Ses iletimi: Boş ses verisi (oda: ${room})`);
        return;
    }

    try {
        sendToClient(target, {
            type: 'audio',
            data: data.data
        });
    } catch (e) {
        console.error(`Ses iletimi hatası: ${e.message}`);
    }
}

/**
 * Odadan ayrılma işlemi
 */
function handleLeave(ws, room, mode) {
    if (!room || !rooms.has(room)) {
        return;
    }

    const roomData = rooms.get(room);
    
    if (roomData[mode] === ws) {
        roomData[mode] = null;
        
        // Karşı tarafa bildir
        const otherMode = mode === 'baby' ? 'parent' : 'baby';
        if (roomData[otherMode]) {
            console.log(`[${new Date().toISOString()}] Oda ${room}: ${mode} ayrıldı, ${otherMode}'a bildirildi`);
            sendToClient(roomData[otherMode], {
                type: 'peer_left',
                mode: mode
            });
        }

        // Oda boşsa sil
        if (!roomData.baby && !roomData.parent) {
            const roomAge = Math.round((Date.now() - (roomData.createdAt || Date.now())) / 1000);
            rooms.delete(room);
            console.log(`[${new Date().toISOString()}] Oda silindi: ${room} (${roomAge}sn aktifti)`);
        }
    }

    console.log(`[${new Date().toISOString()}] ${mode} modu ${room} odasından ayrıldı`);
}

/**
 * İstemciye mesaj gönder
 */
function sendToClient(ws, data) {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
    }
}

/**
 * Hata mesajı gönder
 */
function sendError(ws, message) {
    sendToClient(ws, {
        type: 'error',
        message: message
    });
}

// Bağlantı kontrolü (heartbeat interval'da bir)
const heartbeatInterval = setInterval(() => {
    const now = Date.now();
    let activeCount = 0;
    let zombieCount = 0;
    
    wss.clients.forEach((ws) => {
        // Ping/Pong kontrolü
        if (!ws.isAlive) {
            console.log(`[${new Date().toISOString()}] Ölü bağlantı kapatılıyor: ${ws.clientId}`);
            zombieCount++;
            return ws.terminate();
        }
        
        // Zombie bağlantı kontrolü - uzun süredir aktivite yok
        const inactiveTime = now - (ws.lastActivity || now);
        if (inactiveTime > CONNECTION_TIMEOUT) {
            console.log(`[${new Date().toISOString()}] Zombie bağlantı kapatılıyor: ${ws.clientId} (${Math.round(inactiveTime/1000)}sn inaktif)`);
            zombieCount++;
            return ws.terminate();
        }
        
        ws.isAlive = false;
        ws.ping();
        activeCount++;
    });
    
    // Periyodik durum raporu
    if (activeCount > 0 || zombieCount > 0) {
        console.log(`[${new Date().toISOString()}] Durum: ${activeCount} aktif bağlantı, ${zombieCount} zombie temizlendi, ${rooms.size} oda`);
    }
}, HEARTBEAT_INTERVAL);

wss.on('close', () => {
    clearInterval(heartbeatInterval);
});

// Sunucuyu başlat
server.listen(PORT, () => {
    console.log(`🍼 Bebek Telsizi Sunucusu başlatıldı`);
    console.log(`📡 Port: ${PORT}`);
    console.log(`🔗 ws://localhost:${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('Sunucu kapatılıyor...');
    wss.close(() => {
        server.close(() => {
            console.log('Sunucu kapatıldı');
            process.exit(0);
        });
    });
});
