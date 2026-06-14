const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.use(express.static(path.join(__dirname, 'public')));

const activeRooms = {};

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // 1. Host creates a room
    socket.on('createRoom', (name) => {
        const roomCode = Math.random().toString(36).substring(2, 6).toUpperCase();
        
        activeRooms[roomCode] = { players: {} };
        activeRooms[roomCode].players[socket.id] = name || 'Host';
        
        socket.join(roomCode);
        socket.emit('roomCreated', roomCode);
    });

    // 2. Guest joins a room
    socket.on('joinRoom', (data) => {
        // FIXED BUG: Now properly looking for "name"
        const { code, name } = data;

        if (activeRooms[code]) {
            if (Object.keys(activeRooms[code].players).length >= 15) {
                socket.emit('accessDenied', 'Group is full.');
                return;
            }

            socket.join(code);
            socket.emit('accessGranted', code);
            
            socket.emit('currentPlayers', activeRooms[code].players);
            
            // FIXED BUG: Using the correct name variable
            const finalName = name || 'Friend';
            activeRooms[code].players[socket.id] = finalName;
            
            socket.to(code).emit('newPlayerJoined', { id: socket.id, name: finalName });
        } else {
            socket.emit('accessDenied', 'Invalid group code.');
        }
    });

    // 3. WebRTC Signaling
    socket.on('signal', (data) => {
        io.to(data.targetId).emit('signalData', {
            senderId: socket.id,
            signal: data.signal
        });
    });

    // 4. Audio Routing
    socket.on('audioActive', (data) => {
        if (data.targetId === 'all') {
            socket.rooms.forEach(room => {
                if (room !== socket.id) { 
                    socket.to(room).emit('peerAudioStatus', { senderId: socket.id, active: data.active });
                }
            });
        } else {
            io.to(data.targetId).emit('peerAudioStatus', { senderId: socket.id, active: data.active });
        }
    });

    // 5. Cleanup
    socket.on('disconnect', () => {
        for (const roomCode in activeRooms) {
            if (activeRooms[roomCode].players[socket.id]) {
                delete activeRooms[roomCode].players[socket.id];
                socket.to(roomCode).emit('playerLeft', socket.id);
                if (Object.keys(activeRooms[roomCode].players).length === 0) {
                    delete activeRooms[roomCode];
                }
                break;
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server running on port ${PORT}`));
