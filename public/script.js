const socket = io({ reconnectionAttempts: Infinity, reconnectionDelay: 1000 });
let misDatos = {};
let isMaster = false;
let roomPlayers = [];
let currentChallengeId = null;

function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(id).classList.add('active');
}

/* =========================================
   LOGIN & LOBBY
========================================= */
function joinPiramide() {
    const user = document.getElementById('username').value.trim();
    const room = document.getElementById('roomCode').value.toUpperCase().trim();
    if (user && room) {
        document.getElementById('btn-join').disabled = true;
        socket.emit('joinRoom', { username: user, roomCode: room });
    }
}

socket.on('errorMsg', (msg) => {
    document.getElementById('login-error').innerText = msg;
    document.getElementById('btn-join').disabled = false;
});

socket.on('serverMsg', (msg) => {
    const noti = document.getElementById('server-notification');
    noti.innerText = msg;
    noti.classList.remove('hidden');
    setTimeout(() => noti.classList.add('hidden'), 3000);
});

socket.on('joined', ({ roomCode, player, isHost }) => {
    misDatos = player;
    isMaster = isHost;
    showScreen('piramide-game');
    if (isMaster) document.getElementById('master-btn').classList.remove('hidden');
});

socket.on('updatePlayers', (players) => {
    roomPlayers = players;
    const list = document.getElementById('players-list');
    const select = document.getElementById('challenge-target');
    
    list.innerHTML = '';
    select.innerHTML = ''; // Limpiar select
    
    const yo = players.find(p => p.id === socket.id);
    if(yo) document.getElementById('mis-tragos').innerText = yo.drinks;

    players.forEach(p => {
        list.innerHTML += `<div class="player-tag">${p.name} 🍺 ${p.drinks}</div>`;
        if(p.id !== socket.id) {
            select.innerHTML += `<option value="${p.id}">${p.name}</option>`;
        }
    });
});

/* =========================================
   LA MESA (LA PIRÁMIDE)
========================================= */
function toggleMasterPanel() {
    document.getElementById('master-panel').classList.toggle('hidden');
}

function masterStartGame() {
    socket.emit('startGame', { roomCode: document.getElementById('roomCode').value.toUpperCase() });
    document.getElementById('btn-master-start').classList.add('hidden');
    document.getElementById('btn-master-card').classList.remove('hidden');
}

function masterNextCard() {
    socket.emit('nextPyramidCard', { roomCode: document.getElementById('roomCode').value.toUpperCase() });
}

socket.on('gameStarted', ({ pyramid, phase }) => {
    renderPyramid(pyramid);
});

socket.on('pyramidUpdated', (pyramid) => {
    renderPyramid(pyramid);
});

function renderPyramid(pyramid) {
    const mesa = document.getElementById('mesa-central');
    mesa.innerHTML = '';
    
    // Configuración de filas para 10 cartas: 4 filas (base 4, luego 3, 2, 1)
    const rowCounts = [1, 2, 3, 4];
    let cardIndex = 9; // Leemos la pirámide de atrás hacia adelante para la base

    rowCounts.forEach(count => {
        const rowDiv = document.createElement('div');
        rowDiv.className = 'pyramid-row';
        
        for(let i=0; i<count; i++) {
            const cardData = pyramid[cardIndex];
            const cDiv = document.createElement('div');
            
            if(cardData && cardData.revealed) {
                const colorClass = (cardData.palo === '♥' || cardData.palo === '♦') ? 'card-red' : 'card-black';
                cDiv.className = `card-board front ${colorClass}`;
                cDiv.innerHTML = `${cardData.valor}<br><span style="font-size:0.8em">${cardData.palo}</span>`;
            } else {
                cDiv.className = 'card-board back';
            }
            rowDiv.appendChild(cDiv);
            cardIndex--;
        }
        mesa.appendChild(rowDiv);
    });
}

socket.on('updateHand', (hand) => {
    const handDiv = document.getElementById('my-cards');
    handDiv.innerHTML = '';
    hand.forEach(card => {
        const colorClass = (card.palo === '♥' || card.palo === '♦') ? 'card-red' : 'card-black';
        const cDiv = document.createElement('div');
        cDiv.className = `card-board front ${colorClass}`;
        cDiv.style.transform = 'scale(0.9)'; // Más pequeñas en inventario
        cDiv.innerHTML = `${card.valor} ${card.palo}`;
        
        // Al tocar, puedes mandarla
        cDiv.onclick = () => {
            const targetId = document.getElementById('challenge-target').value; // Reusamos el select por ahora
            if(targetId && confirm(`¿Mandar este ${card.valor} a ese jugador?`)) {
                socket.emit('sendCard', { 
                    roomCode: document.getElementById('roomCode').value.toUpperCase(),
                    cardId: card.id,
                    targetId: targetId
                });
            }
        };
        handDiv.appendChild(cDiv);
    });
});

