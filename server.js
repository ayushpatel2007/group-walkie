const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

// Serve frontend files automatically from the 'public' folder
app.use(express.static(path.join(__dirname, 'public')));

// Server memory: Tracks active rooms and the specific socket IDs of players inside them
const activeRooms = {};

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // --- ROOM MANAGEMENT ---

    // 1. Host creates a room
    socket.on('createRoom', () => {
        const roomCode = Math.random().toString(36).substring(2, 6).toUpperCase();
        
        // Initialize the room and add the host to the player list
        activeRooms[roomCode] = { players: [socket.id] };
        
        socket.join(roomCode);
        socket.emit('roomCreated', roomCode);
        console.log(`Room created: ${roomCode}`);
    });

    // 2. Guest attempts to join a room
    socket.on('joinRoom', (code) => {
        if (activeRooms[code]) {
            // Prevent overcrowding (Max 15 players)
            if (activeRooms[code].players.length >= 15) {
                socket.emit('accessDenied', 'Group is full (Max 15).');
                return;
            }

            // Grant access and join the socket room
            socket.join(code);
            socket.emit('accessGranted', code);
            
            // Tell the new user who is ALREADY in the room so they can connect
            socket.emit('currentPlayers', activeRooms[code].players);
            
            // Add the new user to the list
            activeRooms[code].players.push(socket.id);
            
            // Tell everyone else in the room that a new specific person joined
            socket.to(code).emit('newPlayerJoined', socket.id);
            console.log(`User joined room: ${code}`);
        } else {
            socket.emit('accessDenied', 'Invalid group code. Please check and try again.');
        }
    });

    // --- WEBRTC SIGNALING (MESH NETWORK) ---

    // Route the peer-to-peer connection data directly to specific individuals
    socket.on('signal', (data) => {
        io.to(data.targetId).emit('signalData', {
            senderId: socket.id,
            signal: data.signal
        });
    });

    // --- AUDIO STATUS ROUTING (UI Glowing Dots) ---
    
    socket.on('audioActive', (data) => {
        // If they are talking to everyone (Global Button)
        if (data.targetId === 'all') {
            // Find all rooms this socket is in and broadcast the light-up signal
            socket.rooms.forEach(room => {
                if (room !== socket.id) { // Don't send it back to themselves
                    socket.to(room).emit('peerAudioStatus', { 
                        senderId: socket.id, 
                        active: data.active 
                    });
                }
            });
        } 
        // If they are using the WHISPER button
        else {
            // Send the light-up signal ONLY to the specific person they are whispering to
            io.to(data.targetId).emit('peerAudioStatus', { 
                senderId: socket.id, 
                active: data.active 
            });
        }
    });

    // --- CLEANUP ---

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        
        // Find which room they were in, remove them, and notify others
        for (const roomCode in activeRooms) {
            const players = activeRooms[roomCode].players;
            const index = players.indexOf(socket.id);
            
            if (index !== -1) {
                players.splice(index, 1); // Remove from the array
                
                // Tell the remaining group members to delete their peer connection
                socket.to(roomCode).emit('playerLeft', socket.id);
                
                // If the room is empty, delete it entirely from server memory
                if (players.length === 0) {
                    delete activeRooms[roomCode];
                    console.log(`Room ${roomCode} deleted (empty)`);
                }
                break;
            }
        }
    });
});

// Start the server
const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Group Walkie-Talkie server is running on port ${PORT}`);
});