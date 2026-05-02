const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.static(path.join(__dirname)));

const PLAYERS_FILE = path.join(__dirname, 'data', 'players.json');
const ROOMS_FILE = path.join(__dirname, 'data', 'rooms.json');
const SESSIONS_FILE = path.join(__dirname, 'data', 'sessions.json');

const playersDb = new Map();
const roomsDb = new Map();
const sessionsDb = new Map();
const spectators = new Map();

function loadState() {
    try {
        if (fs.existsSync(PLAYERS_FILE)) {
            const data = JSON.parse(fs.readFileSync(PLAYERS_FILE, 'utf8'));
            for (const [id, player] of Object.entries(data)) playersDb.set(id, player);
        }
        if (fs.existsSync(ROOMS_FILE)) {
            const data = JSON.parse(fs.readFileSync(ROOMS_FILE, 'utf8'));
            for (const [id, room] of Object.entries(data)) {
                room.playersBack = room.playersBack ? new Set(room.playersBack) : new Set();
                roomsDb.set(id, room);
            }
        }
        if (fs.existsSync(SESSIONS_FILE)) {
            const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
            for (const [id, session] of Object.entries(data)) {
                session.eatenApples = session.eatenApples ? new Map(session.eatenApples) : new Map();
                sessionsDb.set(id, session);
            }
        }
        console.log(`Loaded ${playersDb.size} players, ${roomsDb.size} rooms, ${sessionsDb.size} sessions.`);
    } catch (e) {
        console.error('Error loading state', e);
    }
}

function saveState() {
    try {
        const dataDir = path.join(__dirname, 'data');
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }
        
        fs.writeFileSync(PLAYERS_FILE, JSON.stringify(Object.fromEntries(playersDb), null, 2));
        
        const rData = {};
        for (const [code, room] of roomsDb.entries()) {
            rData[code] = {
                ...room,
                playersBack: room.playersBack ? Array.from(room.playersBack) : []
            };
        }
        fs.writeFileSync(ROOMS_FILE, JSON.stringify(rData, null, 2));
        
        const sData = {};
        for (const [code, session] of sessionsDb.entries()) {
            sData[code] = {
                ...session,
                eatenApples: session.eatenApples ? Array.from(session.eatenApples.entries()) : []
            };
        }
        fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sData, null, 2));
    } catch (e) {
        console.error('Error saving state', e);
    }
}

loadState();
setInterval(saveState, 2000);

// ROOM CLEANUP CRON JOB (Every 1 minute)
setInterval(() => {
    for (const [code, room] of roomsDb.entries()) {
        const ioRoom = io.sockets.adapter.rooms.get(code);
        const hasActiveSockets = ioRoom && ioRoom.size > 0;
        
        if (hasActiveSockets) {
            room.expiresAt = null; // Alive
        } else {
            if (!room.expiresAt) {
                room.expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes timeout
            } else if (Date.now() > room.expiresAt) {
                roomsDb.delete(code);
                spectators.delete(code);
                console.log(`[Cron] Room ${code} expired and deleted.`);
            }
        }
    }
}, 60000);

function generateRoomCode() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function generateApplePositions(appleDensity, gridSize = 10) {
    const totalPoints = gridSize * gridSize;
    const appleCount = Math.floor(totalPoints * appleDensity);
    const posSet = new Set();
    while (posSet.size < appleCount) {
        const x = Math.floor(Math.random() * gridSize);
        const y = Math.floor(Math.random() * gridSize);
        posSet.add(`${x},${y}`);
    }
    return Array.from(posSet).map(pos => {
        const [x, y] = pos.split(',').map(Number);
        return { x, y };
    });
}

