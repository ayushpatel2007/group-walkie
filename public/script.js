const socket = io();

const lobbyScreen = document.getElementById('lobby-screen');
const radioScreen = document.getElementById('radio-screen');
const usernameInput = document.getElementById('username-input');
const joinCodeInput = document.getElementById('join-code-input');
const pttBtn = document.getElementById('ptt-btn');
const pttText = document.getElementById('ptt-text');
const roomIdBanner = document.getElementById('room-id-banner');
const playerList = document.getElementById('player-list');
const audioContainer = document.getElementById('audio-container');

let localStream = null;
let currentRoomCode = null;
let isTransmitting = false;

const peers = {}; 
const clonedTracks = {}; 

const rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};

// --- NEW: SECURE MIC BEFORE JOINING ---

async function getMicrophone() {
    if (localStream) return true; 
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true, echoCancellation: true });
        return true;
    } catch (err) {
        alert("Microphone access is strictly required to use the walkie-talkie.");
        return false;
    }
}

// --- ROOM ACCESS ---

document.getElementById('create-btn').addEventListener('click', async () => {
    // Force mic check first
    const hasMic = await getMicrophone();
    if (!hasMic) return; 

    const name = usernameInput.value.trim() || 'Host';
    socket.emit('createRoom', name);
});

document.getElementById('join-btn').addEventListener('click', async () => {
    const code = joinCodeInput.value.trim().toUpperCase();
    const name = usernameInput.value.trim() || 'Friend';
    
    if (code.length === 4) {
        // Force mic check first
        const hasMic = await getMicrophone();
        if (!hasMic) return; 
        
        socket.emit('joinRoom', { code, name });
    }
});

socket.on('roomCreated', (code) => enterRoom(code));
socket.on('accessGranted', (code) => enterRoom(code));
socket.on('accessDenied', (msg) => alert(msg));

function enterRoom(code) {
    currentRoomCode = code;
    lobbyScreen.style.display = 'none';
    radioScreen.style.display = 'flex';
    roomIdBanner.innerText = `GROUP CODE: ${code}`;
    
    const myName = usernameInput.value.trim() || 'Me';
    addPlayerToUI('Me (You)', true, myName);
}

// --- NETWORK SIGNALING ---

socket.on('currentPlayers', (playersDictionary) => {
    for (const [id, realName] of Object.entries(playersDictionary)) {
        if (id !== socket.id) {
            addPlayerToUI(id, false, realName);
            createPeerConnection(id, true);
        }
    }
});

socket.on('newPlayerJoined', (data) => {
    addPlayerToUI(data.id, false, data.name);
    createPeerConnection(data.id, false);
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

function addPlayerToUI(id, isMe, realName) {
    const div = document.createElement('div');
    div.className = 'player-item';
    div.id = isMe ? 'friend-me' : `friend-${id}`;
    
    const colors = ['#34c759', '#007aff', '#ff9500', '#af52de', '#ff3b30'];
    const randomColor = colors[Math.floor(Math.random() * colors.length)];
    
    const displayName = isMe ? `${realName} (You)` : realName;
    const initial = realName.charAt(0).toUpperCase();
    
    let htmlContent = `
        <div style="display: flex; align-items: center; gap: 10px;">
            <div style="width: 24px; height: 24px; border-radius: 50%; background-color: ${randomColor}; display: flex; align-items: center; justify-content: center; font-size: 10px; font-weight: bold; color: white;">
                ${initial}
            </div>
            <span>${displayName}</span>
        </div>
        <div class="friend-row-right" id="right-col-${id}">
            <span class="indicator"></span>
        </div>
    `;
    div.innerHTML = htmlContent;
    playerList.appendChild(div);

    if (!isMe) {
        const rightCol = document.getElementById(`right-col-${id}`);
        const whisperBtn = document.createElement('button');
        whisperBtn.className = 'private-ptt-btn';
        whisperBtn.innerText = 'WHISPER';

        whisperBtn.addEventListener('mousedown', () => startWhisper(id, whisperBtn));
        whisperBtn.addEventListener('mouseup', () => stopWhisper(id, whisperBtn));
        whisperBtn.addEventListener('mouseleave', () => stopWhisper(id, whisperBtn));
        
        whisperBtn.addEventListener('touchstart', (e) => { e.preventDefault(); startWhisper(id, whisperBtn); });
        whisperBtn.addEventListener('touchend', (e) => { e.preventDefault(); stopWhisper(id, whisperBtn); });

        rightCol.insertBefore(whisperBtn, rightCol.firstChild);
    }
}

// --- PUSH TO TALK ---
let activeWhisperTarget = null;

function startTransmission() {
    if (!localStream || isTransmitting || activeWhisperTarget) return;
    isTransmitting = true;
    for (let id in clonedTracks) clonedTracks[id].enabled = true;

    pttBtn.classList.add('transmitting');
    pttText.innerText = "TRANSMITTING";
    document.getElementById('friend-me').classList.add('receiving-audio');
    socket.emit('audioActive', { targetId: 'all', active: true });
}

function stopTransmission() {
    if (!isTransmitting) return;
    isTransmitting = false;
    for (let id in clonedTracks) clonedTracks[id].enabled = false;

    pttBtn.classList.remove('transmitting');
    pttText.innerText = "HOLD TO SPEAK";
    document.getElementById('friend-me').classList.remove('receiving-audio');
    socket.emit('audioActive', { targetId: 'all', active: false });
}

function startWhisper(targetId, btnElement) {
    if (!localStream || isTransmitting || activeWhisperTarget) return;
    activeWhisperTarget = targetId;
    if (clonedTracks[targetId]) clonedTracks[targetId].enabled = true;

    btnElement.classList.add('active-whisper');
    btnElement.innerText = "TALKING...";
    socket.emit('audioActive', { targetId: targetId, active: true });
}

function stopWhisper(targetId, btnElement) {
    if (activeWhisperTarget !== targetId) return;
    activeWhisperTarget = null;
    if (clonedTracks[targetId]) clonedTracks[targetId].enabled = false;

    btnElement.classList.remove('active-whisper');
    btnElement.innerText = "WHISPER";
    socket.emit('audioActive', { targetId: targetId, active: false });
}

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

pttBtn.addEventListener('mousedown', startTransmission);
pttBtn.addEventListener('mouseup', stopTransmission);
pttBtn.addEventListener('mouseleave', stopTransmission);
pttBtn.addEventListener('touchstart', (e) => { e.preventDefault(); startTransmission(); });
pttBtn.addEventListener('touchend', (e) => { e.preventDefault(); stopTransmission(); });
