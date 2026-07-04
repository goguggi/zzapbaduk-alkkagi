/*
 * server.js — 실시간 알까기 멀티플레이어 서버
 * -------------------------------------------------
 * - Express 로 정적 파일 제공
 * - Socket.io 로 1:1 매칭, 턴 관리, 권위(authoritative) 물리 계산 담당
 * - 물리 시뮬레이션은 서버가 최종 계산하고 결과를 양쪽에 전송(치팅 방지 + 동기화)
 */
'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const AlkPhysics = require('./public/shared/physics');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const TURN_TIME = 15000; // 한 턴 제한시간 15초

app.use(express.static(path.join(__dirname, 'public')));

// 상태 저장소
const waitingQueue = [];   // 매칭 대기 중인 소켓 id
const rooms = new Map();   // roomId -> room 상태

// 초기 돌 배치 생성 (검은돌 3개: 아래쪽 / 흰돌 3개: 위쪽)
function createInitialStones() {
  const B = AlkPhysics.CONFIG.BOARD;
  const cols = [B * 0.3, B * 0.5, B * 0.7];
  const stones = [];
  cols.forEach((x, i) => {
    stones.push({ id: 'b' + i, color: 'black', x: x, y: B * 0.8, vx: 0, vy: 0, alive: true });
  });
  cols.forEach((x, i) => {
    stones.push({ id: 'w' + i, color: 'white', x: x, y: B * 0.2, vx: 0, vy: 0, alive: true });
  });
  return stones;
}

// 방의 턴 타이머 시작 (제한시간 초과 시 턴 넘김)
function startTurnTimer(room) {
  clearTimeout(room.timer);
  room.turnEndsAt = Date.now() + TURN_TIME;
  room.timer = setTimeout(() => {
    // 시간 초과: 상대에게 턴을 넘긴다
    room.turn = room.turn === 'black' ? 'white' : 'black';
    startTurnTimer(room);
    io.to(room.id).emit('turnTimeout', {
      turn: room.turn,
      turnEndsAt: room.turnEndsAt
    });
  }, TURN_TIME);
}

// 승패 판정: 한 색의 살아있는 돌이 0개면 상대 승
function checkWinner(stones) {
  const blackAlive = stones.filter(s => s.color === 'black' && s.alive).length;
  const whiteAlive = stones.filter(s => s.color === 'white' && s.alive).length;
  if (blackAlive === 0) return 'white';
  if (whiteAlive === 0) return 'black';
  return null;
}

// 두 명이 모이면 방 생성
function tryMatch() {
  while (waitingQueue.length >= 2) {
    const aId = waitingQueue.shift();
    const bId = waitingQueue.shift();
    const a = io.sockets.sockets.get(aId);
    const b = io.sockets.sockets.get(bId);
    // 매칭 도중 나간 사람이 있으면 남은 사람 재대기
    if (!a && !b) continue;
    if (!a) { waitingQueue.unshift(bId); continue; }
    if (!b) { waitingQueue.unshift(aId); continue; }

    const roomId = 'room_' + aId.slice(0, 4) + bId.slice(0, 4);
    const room = {
      id: roomId,
      players: { black: aId, white: bId }, // 먼저 온 사람이 검은돌(선공)
      stones: createInitialStones(),
      turn: 'black',
      timer: null,
      turnEndsAt: 0,
      over: false
    };
    rooms.set(roomId, room);
    a.join(roomId);
    b.join(roomId);
    a.data.roomId = roomId;
    b.data.roomId = roomId;
    a.data.color = 'black';
    b.data.color = 'white';

    startTurnTimer(room);

    a.emit('matchFound', {
      roomId, color: 'black', stones: room.stones,
      turn: room.turn, turnEndsAt: room.turnEndsAt
    });
    b.emit('matchFound', {
      roomId, color: 'white', stones: room.stones,
      turn: room.turn, turnEndsAt: room.turnEndsAt
    });
    console.log('[매칭 성공]', roomId, '(검은돌:', aId, '/ 흰돌:', bId, ')');
  }
}

io.on('connection', (socket) => {
  console.log('[접속]', socket.id);

  // 매칭 요청
  socket.on('findMatch', () => {
    if (waitingQueue.includes(socket.id) || socket.data.roomId) return;
    waitingQueue.push(socket.id);
    socket.emit('waiting');
    console.log('[대기열 추가]', socket.id, '| 대기 인원:', waitingQueue.length);
    tryMatch();
  });

  // 돌 발사(shot). {stoneId, vx, vy}
  socket.on('shot', (data) => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.over) return;
    const myColor = socket.data.color;
    if (room.turn !== myColor) return; // 내 턴이 아니면 무시

    const stone = room.stones.find(s => s.id === data.stoneId && s.alive);
    if (!stone || stone.color !== myColor) return; // 내 돌이 아니면 무시

    // 파워 상한 적용 후 발사 속도 설정
    const speed = Math.sqrt(data.vx * data.vx + data.vy * data.vy);
    let vx = data.vx, vy = data.vy;
    if (speed > AlkPhysics.CONFIG.MAX_SPEED) {
      const k = AlkPhysics.CONFIG.MAX_SPEED / speed;
      vx *= k; vy *= k;
    }
    stone.vx = vx;
    stone.vy = vy;

    // 서버가 권위적으로 끝까지 시뮬레이션 (탈락한 돌은 alive=false)
    AlkPhysics.settle(room.stones);
    // 탈락한 돌 정리
    room.stones.forEach(s => { s.vx = 0; s.vy = 0; });

    const winner = checkWinner(room.stones);
    // 턴 넘기기
    room.turn = myColor === 'black' ? 'white' : 'black';

    if (winner) {
      room.over = true;
      clearTimeout(room.timer);
    } else {
      startTurnTimer(room);
    }

    // 발사 정보 + 최종 상태를 양쪽에 전송 (클라이언트는 동일 물리로 애니메이션 후 상태 동기화)
    io.to(room.id).emit('shotResult', {
      stoneId: data.stoneId,
      vx: vx,
      vy: vy,
      stones: room.stones,
      turn: room.turn,
      turnEndsAt: room.turnEndsAt,
      winner: winner
    });
  });

  // 재대국 요청
  socket.on('rematch', () => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return;
    room.stones = createInitialStones();
    room.turn = 'black';
    room.over = false;
    startTurnTimer(room);
    io.to(room.id).emit('matchFound', {
      roomId: room.id,
      color: null, // 색은 유지되므로 클라이언트가 기존 색 사용
      stones: room.stones,
      turn: room.turn,
      turnEndsAt: room.turnEndsAt,
      rematch: true
    });
  });

  socket.on('disconnect', () => {
    console.log('[접속 종료]', socket.id);
    // 대기열에서 제거
    const qi = waitingQueue.indexOf(socket.id);
    if (qi !== -1) waitingQueue.splice(qi, 1);

    // 방에 있었다면 상대에게 알림 후 방 정리
    const roomId = socket.data.roomId;
    if (roomId && rooms.has(roomId)) {
      const room = rooms.get(roomId);
      clearTimeout(room.timer);
      socket.to(roomId).emit('opponentLeft');
      rooms.delete(roomId);
    }
  });
});

server.listen(PORT, () => {
  console.log('짭바둑(알까기) 서버 실행 중 → http://localhost:' + PORT);
});