io.on('connection', (socket) => {
    console.log('New client connected:', socket.id);

    socket.on('createRoom', (data) => {
        const { config, name, avatarIndex, playerId } = data;
        const pId = playerId || socket.id;
        
        playersDb.set(pId, { id: pId, name: name || 'Anonymous', avatarIndex: avatarIndex ?? 0, lastActive: Date.now() });

        let roomCode;
        do { roomCode = generateRoomCode(); } while (roomsDb.has(roomCode));

        const room = {
            id: roomCode,
            creatorId: pId,
            config: {
                appleDensity: config?.appleDensity || 0.25,
                timePerTurn: config?.timePerTurn || 60,
                mode: config?.mode || 'balanced',
                gridSize: config?.gridSize || 10
            },
            status: 'waiting',
            players: [pId],
            expiresAt: null
        };
        roomsDb.set(roomCode, room);

        socket.join(roomCode);
        socket.data.roomCode = roomCode;
        socket.data.playerId = pId;

        socket.emit('roomCreated', { 
            roomCode, 
            players: [{ id: pId, name: name || 'Anonymous', avatarIndex: avatarIndex ?? 0 }] 
        });
        console.log(`Room created: ${roomCode} by ${name}`);
    });

    socket.on('getAvailableRooms', () => {
        const available = Array.from(roomsDb.values())
            .filter(r => r.status === 'waiting' || r.status === 'playing' || r.status === 'ended')
            .map(r => {
                const creator = playersDb.get(r.creatorId);
                let displayStatus;
                if (r.status === 'playing') displayStatus = 'playing';
                else if (r.status === 'ended' || r.players.length >= 2) displayStatus = 'full';
                else displayStatus = 'waiting';
                return {
                    code: r.id,
                    creator: creator ? creator.name : 'Unknown',
                    config: r.config,
                    playerCount: r.players.length,
                    status: displayStatus
                };
            });
        socket.emit('availableRooms', available);
    });

    socket.on('joinRoom', (data) => {
        const room = roomsDb.get(data.roomCode);
        const pId = data.playerId || socket.id;
        const playerName = data.name || 'Anonymous';
        if (!room) { socket.emit('joinFailed', { message: 'Room not found' }); return; }
        if (room.players.length >= 2 && !room.players.includes(pId)) { socket.emit('joinFailed', { message: 'Room is full' }); return; }

        let finalAvatarIndex = data.avatarIndex ?? 0;
        const creatorId = room.creatorId;
        const creator = playersDb.get(creatorId);
        if (creator && creator.avatarIndex === finalAvatarIndex) {
            finalAvatarIndex = (finalAvatarIndex + 1) % 8;
        }

        playersDb.set(pId, { id: pId, name: playerName, avatarIndex: finalAvatarIndex, lastActive: Date.now() });

        if (!room.players.includes(pId)) {
            room.players.push(pId);
        }
        
        room.expiresAt = null; // Alive
        
        socket.join(data.roomCode);
        socket.data.roomCode = data.roomCode;
        socket.data.playerId = pId;

        const fullPlayers = room.players.map(pid => {
            const p = playersDb.get(pid);
            return { id: p.id, name: p.name, avatarIndex: p.avatarIndex };
        });

        io.to(data.roomCode).emit('playerJoined', {
            players: fullPlayers,
            config: room.config
        });
    });

    socket.on('gameReady', (data) => {
        const room = roomsDb.get(data.roomCode);
        if (!room || room.players.length !== 2) return;

        room.status = 'playing';

        const creatorId = room.creatorId;
        const joinerId = room.players.find(id => id !== creatorId);
        
        const creatorPlayer = playersDb.get(creatorId);
        const joinerPlayer = playersDb.get(joinerId);

        if (creatorPlayer.avatarIndex === joinerPlayer.avatarIndex) {
            joinerPlayer.avatarIndex = (creatorPlayer.avatarIndex + 1) % 8;
        }

        const applePositions = generateApplePositions(room.config.appleDensity, room.config.gridSize);

        const sessionId = Math.random().toString(36).substring(2, 10);
        
        const session = {
            id: sessionId,
            roomId: room.id,
            startTime: Date.now() + 3400,
            status: 'ongoing',
            applePositions,
            eatenApples: new Map(),
            history: [],
            playerStats: {}
        };
        
        room.players.forEach(pid => {
            session.playerStats[pid] = { score: 0, expressionsUsed: 0, penaltyFactor: 1 };
        });
        
        sessionsDb.set(room.id, session);

        const baseData = {
            creatorName: creatorPlayer.name,
            joinerName: joinerPlayer.name,
            appleDensity: room.config.appleDensity,
            timePerTurn: room.config.timePerTurn,
            gridSize: room.config.gridSize,
            applePositions
        };

        const roomSockets = io.sockets.adapter.rooms.get(room.id);
        if (roomSockets) {
            for (const sockId of roomSockets) {
                const sock = io.sockets.sockets.get(sockId);
                if (sock && sock.data.playerId === creatorId) {
                    sock.emit('gameStart', {
                        ...baseData,
                        myPlayerNum: 1,
                        yourAvatarIndex: creatorPlayer.avatarIndex,
                        opponentAvatarIndex: joinerPlayer.avatarIndex
                    });
                } else if (sock && sock.data.playerId === joinerId) {
                    sock.emit('gameStart', {
                        ...baseData,
                        myPlayerNum: 2,
                        yourAvatarIndex: joinerPlayer.avatarIndex,
                        opponentAvatarIndex: creatorPlayer.avatarIndex
                    });
                }
            }
        }
    });

    socket.on('updateGameState', (data) => {
        const roomCode = socket.data.roomCode;
        if (!roomCode) return;
        
        const session = sessionsDb.get(roomCode);
        if (session && session.status === 'ongoing') {
            const pId = socket.data.playerId;
            const stats = session.playerStats[pId];
            if (stats) {
                stats.score += (data.pointsGained || 0);
                stats.expressionsUsed += 1;
                stats.penaltyFactor = data.penaltyFactor;
                
                session.history.push({
                    playerId: pId,
                    equation: data.equation,
                    applesEaten: data.applesEaten,
                    pointsGained: data.pointsGained,
                    degree: data.degree,
                    time: data.time,
                    penalty: data.usedPenalty
                });
            }
            if (data.appleStates) {
                const room = roomsDb.get(roomCode);
                const creatorId = room.creatorId;
                const joinerId = room.players.find(id => id !== creatorId);
                
                data.appleStates.forEach(a => { 
                    if (a.eaten) {
                        const ownerId = (a.eatenBy === 1) ? creatorId : joinerId;
                        session.eatenApples.set(`${a.x},${a.y}`, ownerId);
                    }
                });
            }
        }

        socket.broadcast.to(roomCode).emit('gameStateUpdated', data);
    });

    socket.on('guestJoinRoom', (data) => {
        const room = roomsDb.get(data.roomCode);
        const session = sessionsDb.get(data.roomCode);
        
        if (!room || room.status !== 'playing' || !session) {
            socket.emit('guestJoinFailed', { message: 'Game is not in progress' });
            return;
        }
        
        const creatorId = room.creatorId;
        const joinerId = room.players.find(id => id !== creatorId);
        
        const creatorPlayer = playersDb.get(creatorId);
        const joinerPlayer = playersDb.get(joinerId);

        if (!spectators.has(data.roomCode)) spectators.set(data.roomCode, new Set());
        spectators.get(data.roomCode).add(socket.id);
        socket.join(data.roomCode);
        socket.data.spectatingRoom = data.roomCode;
        
        const mappedPlayers = [creatorId, joinerId].map((pid) => {
            const p = playersDb.get(pid);
            const stats = session.playerStats[pid] || {};
            const history = session.history.filter(h => h.playerId === pid).map(h => ({
                equation: h.equation,
                applesEaten: h.applesEaten,
                pointsGained: h.pointsGained,
                degree: h.degree,
                time: h.time,
                penalty: h.penalty
            }));
            return {
                id: p.id,
                name: p.name,
                avatarIndex: p.avatarIndex,
                score: stats.score || 0,
                expressionsUsed: stats.expressionsUsed || 0,
                penaltyFactor: stats.penaltyFactor || 1,
                history: history
            };
        });

        const eatenApplesArr = Array.from(session.eatenApples.entries()).map(([k, v]) => {
            return { pos: k, eatenBy: v === creatorId ? 1 : 2 };
        });

        socket.emit('guestGameSync', {
            roomCode: data.roomCode,
            creatorName: creatorPlayer.name,
            joinerName: joinerPlayer.name,
            appleDensity: room.config.appleDensity,
            timePerTurn: room.config.timePerTurn,
            gridSize: room.config.gridSize,
            applePositions: session.applePositions,
            eatenApples: eatenApplesArr,
            elapsedTime: Date.now() - session.startTime,
            players: mappedPlayers
        });
    });

    socket.on('guestLeaveRoom', () => {
        const roomCode = socket.data.spectatingRoom;
        if (roomCode) {
            spectators.get(roomCode)?.delete(socket.id);
            socket.leave(roomCode);
            socket.data.spectatingRoom = null;
        }
    });

    socket.on('gameEnded', (data) => {
        const room = roomsDb.get(data.roomCode);
        const session = sessionsDb.get(data.roomCode);
        if (room && room.status !== 'ended') {
            room.status = 'ended';
            room.playersBack = new Set();
            if (session) {
                session.status = 'completed';
                session.endTime = Date.now();
            }
            
            const reason = data.reason || 'timeout';
            io.to(data.roomCode).emit('gameEndedServer', { reason });
            const roomSpecs = spectators.get(data.roomCode);
            if (roomSpecs) {
                roomSpecs.forEach(specId => io.to(specId).emit('gameEndedServer', { reason }));
            }
        }
    });

    socket.on('returnToRoom', (data) => {
        const room = roomsDb.get(data.roomCode);
        if (!room) { socket.emit('roomGone'); return; }
        const pId = data.playerId || socket.data.playerId || socket.id;

        if (!room.players.includes(pId)) {
            room.players.push(pId);
        }
        
        room.expiresAt = null;
        
        socket.join(data.roomCode);
        socket.data.roomCode = data.roomCode;
        socket.data.playerId = pId;

        room.playersBack = room.playersBack || new Set();
        room.playersBack.add(pId);
        
        const isCreator = pId === room.creatorId;
        const bothBack  = room.playersBack.size >= 2;

        // Include returning player's display info so the other side can refresh their waiting slots
        const returningPlayer = playersDb.get(pId);
        const playerInfo = returningPlayer
            ? { name: returningPlayer.name, avatarIndex: returningPlayer.avatarIndex, isCreator }
            : null;

        socket.broadcast.to(data.roomCode).emit('playerReturnedToRoom', { isCreator, bothBack, player: playerInfo });
        socket.emit('returnedToRoomAck', { isCreator, bothBack });
    });

    socket.on('playerLeft', (data) => {
        const roomCode = data.roomCode;
        if (!roomCode) return;
        const room = roomsDb.get(roomCode);
        const session = sessionsDb.get(roomCode);
        if (room) {
            const pId = socket.data.playerId;
            if (room.status === 'playing') {
                const loserNum = room.creatorId === pId ? 1 : 2;
                const reason = data.reason || 'exit';
                
                io.to(roomCode).emit('gameEndedServer', { reason, loserNum });
                const roomSpecs = spectators.get(roomCode);
                if (roomSpecs) roomSpecs.forEach(s => io.to(s).emit('gameEndedServer', { reason, loserNum }));
                
                if (session) {
                    session.status = 'abandoned';
                    session.endTime = Date.now();
                }
                socket.broadcast.to(roomCode).emit('opponentLeft');
            }
            
            room.players = room.players.filter(id => id !== pId);

            if (room.players.length === 0) {
                if (room.status === 'waiting') {
                    roomsDb.delete(roomCode);
                }
            } else {
                room.status = 'waiting';
                if (room.playersBack) room.playersBack.delete(pId);

                // Host promotion: if creator left, promote remaining player to host
                if (pId === room.creatorId && room.players.length > 0) {
                    room.creatorId = room.players[0];
                    io.to(roomCode).emit('hostPromoted', {
                        newHostId: room.creatorId,
                        players: room.players.map(pid => {
                            const p = playersDb.get(pid);
                            return { id: p.id, name: p.name, avatarIndex: p.avatarIndex };
                        })
                    });
                    console.log(`[Host Promotion] Room ${roomCode}: ${pId} left, ${room.creatorId} promoted to host`);
                }
            }
        }
        socket.leave(roomCode);
        socket.data.roomCode = null;
    });

    socket.on('disconnect', () => {
        const roomCode = socket.data.roomCode;
        if (roomCode) {
            const room = roomsDb.get(roomCode);
            const session = sessionsDb.get(roomCode);
            if (room) {
                const pId = socket.data.playerId;
                if (room.status === 'playing') {
                    const loserNum = room.creatorId === pId ? 1 : 2;
                    io.to(roomCode).emit('gameEndedServer', { reason: 'exit', loserNum });
                    const roomSpecs = spectators.get(roomCode);
                    if (roomSpecs) roomSpecs.forEach(s => io.to(s).emit('gameEndedServer', { reason: 'exit', loserNum }));
                    
                    if (session) {
                        session.status = 'abandoned';
                        session.endTime = Date.now();
                    }
                    socket.broadcast.to(roomCode).emit('opponentDisconnected');
                }
                
                room.players = room.players.filter(id => id !== pId);
                if (room.players.length === 0) {
                    if (room.status === 'waiting') {
                        roomsDb.delete(roomCode);
                    }
                } else {
                    room.status = 'waiting';

                    // Host promotion: if creator disconnected, promote remaining player to host
                    if (pId === room.creatorId && room.players.length > 0) {
                        room.creatorId = room.players[0];
                        io.to(roomCode).emit('hostPromoted', {
                            newHostId: room.creatorId,
                            players: room.players.map(pid => {
                                const p = playersDb.get(pid);
                                return { id: p.id, name: p.name, avatarIndex: p.avatarIndex };
                            })
                        });
                        console.log(`[Host Promotion] Room ${roomCode}: ${pId} disconnected, ${room.creatorId} promoted to host`);
                    }
                }
            }
        }
        const spectatingRoom = socket.data.spectatingRoom;
        if (spectatingRoom) spectators.get(spectatingRoom)?.delete(socket.id);
        console.log('Client disconnected:', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
