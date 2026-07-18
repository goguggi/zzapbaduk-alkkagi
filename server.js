/*
 * server.js — 실시간 알까기 멀티플레이어 서버
 * -------------------------------------------------
 * - Express 로 정적 파일 제공
 * - Socket.io 로 로비(방 목록/생성/입장), 빠른 매칭, 돌 배치, 턴 관리 담당
 * - 물리 시뮬레이션은 서버가 최종 계산하고 결과를 양쪽에 전송(치팅 방지 + 동기화)
 *
 * 게임 흐름:
 *   로비 → 방 생성(색 선택) / 방 입장 / 빠른 매칭
 *       → 돌 배치 단계(30초, 자기 진영에 돌 3개 자유 배치)
 *       → 대국(15초 턴제) → 결과 → 재대국 or 로비
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
const TURN_TIME = 15000;                              // 한 턴 제한시간 15초
const PLACE_TIME = AlkPhysics.CONFIG.PLACE_TIME * 1000; // 배치 제한시간 30초
const B = AlkPhysics.CONFIG.BOARD;
const R = AlkPhysics.CONFIG.RADIUS;

app.use(express.static(path.join(__dirname, 'public')));

// 상태 저장소
const waitingQueue = [];   // 빠른 매칭 대기열 (소켓 id)
const rooms = new Map();   // roomId -> room 상태
let roomSeq = 1;

/* ---------- 유틸 ---------- */

// 기본 돌 배치 (배치를 안 했거나 시간 초과 시 사용)
function defaultPositions(color) {
  const cols = [B * 0.3, B * 0.5, B * 0.7];
  const y = color === 'black' ? B * 0.8 : B * 0.2;
  return cols.map(x => ({ x: x, y: y }));
}

// 배치 좌표 검증: 3개, 자기 진영 안, 서로 겹치지 않음. 실패 시 null
function validatePlacement(color, positions) {
  if (!Array.isArray(positions) || positions.length !== 3) return null;
  const half = B / 2;
  // 자기 진영 범위 (검은돌: 아래쪽 절반 / 흰돌: 위쪽 절반)
  const yMin = color === 'black' ? half + R : R;
  const yMax = color === 'black' ? B - R : half - R;
  const out = [];
  for (const p of positions) {
    if (!p || typeof p.x !== 'number' || typeof p.y !== 'number') return null;
    if (!isFinite(p.x) || !isFinite(p.y)) return null;
    // 좌표를 진영 안으로 클램프
    const x = Math.min(B - R, Math.max(R, p.x));
    const y = Math.min(yMax, Math.max(yMin, p.y));
    out.push({ x: x, y: y });
  }
  // 서로 겹침 검사
  for (let i = 0; i < 3; i++) {
    for (let j = i + 1; j < 3; j++) {
      const d = Math.hypot(out[i].x - out[j].x, out[i].y - out[j].y);
      if (d < R * 2 + 1) return null;
    }
  }
  return out;
}

// 로비에 보여줄 공개 방 목록 (입장 대기 중인 방만)
function publicRooms() {
  const list = [];
  for (const room of rooms.values()) {
    if (room.state === 'waiting') {
      list.push({ id: room.id, name: room.name, hostColor: room.hostColorPref });
    }
  }
  return list;
}

function broadcastLobby() {
  io.emit('lobbyUpdate', { rooms: publicRooms() });
}

/* ---------- 게임 진행 ---------- */

// 배치 단계 시작
function startPlacement(room) {
  clearTimeout(room.timer);
  clearTimeout(room.placeTimer);
  room.state = 'placing';
  room.placement = { black: null, white: null };
  room.stones = [];
  room.over = false;
  const endsAt = Date.now() + PLACE_TIME;
  room.placeEndsAt = endsAt;

  for (const color of ['black', 'white']) {
    const sid = room.players[color];
    const sock = io.sockets.sockets.get(sid);
    if (sock) {
      sock.emit('placementStart', {
        roomId: room.id,
        color: color,
        endsAt: endsAt,
        seconds: PLACE_TIME / 1000,
        defaults: defaultPositions(color)
      });
    }
  }

  // 시간 초과 시 미배치 플레이어는 기본 배치로 강제 시작
  room.placeTimer = setTimeout(() => {
    if (room.state !== 'placing') return;
    if (!room.placement.black) room.placement.black = defaultPositions('black');
    if (!room.placement.white) room.placement.white = defaultPositions('white');
    startGame(room);
  }, PLACE_TIME + 500);
}

