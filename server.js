const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    connectionStateRecovery: {
        maxDisconnectionDuration: 2 * 60 * 1000 // 2 min reconexión
    }
});

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};

// Helpers para la baraja
const palos = ['♠', '♥', '♣', '♦'];
const valores = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

function generarBaraja() {
    let baraja = [];
    for (let p of palos) {
        for (let v of valores) {
            baraja.push({ valor: v, palo: p, id: Math.random().toString(36).substr(2, 9) });
        }
    }
    return baraja.sort(() => Math.random() - 0.5);
}

io.on('connection', (socket) => {
    socket.on('joinRoom', ({ username, roomCode }) => {
        if (!rooms[roomCode]) {
            rooms[roomCode] = { 
                host: socket.id, 
                players: [], 
                phase: 0, 
                pyramid: [],
                activeChallenges: {},
                gameStarted: false
            };
        }
        
        const isDuplicate = rooms[roomCode].players.some(p => p.name.toLowerCase() === username.toLowerCase());
        if (isDuplicate) {
            socket.emit('errorMsg', 'Ese apodo ya está en uso en esta sala. Elige otro.');
            return;
        }

        socket.join(roomCode);
        const isHost = rooms[roomCode].players.length === 0;
        if (isHost) rooms[roomCode].host = socket.id;

        const player = { id: socket.id, name: username, isHost, drinks: 0, hand: [] };
        rooms[roomCode].players.push(player);

        socket.emit('joined', { roomCode, player, isHost });
        io.to(roomCode).emit('updatePlayers', rooms[roomCode].players);
        
        if (rooms[roomCode].gameStarted) {
            socket.emit('gameStarted', { pyramid: rooms[roomCode].pyramid, phase: rooms[roomCode].phase });
            socket.emit('updateHand', player.hand);
        }
    });

    // MASTER: Iniciar Partida y Repartir
    socket.on('startGame', ({ roomCode }) => {
        const room = rooms[roomCode];
        if (room && room.host === socket.id) {
            room.gameStarted = true;
            room.phase = 1;
            let mazo = generarBaraja();
            
            // Pirámide de 4 filas (10 cartas)
            room.pyramid = [];
            for(let i=0; i<10; i++) {
                let c = mazo.pop();
                c.revealed = false;
                room.pyramid.push(c);
            }

            // Repartir el resto
            const numPlayers = room.players.length;
            let pIndex = 0;
            while(mazo.length > 0) {
                room.players[pIndex].hand.push(mazo.pop());
                pIndex = (pIndex + 1) % numPlayers;
            }

            io.to(roomCode).emit('gameStarted', { pyramid: room.pyramid, phase: room.phase });
            room.players.forEach(p => {
                io.to(p.id).emit('updateHand', p.hand);
            });
        }
    });

    // MASTER: Destapar siguiente carta
    socket.on('nextPyramidCard', ({ roomCode }) => {
        const room = rooms[roomCode];
        if (room && room.host === socket.id) {
            let cardFlipped = false;
            for(let i=room.pyramid.length-1; i>=0; i--) {
                if(!room.pyramid[i].revealed) {
                    room.pyramid[i].revealed = true;
                    cardFlipped = true;
                    break;
                }
            }
            if(cardFlipped) {
                io.to(roomCode).emit('pyramidUpdated', room.pyramid);
            } else {
                room.phase = 2; // Pasar a subastas
                io.to(roomCode).emit('phaseChanged', room.phase);
            }
        }
    });

    // JUGADORES: Enviar carta a otro
    socket.on('sendCard', ({ roomCode, cardId, targetId }) => {
        const room = rooms[roomCode];
        if(room) {
            let sender = room.players.find(p => p.id === socket.id);
            let target = room.players.find(p => p.id === targetId);
            if(sender && target) {
                const cardIndex = sender.hand.findIndex(c => c.id === cardId);
                if(cardIndex !== -1) {
                    const card = sender.hand.splice(cardIndex, 1)[0];
                    target.hand.push(card);
                    io.to(sender.id).emit('updateHand', sender.hand);
                    io.to(target.id).emit('updateHand', target.hand);
                    io.to(roomCode).emit('serverMsg', `¡${sender.name} le ha mandado una carta a ${target.name}!`);
                }
            }
        }
    });

    // ==========================================
    // SISTEMA DE MINIJUEGOS Y RETOS
    // ==========================================
    socket.on('sendChallenge', ({ roomCode, targetId, gameType }) => {
        const room = rooms[roomCode];
        if(!room) return;
        
        // Comprobar si ya están en reto
        const isBusy = Object.values(room.activeChallenges).some(c => c.target === targetId || c.challenger === targetId);
        if (isBusy) {
            socket.emit('errorMsg', 'Ese jugador ya está en un reto activo.');
            return;
        }

        const challengeId = Math.random().toString(36).substr(2, 9);
        const challengerName = room.players.find(p => p.id === socket.id).name;
        
        room.activeChallenges[challengeId] = {
            id: challengeId,
            challenger: socket.id,
            target: targetId,
            gameType: gameType,
            status: 'pending'
        };

        io.to(targetId).emit('incomingChallenge', { challengeId, challengerName, gameType });
        
        // Timeout de 15s automático
        setTimeout(() => {
            if(room.activeChallenges[challengeId] && room.activeChallenges[challengeId].status === 'pending') {
                delete room.activeChallenges[challengeId];
                io.to(socket.id).emit('serverMsg', 'El reto ha caducado (15s).');
                io.to(targetId).emit('challengeExpired', challengeId);
            }
        }, 15000);
    });

    socket.on('acceptChallenge', ({ roomCode, challengeId }) => {
        const room = rooms[roomCode];
        if(room && room.activeChallenges[challengeId]) {
            const challenge = room.activeChallenges[challengeId];
            challenge.status = 'accepted';
            io.to(challenge.challenger).emit('challengeAccepted', challenge);
            io.to(challenge.target).emit('challengeAccepted', challenge);
        }
    });

    socket.on('rejectChallenge', ({ roomCode, challengeId }) => {
        const room = rooms[roomCode];
        if(room && room.activeChallenges[challengeId]) {
            io.to(room.activeChallenges[challengeId].challenger).emit('serverMsg', 'Reto rechazado o cancelado.');
            delete room.activeChallenges[challengeId];
        }
    });

    // Coinflip - Target elige cara
    socket.on('coinflipChoice', ({ roomCode, challengeId, choice }) => {
        const room = rooms[roomCode];
        if(room && room.activeChallenges[challengeId]) {
            const c = room.activeChallenges[challengeId];
            
            // Animación para ambos
            io.to(c.challenger).emit('playCoinAnimation');
            io.to(c.target).emit('playCoinAnimation');
            
            setTimeout(() => {
                const result = Math.random() > 0.5 ? 'Cara' : 'Cruz';
                const targetWon = result === choice;
                
                const winnerId = targetWon ? c.target : c.challenger;
                const loserId = targetWon ? c.challenger : c.target;
                
                const winnerName = room.players.find(p=>p.id===winnerId).name;
                const loserData = room.players.find(p=>p.id===loserId);
                loserData.drinks += 2; // Castigo
                
                io.to(roomCode).emit('updatePlayers', room.players);
                io.to(c.challenger).emit('minigameResult', { game: 'Coinflip', resultStr: result, winner: winnerName, loser: loserData.name, penalty: 2 });
                io.to(c.target).emit('minigameResult', { game: 'Coinflip', resultStr: result, winner: winnerName, loser: loserData.name, penalty: 2 });
                
                delete room.activeChallenges[challengeId];
            }, 3000); // 3 segundos de moneda girando
        }
    });

    // RPS - Ambos eligen
    socket.on('rpsChoice', ({ roomCode, challengeId, choice }) => {
        const room = rooms[roomCode];
        if(room && room.activeChallenges[challengeId]) {
            const c = room.activeChallenges[challengeId];
            if(socket.id === c.challenger) c.challengerChoice = choice;
            if(socket.id === c.target) c.targetChoice = choice;

            if(c.challengerChoice && c.targetChoice) {
                // Resolver
                const cName = room.players.find(p=>p.id===c.challenger).name;
                const tName = room.players.find(p=>p.id===c.target).name;
                let winner = null, loser = null, loserId = null;

                if(c.challengerChoice === c.targetChoice) {
                    // Empate
                    io.to(c.challenger).emit('minigameResult', { game: 'Piedra, Papel o Tijera', resultStr: '¡EMPATE!', winner: 'NADIE', loser: 'Ambos', penalty: 0 });
                    io.to(c.target).emit('minigameResult', { game: 'Piedra, Papel o Tijera', resultStr: '¡EMPATE!', winner: 'NADIE', loser: 'Ambos', penalty: 0 });
                } else {
                    const ch = c.challengerChoice;
                    const ta = c.targetChoice;
                    const p1Wins = (ch==='Piedra'&&ta==='Tijera') || (ch==='Papel'&&ta==='Piedra') || (ch==='Tijera'&&ta==='Papel');
                    
                    if(p1Wins) { winner = cName; loser = tName; loserId = c.target; }
                    else { winner = tName; loser = cName; loserId = c.challenger; }

                    const lData = room.players.find(p=>p.id===loserId);
                    lData.drinks += 3;
                    io.to(roomCode).emit('updatePlayers', room.players);
                    
                    io.to(c.challenger).emit('minigameResult', { game: 'Piedra, Papel o Tijera', resultStr: `${ch} vs ${ta}`, winner, loser, penalty: 3 });
                    io.to(c.target).emit('minigameResult', { game: 'Piedra, Papel o Tijera', resultStr: `${ch} vs ${ta}`, winner, loser, penalty: 3 });
                }
                delete room.activeChallenges[challengeId];
            } else {
                socket.emit('serverMsg', 'Esperando al rival...');
            }
        }
    });

    socket.on('disconnect', () => {
        // Lógica de limpieza (reducida por espacio)
        for (const code in rooms) {
            const r = rooms[code];
            const idx = r.players.findIndex(p => p.id === socket.id);
            if(idx !== -1) {
                r.players.splice(idx, 1);
                io.to(code).emit('updatePlayers', r.players);
                if (r.host === socket.id && r.players.length > 0) {
                    r.host = r.players[0].id;
                    io.to(r.host).emit('youAreHost');
                    io.to(code).emit('serverMsg', `👑 ${r.players[0].name} es el nuevo Máster.`);
                }
            }
        }
    });
});

server.listen(process.env.PORT || 3000, () => console.log('Servidor rodando...'));
