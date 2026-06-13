const socket = io();

// UI Elements
const lobbyScreen = document.getElementById('lobby-screen');
const radioScreen = document.getElementById('radio-screen');
const joinCodeInput = document.getElementById('join-code-input');
const pttBtn = document.getElementById('ptt-btn');
const pttText = document.getElementById('ptt-text');
const roomIdBanner = document.getElementById('room-id-banner');
const playerList = document.getElementById('player-list');
const audioContainer = document.getElementById('audio-container');

// App State
let localStream = null;
let currentRoomCode = null;
let isTransmitting = false;

// MESH NETWORK STATE
const peers = {}; 
const clonedTracks = {}; 

const rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};

// --- ROOM ACCESS ---

document.getElementById('create-btn').addEventListener('click', () => socket.emit('createRoom'));
document.getElementById('join-btn').addEventListener('click', () => {
    const code = joinCodeInput.value.trim().toUpperCase();
    if (code.length === 4) socket.emit('joinRoom', code);
});

socket.on('roomCreated', (code) => enterRoom(code));
socket.on('accessGranted', (code) => enterRoom(code));
socket.on('accessDenied', (msg) => alert(msg));

async function enterRoom(code) {
    currentRoomCode = code;
    lobbyScreen.style.display = 'none';
    radioScreen.style.display = 'flex';
    roomIdBanner.innerText = `GROUP CODE: ${code}`;
    
    // Add yourself to the top of the friends list
    addPlayerToUI('Me (You)', true);

    try {
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
        alert("Microphone access is required to use the walkie-talkie.");
    }
}

// --- NETWORK SIGNALING ---

socket.on('currentPlayers', (players) => {
    players.forEach(id => {
        if (id !== socket.id) {
            addPlayerToUI(id, false);
            createPeerConnection(id, true);
        }
    });
});

socket.on('newPlayerJoined', (id) => {
    addPlayerToUI(id, false);
    createPeerConnection(id, false);
});

socket.on('signalData', async (data) => {
    const { senderId, signal } = data;
    const pc = peers[senderId];
    if (!pc) return;

    if (signal.type === 'offer') {
        await pc.setRemoteDescription(new RTCSessionDescription(signal));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('signal', { targetId: senderId, signal: answer });
    } else if (signal.type === 'answer') {
        await pc.setRemoteDescription(new RTCSessionDescription(signal));
    } else if (signal.candidate) {
        await pc.addIceCandidate(new RTCIceCandidate(signal));
    }
});

socket.on('playerLeft', (id) => {
    if (peers[id]) {
        peers[id].close();
        delete peers[id];
        delete clonedTracks[id];
    }
    const uiElement = document.getElementById(`friend-${id}`);
    if (uiElement) uiElement.remove();
});

// --- CONNECTION BUILDER ---

async function createPeerConnection(peerId, isInitiator) {
    const pc = new RTCPeerConnection(rtcConfig);
    peers[peerId] = pc;

    // Clone your mic track explicitly for this peer tunnel
    const personalTrack = localStream.getAudioTracks()[0].clone();
    personalTrack.enabled = false; 
    clonedTracks[peerId] = personalTrack;
    pc.addTrack(personalTrack, localStream);

    pc.ontrack = (event) => {
        let audioEl = document.getElementById(`audio-${peerId}`);
        if (!audioEl) {
            audioEl = document.createElement('audio');
            audioEl.id = `audio-${peerId}`;
            audioEl.autoplay = true;
            audioContainer.appendChild(audioEl);
        }
        audioEl.srcObject = event.streams[0];
    };

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('signal', { targetId: peerId, signal: event.candidate });
        }
    };

    if (isInitiator) {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('signal', { targetId: peerId, signal: offer });
    }
}

// --- UI & WHISPER INJECTION ---

