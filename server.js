/**
 * Bebek Telsizi WebSocket Sinyal Sunucusu
 * 
 * Bu sunucu, bebek ve ebeveyn telefonları arasında ses verisi aktarımını sağlar.
 * Her oda için iki cihaz (bir bebek modu, bir ebeveyn modu) bağlanabilir.
 */

const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 10000;

// HTTP sunucusu oluştur
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
        status: 'running',
        message: 'Bebek Telsizi Sunucusu Çalışıyor',
        rooms: Object.keys(rooms).length
    }));
});

// WebSocket sunucusu oluştur
const wss = new WebSocket.Server({ server });

// Oda yönetimi
const rooms = new Map();

// Bağlantı olayı
wss.on('connection', (ws, req) => {
    console.log('Yeni bağlantı:', req.socket.remoteAddress);
    
    let currentRoom = null;
    let currentMode = null;
    
    // Ping/Pong ile bağlantı kontrolü
    ws.isAlive = true;
    ws.on('pong', () => {
        ws.isAlive = true;
    });

    // Mesaj olayı
    ws.on('message', (message) => {
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
                    
                case 'leave':
                    handleLeave(ws, currentRoom, currentMode);
                    currentRoom = null;
                    currentMode = null;
                    break;
            }
        } catch (error) {
            console.error('Mesaj işleme hatası:', error);
            sendError(ws, 'Geçersiz mesaj formatı');
        }
    });

    // Bağlantı kapanma olayı
    ws.on('close', () => {
        console.log('Bağlantı kapandı');
        if (currentRoom) {
            handleLeave(ws, currentRoom, currentMode);
        }
    });

    // Hata olayı
    ws.on('error', (error) => {
        console.error('WebSocket hatası:', error);
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
        rooms.set(room, { baby: null, parent: null });
    }

    const roomData = rooms.get(room);

    // Aynı modda başka bir cihaz varsa uyar
    if (roomData[mode] && roomData[mode] !== ws) {
        // Eski bağlantıyı kapat
        try {
            roomData[mode].close(1000, 'Yeni cihaz bağlandı');
        } catch (e) {
            // Hata yoksay
        }
    }

    // Cihazı odaya ekle
    roomData[mode] = ws;
    callback(room, mode);

    console.log(`${mode} modu ${room} odasına katıldı`);

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
        return;
    }

    const roomData = rooms.get(room);
    const targetMode = mode === 'baby' ? 'parent' : 'baby';
    const target = roomData[targetMode];

    if (target && target.readyState === WebSocket.OPEN) {
        sendToClient(target, {
            type: 'audio',
            data: data.data
        });
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
            sendToClient(roomData[otherMode], {
                type: 'peer_left',
                mode: mode
            });
        }

        // Oda boşsa sil
        if (!roomData.baby && !roomData.parent) {
            rooms.delete(room);
            console.log(`Oda silindi: ${room}`);
        }
    }

    console.log(`${mode} modu ${room} odasından ayrıldı`);
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

// Bağlantı kontrolü (30 saniyede bir)
const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (!ws.isAlive) {
            console.log('Ölü bağlantı kapatılıyor');
            return ws.terminate();
        }
        
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

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