// 대국 시작 (양쪽 배치 완료 후)
function startGame(room) {
  clearTimeout(room.placeTimer);
  room.state = 'playing';
  room.stones = [];
  room.placement.black.forEach((p, i) => {
    room.stones.push({ id: 'b' + i, color: 'black', x: p.x, y: p.y, vx: 0, vy: 0, alive: true });
  });
  room.placement.white.forEach((p, i) => {
    room.stones.push({ id: 'w' + i, color: 'white', x: p.x, y: p.y, vx: 0, vy: 0, alive: true });
  });
  room.turn = 'black'; // 알까기 전통대로 검은돌 선공 (색은 방장이 선택/랜덤)
  startTurnTimer(room);
  io.to(room.id).emit('gameStart', {
    stones: room.stones,
    turn: room.turn,
    turnEndsAt: room.turnEndsAt,
    seconds: TURN_TIME / 1000
  });
}

// 턴 타이머 (제한시간 초과 시 턴 넘김)
function startTurnTimer(room) {
  clearTimeout(room.timer);
  room.turnEndsAt = Date.now() + TURN_TIME;
  room.timer = setTimeout(() => {
    if (room.state !== 'playing') return;
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
  if (blackAlive === 0 && whiteAlive === 0) return 'draw'; // 동시 전멸(이론상)
  if (blackAlive === 0) return 'white';
  if (whiteAlive === 0) return 'black';
  return null;
}

// 두 소켓을 하나의 방으로 묶기. hostPref: 방장(a)이 원하는 색
function pairIntoRoom(a, b, name, hostPref) {
  // 색 결정: 방장 선호 반영, random 이면 동전 던지기
  let hostColor = hostPref;
  if (hostColor !== 'black' && hostColor !== 'white') {
    hostColor = Math.random() < 0.5 ? 'black' : 'white';
  }
  const guestColor = hostColor === 'black' ? 'white' : 'black';

  const roomId = 'room_' + (roomSeq++);
  const room = {
    id: roomId,
    name: name,
    hostColorPref: hostPref,
    players: {},
    state: 'placing',
    placement: { black: null, white: null },
    stones: [],
    turn: null,
    timer: null,
    placeTimer: null,
    turnEndsAt: 0,
    placeEndsAt: 0,
    over: false
  };
  room.players[hostColor] = a.id;
  room.players[guestColor] = b.id;
  rooms.set(roomId, room);

  a.join(roomId); b.join(roomId);
  a.data.roomId = roomId; b.data.roomId = roomId;
  a.data.color = hostColor; b.data.color = guestColor;

  console.log('[대국 시작 준비]', roomId, name, '(', hostColor, ':', a.id, '/', guestColor, ':', b.id, ')');
  startPlacement(room);
  broadcastLobby();
  return room;
}

// 빠른 매칭: 대기열에서 두 명씩 짝지음 (색은 랜덤 → 선공 불공평 문제 해결)
function tryQuickMatch() {
  while (waitingQueue.length >= 2) {
    const aId = waitingQueue.shift();
    const bId = waitingQueue.shift();
    const a = io.sockets.sockets.get(aId);
    const b = io.sockets.sockets.get(bId);
    if (!a && !b) continue;
    if (!a) { waitingQueue.unshift(bId); continue; }
    if (!b) { waitingQueue.unshift(aId); continue; }
    pairIntoRoom(a, b, '빠른 매칭', 'random');
  }
}

// 방/대기열에서 소켓 제거 (나가기·접속 종료 공용)
function removeFromGame(socket, notifyOpponent) {
  const qi = waitingQueue.indexOf(socket.id);
  if (qi !== -1) waitingQueue.splice(qi, 1);

  const roomId = socket.data.roomId;
  if (roomId && rooms.has(roomId)) {
    const room = rooms.get(roomId);
    clearTimeout(room.timer);
    clearTimeout(room.placeTimer);
    if (notifyOpponent) socket.to(roomId).emit('opponentLeft');
    // 상대 소켓의 방 정보도 정리
    for (const color of ['black', 'white']) {
      const sid = room.players[color];
      const other = io.sockets.sockets.get(sid);
      if (other) {
        other.leave(roomId);
        other.data.roomId = null;
        other.data.color = null;
      }
    }
    rooms.delete(roomId);
    broadcastLobby();
  }
  socket.data.roomId = null;
  socket.data.color = null;
}

/* ---------- 소켓 이벤트 ---------- */

io.on('connection', (socket) => {
  console.log('[접속]', socket.id);
  // 접속하자마자 로비 정보 제공
  socket.emit('lobbyUpdate', { rooms: publicRooms() });

  // 로비 목록 요청
  socket.on('getLobby', () => {
    socket.emit('lobbyUpdate', { rooms: publicRooms() });
  });

  // 방 만들기 {name, color: 'black'|'white'|'random'}
  socket.on('createRoom', (data) => {
    if (socket.data.roomId) return;
    data = data || {};
    let name = String(data.name || '').trim().slice(0, 20);
    if (!name) name = '알까기 한 판';
    let color = data.color;
    if (color !== 'black' && color !== 'white') color = 'random';

    const roomId = 'room_' + (roomSeq++);
    const room = {
      id: roomId,
      name: name,
      hostColorPref: color,
      hostId: socket.id,
      players: {},
      state: 'waiting',
      placement: { black: null, white: null },
      stones: [],
      turn: null,
      timer: null,
      placeTimer: null,
      turnEndsAt: 0,
      placeEndsAt: 0,
      over: false
    };
    rooms.set(roomId, room);
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.emit('roomWaiting', { roomId: roomId, name: name, color: color });
    broadcastLobby();
    console.log('[방 생성]', roomId, name, '색 선호:', color);
  });

  // 방 입장 {roomId}
  socket.on('joinRoom', (data) => {
    if (socket.data.roomId) return;
    const room = rooms.get(data && data.roomId);
    if (!room || room.state !== 'waiting') {
      socket.emit('errorMsg', { message: '이미 시작되었거나 없는 방입니다.' });
      socket.emit('lobbyUpdate', { rooms: publicRooms() });
      return;
    }
    const host = io.sockets.sockets.get(room.hostId);
    if (!host) {
      rooms.delete(room.id);
      broadcastLobby();
      socket.emit('errorMsg', { message: '방장이 나간 방입니다.' });
      return;
    }
    // 대기 방 제거 후 정식 대국 방으로 전환
    host.leave(room.id);
    host.data.roomId = null;
    rooms.delete(room.id);
    pairIntoRoom(host, socket, room.name, room.hostColorPref);
  });

  // 빠른 매칭
  socket.on('findMatch', () => {
    if (waitingQueue.includes(socket.id) || socket.data.roomId) return;
    waitingQueue.push(socket.id);
    socket.emit('waiting');
    tryQuickMatch();
  });

  // 방/대기열 나가기 (로비로 복귀)
  socket.on('leaveRoom', () => {
    removeFromGame(socket, true);
    socket.emit('lobbyUpdate', { rooms: publicRooms() });
  });

  // 돌 배치 제출 {positions: [{x,y} x3]}
  socket.on('placeStones', (data) => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.state !== 'placing') return;
    const color = socket.data.color;
    if (room.placement[color]) return; // 이미 제출함

    const valid = validatePlacement(color, data && data.positions);
    room.placement[color] = valid || defaultPositions(color);
    if (!valid) {
      socket.emit('errorMsg', { message: '배치가 올바르지 않아 기본 배치가 적용되었습니다.' });
    }

    // 상대에게 "상대 배치 완료" 알림
    socket.to(room.id).emit('opponentPlaced');

    if (room.placement.black && room.placement.white) {
      startGame(room);
    }
  });

  // 돌 발사 {stoneId, vx, vy}
  socket.on('shot', (data) => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.state !== 'playing' || room.over) return;
    const myColor = socket.data.color;
    if (room.turn !== myColor) return;

    const stone = room.stones.find(s => s.id === (data && data.stoneId) && s.alive);
    if (!stone || stone.color !== myColor) return;
    if (typeof data.vx !== 'number' || typeof data.vy !== 'number') return;
    if (!isFinite(data.vx) || !isFinite(data.vy)) return;

    // 파워 상한 적용 (상한이 높아서 세게 치면 자기 돌도 날아감)
    const speed = Math.sqrt(data.vx * data.vx + data.vy * data.vy);
    let vx = data.vx, vy = data.vy;
    if (speed > AlkPhysics.CONFIG.MAX_SPEED) {
      const k = AlkPhysics.CONFIG.MAX_SPEED / speed;
      vx *= k; vy *= k;
    }
    stone.vx = vx;
    stone.vy = vy;

    // 서버가 권위적으로 끝까지 시뮬레이션
    AlkPhysics.settle(room.stones);
    room.stones.forEach(s => { s.vx = 0; s.vy = 0; });

    const winner = checkWinner(room.stones);
    room.turn = myColor === 'black' ? 'white' : 'black';

    if (winner) {
      room.over = true;
      room.state = 'over';
      clearTimeout(room.timer);
    } else {
      startTurnTimer(room);
    }

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

  // 재대국: 같은 방/같은 색으로 배치 단계부터 다시
  socket.on('rematch', () => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.state !== 'over') return;
    startPlacement(room);
  });

  socket.on('disconnect', () => {
    console.log('[접속 종료]', socket.id);
    removeFromGame(socket, true);
  });
});

server.listen(PORT, () => {
  console.log('짭바둑(알까기) 서버 실행 중 → http://localhost:' + PORT);
});