function addPlayerToUI(id, isMe) {
    const div = document.createElement('div');
    div.className = 'player-item';
    div.id = isMe ? 'friend-me' : `friend-${id}`;
    
    // Generate a random fun color for their avatar dot
    const colors = ['#34c759', '#007aff', '#ff9500', '#af52de', '#ff3b30'];
    const randomColor = colors[Math.floor(Math.random() * colors.length)];
    const displayName = isMe ? "Me (You)" : `Friend ${id.substring(0, 4)}`;
    
    let htmlContent = `
        <div style="display: flex; align-items: center; gap: 10px;">
            <div style="width: 24px; height: 24px; border-radius: 50%; background-color: ${randomColor}; display: flex; align-items: center; justify-content: center; font-size: 10px; font-weight: bold; color: white;">
                ${displayName.charAt(0)}
            </div>
            <span>${displayName}</span>
        </div>
        <div class="friend-row-right" id="right-col-${id}">
            <span class="indicator"></span>
        </div>
    `;
    div.innerHTML = htmlContent;
    playerList.appendChild(div);

    // If it's a friend (not you), attach their personal WHISPER button
    if (!isMe) {
        const rightCol = document.getElementById(`right-col-${id}`);
        const whisperBtn = document.createElement('button');
        whisperBtn.className = 'private-ptt-btn';
        whisperBtn.innerText = 'WHISPER';

        // Bind touch and mouse events for whispering
        whisperBtn.addEventListener('mousedown', () => startWhisper(id, whisperBtn));
        whisperBtn.addEventListener('mouseup', () => stopWhisper(id, whisperBtn));
        whisperBtn.addEventListener('mouseleave', () => stopWhisper(id, whisperBtn));
        
        whisperBtn.addEventListener('touchstart', (e) => { e.preventDefault(); startWhisper(id, whisperBtn); });
        whisperBtn.addEventListener('touchend', (e) => { e.preventDefault(); stopWhisper(id, whisperBtn); });

        rightCol.insertBefore(whisperBtn, rightCol.firstChild);
    }
}

// --- GLOBAL PUSH TO TALK ---

function startTransmission() {
    if (!localStream || isTransmitting || activeWhisperTarget) return;
    isTransmitting = true;

    // Unmute mic for everyone in the group
    for (let id in clonedTracks) clonedTracks[id].enabled = true;

    pttBtn.classList.add('transmitting');
    pttText.innerText = "TRANSMITTING";
    
    document.getElementById('friend-me').classList.add('receiving-audio');
    socket.emit('audioActive', { targetId: 'all', active: true });
}

function stopTransmission() {
    if (!isTransmitting) return;
    isTransmitting = false;

    // Mute mic for everyone
    for (let id in clonedTracks) clonedTracks[id].enabled = false;

    pttBtn.classList.remove('transmitting');
    pttText.innerText = "HOLD TO SPEAK";
    
    document.getElementById('friend-me').classList.remove('receiving-audio');
    socket.emit('audioActive', { targetId: 'all', active: false });
}

// --- WHISPER PUSH TO TALK ---

let activeWhisperTarget = null;

function startWhisper(targetId, btnElement) {
    if (!localStream || isTransmitting || activeWhisperTarget) return;
    activeWhisperTarget = targetId;

    // Unmute ONLY this specific friend's audio track tunnel
    if (clonedTracks[targetId]) {
        clonedTracks[targetId].enabled = true;
    }

    btnElement.classList.add('active-whisper');
    btnElement.innerText = "TALKING...";
    
    socket.emit('audioActive', { targetId: targetId, active: true });
}

function stopWhisper(targetId, btnElement) {
    if (activeWhisperTarget !== targetId) return;
    activeWhisperTarget = null;

    // Mute their track again
    if (clonedTracks[targetId]) {
        clonedTracks[targetId].enabled = false;
    }

    btnElement.classList.remove('active-whisper');
    btnElement.innerText = "WHISPER";

    socket.emit('audioActive', { targetId: targetId, active: false });
}

// Light up a friend's name when they speak (either globally or whispering to you)
socket.on('peerAudioStatus', (data) => {
    const playerEl = document.getElementById(`friend-${data.senderId}`);
    if (playerEl) {
        if (data.active) {
            playerEl.classList.add('receiving-audio');
        } else {
            playerEl.classList.remove('receiving-audio');
        }
    }
});

// Bind Global Controls
pttBtn.addEventListener('mousedown', startTransmission);
pttBtn.addEventListener('mouseup', stopTransmission);
pttBtn.addEventListener('mouseleave', stopTransmission);
pttBtn.addEventListener('touchstart', (e) => { e.preventDefault(); startTransmission(); });
pttBtn.addEventListener('touchend', (e) => { e.preventDefault(); stopTransmission(); });