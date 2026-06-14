const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.use(express.static(path.join(__dirname, 'public')));

const activeRooms = {};

io.on('connection', (socket) => {
    // 1. Host creates a room (NOW WITH PASSWORD)
    socket.on('createRoom', (data) => {
        const roomCode = Math.random().toString(36).substring(2, 6).toUpperCase();
        
        // Save the password securely in server memory
        activeRooms[roomCode] = { 
            players: {}, 
            password: data.password || '' 
        };
        activeRooms[roomCode].players[socket.id] = data.name || 'Host';
        
        socket.join(roomCode);
        socket.emit('roomCreated', roomCode);
    });

    // 2. Guest joins a room
    socket.on('joinRoom', (data) => {
        const { code, name, password } = data;

        if (activeRooms[code]) {
            // NEW: Password Checker
            if (activeRooms[code].password !== '' && activeRooms[code].password !== password) {
                socket.emit('accessDenied', 'Incorrect Room Password.');
                return;
            }

            if (Object.keys(activeRooms[code].players).length >= 15) {
                socket.emit('accessDenied', 'Group is full.');
                return;
            }

            socket.join(code);
            socket.emit('accessGranted', code);
            
            socket.emit('currentPlayers', activeRooms[code].players);
            
            const finalName = name || 'Friend';
            activeRooms[code].players[socket.id] = finalName;
            socket.to(code).emit('newPlayerJoined', { id: socket.id, name: finalName });
        } else {
            socket.emit('accessDenied', 'Invalid group code.');
        }
    });

    socket.on('signal', (data) => {
        io.to(data.targetId).emit('signalData', { senderId: socket.id, signal: data.signal });
    });

    socket.on('audioActive', (data) => {
        if (data.targetId === 'all') {
            socket.rooms.forEach(room => {
                if (room !== socket.id) socket.to(room).emit('peerAudioStatus', { senderId: socket.id, active: data.active });
            });
        } else {
            io.to(data.targetId).emit('peerAudioStatus', { senderId: socket.id, active: data.active });
        }
    });

    // NEW: Route the Emergency Alert
    socket.on('emergencyAlert', (data) => {
        if (data.targetId === 'all') {
            socket.rooms.forEach(room => {
                if (room !== socket.id) socket.to(room).emit('receiveEmergency', { senderId: socket.id });
            });
        } else {
            io.to(data.targetId).emit('receiveEmergency', { senderId: socket.id });
        }
    });

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
