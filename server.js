const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.use(express.static(path.join(__dirname, 'public')));

// Server memory now tracks { roomCode: { players: { 'socketId': 'Username' } } }
const activeRooms = {};

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // 1. Host creates a room
    socket.on('createRoom', (username) => {
        const roomCode = Math.random().toString(36).substring(2, 6).toUpperCase();
        
        activeRooms[roomCode] = { players: {} };
        // Save the host's actual name
        activeRooms[roomCode].players[socket.id] = username || 'Host';
        
        socket.join(roomCode);
        socket.emit('roomCreated', roomCode);
    });

    // 2. Guest joins a room
    socket.on('joinRoom', (data) => {
        const { code, username } = data;

        if (activeRooms[code]) {
            // Prevent overcrowding
            if (Object.keys(activeRooms[code].players).length >= 15) {
                socket.emit('accessDenied', 'Group is full (Max 15).');
                return;
            }

            socket.join(code);
            socket.emit('accessGranted', code);
            
            // Send the entire dictionary of current names to the new person
            socket.emit('currentPlayers', activeRooms[code].players);
            
            // Save the new person's name
            const finalName = username || 'Friend';
            activeRooms[code].players[socket.id] = finalName;
            
            // Tell everyone else the specific name of the person who just joined
            socket.to(code).emit('newPlayerJoined', { id: socket.id, name: finalName });
        } else {
            socket.emit('accessDenied', 'Invalid group code.');
        }
    });

    // 3. WebRTC Signaling (Mesh Network)
    socket.on('signal', (data) => {
        io.to(data.targetId).emit('signalData', {
            senderId: socket.id,
            signal: data.signal
        });
    });

    // 4. Audio Status Routing (Glowing Dots)
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

    // 5. Cleanup when someone closes the app
    socket.on('disconnect', () => {
        for (const roomCode in activeRooms) {
            // If they were in this room, remove their specific name record
            if (activeRooms[roomCode].players[socket.id]) {
                delete activeRooms[roomCode].players[socket.id];
                
                socket.to(roomCode).emit('playerLeft', socket.id);
                
                // Delete room if empty
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