/* =========================================
   SISTEMA DE MINIJUEGOS Y RETOS
========================================= */
function togglePauseMenu() {
    document.getElementById('pause-modal').classList.toggle('hidden');
}

function sendChallenge(gameType) {
    const targetId = document.getElementById('challenge-target').value;
    if(!targetId) { alert("¡No hay víctimas en la sala!"); return; }
    
    socket.emit('sendChallenge', { 
        roomCode: document.getElementById('roomCode').value.toUpperCase(),
        targetId, 
        gameType 
    });
    togglePauseMenu(); // Cierra el menú
}

// Recibir Reto (Target)
socket.on('incomingChallenge', ({ challengeId, challengerName, gameType }) => {
    currentChallengeId = challengeId;
    const gameName = gameType === 'coinflip' ? 'Coinflip de la Muerte' : 'Piedra, Papel o Tijera';
    document.getElementById('incoming-challenge-text').innerHTML = `<b>${challengerName}</b> te ha retado a:<br><span style="color:#43d8c9; font-size:1.2rem;">${gameName}</span>`;
    
    const modal = document.getElementById('incoming-challenge-modal');
    modal.classList.remove('hidden');
    
    // Animación de barra
    const bar = document.getElementById('challenge-timer');
    bar.style.width = '100%';
    setTimeout(() => { bar.style.width = '0%'; }, 100);
});

socket.on('challengeExpired', (challengeId) => {
    if(currentChallengeId === challengeId) {
        document.getElementById('incoming-challenge-modal').classList.add('hidden');
        currentChallengeId = null;
    }
});

function acceptChallenge() {
    document.getElementById('incoming-challenge-modal').classList.add('hidden');
    socket.emit('acceptChallenge', { roomCode: document.getElementById('roomCode').value.toUpperCase(), challengeId: currentChallengeId });
}

function rejectChallenge() {
    document.getElementById('incoming-challenge-modal').classList.add('hidden');
    socket.emit('rejectChallenge', { roomCode: document.getElementById('roomCode').value.toUpperCase(), challengeId: currentChallengeId });
    currentChallengeId = null;
}

// Reto Aceptado - Iniciar selección
socket.on('challengeAccepted', (challenge) => {
    currentChallengeId = challenge.id;
    if (challenge.gameType === 'coinflip' && socket.id === challenge.target) {
        // Solo el target elige
        document.getElementById('coinflip-choice-modal').classList.remove('hidden');
    } else if (challenge.gameType === 'rps') {
        // Ambos eligen
        document.getElementById('rps-choice-modal').classList.remove('hidden');
    } else {
        socket.emit('serverMsg', 'El rival está eligiendo Cara o Cruz...');
    }
});

// Envíos de selección
function submitCoinflip(choice) {
    document.getElementById('coinflip-choice-modal').classList.add('hidden');
    socket.emit('coinflipChoice', { roomCode: document.getElementById('roomCode').value.toUpperCase(), challengeId: currentChallengeId, choice });
}

function submitRPS(choice) {
    document.getElementById('rps-choice-modal').classList.add('hidden');
    socket.emit('rpsChoice', { roomCode: document.getElementById('roomCode').value.toUpperCase(), challengeId: currentChallengeId, choice });
}

// Animación Moneda (Misticismo)
socket.on('playCoinAnimation', () => {
    document.getElementById('animation-modal').classList.remove('hidden');
});

// Resultado Final
socket.on('minigameResult', ({ game, resultStr, winner, loser, penalty }) => {
    document.getElementById('animation-modal').classList.add('hidden'); // Ocultar animación si estaba
    
    document.getElementById('result-title').innerText = `🏆 ${game} 🏆`;
    document.getElementById('result-str').innerText = resultStr;
    document.getElementById('result-winner').innerText = `${winner} GANA`;
    document.getElementById('result-loser').innerText = `${loser} se bebe ${penalty} tragos.`;
    
    document.getElementById('result-modal').classList.remove('hidden');
    currentChallengeId = null;
});

function closeResultModal() {
    document.getElementById('result-modal').classList.add('hidden');
}
