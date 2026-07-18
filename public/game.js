/*
 * game.js — 클라이언트(브라우저) 로직
 * -------------------------------------------------
 * 화면 흐름: 로비 → (방 생성 대기 | 방 입장 | 빠른 매칭) → 돌 배치 → 대국 → 결과
 * - Canvas 렌더링 (게임판, 돌, 조준 화살표, 배치 하이라이트)
 * - 배치 모드: 내 돌을 내 진영 안에서 드래그로 이동
 * - 대국 모드: 드래그 앤 플릭(슬링샷), 세게 치면 내 돌도 판 밖으로!
 */
'use strict';

(function () {
  const socket = io();
  const CFG = AlkPhysics.CONFIG;
  const BOARD = CFG.BOARD;
  const R = CFG.RADIUS;
  const HALF = BOARD / 2;

  // DOM 참조
  const canvas = document.getElementById('board');
  const ctx = canvas.getContext('2d');
  const overlay = document.getElementById('overlay');
  const lobbyView = document.getElementById('lobbyView');
  const msgView = document.getElementById('msgView');
  const overlayTitle = document.getElementById('overlayTitle');
  const overlayMsg = document.getElementById('overlayMsg');
  const rematchBtn = document.getElementById('rematchBtn');
  const lobbyBtn = document.getElementById('lobbyBtn');
  const cancelBtn = document.getElementById('cancelBtn');
  const spinner = document.getElementById('spinner');
  const statusbar = document.getElementById('statusbar');
  const myColorEl = document.getElementById('myColor');
  const turnEl = document.getElementById('turnIndicator');
  const timerEl = document.getElementById('timer');
  const placebar = document.getElementById('placebar');
  const placeMsg = document.getElementById('placeMsg');
  const placeDoneBtn = document.getElementById('placeDoneBtn');
  const roomNameInput = document.getElementById('roomNameInput');
  const createRoomBtn = document.getElementById('createRoomBtn');
  const refreshBtn = document.getElementById('refreshBtn');
  const roomList = document.getElementById('roomList');
  const quickBtn = document.getElementById('quickBtn');

  // 게임 상태. mode: 'lobby' | 'waiting' | 'placing' | 'placed' | 'playing' | 'over'
  const state = {
    mode: 'lobby',
    stones: [],
    placeStones: [],   // 배치 단계에서 움직이는 내 돌 3개 [{x,y}]
    myColor: null,
    turn: null,
    animating: false
  };

  let drag = null;       // 대국: { stone, curX, curY } / 배치: { placeIdx, offX, offY }
  let timerInterval = null;
  let remaining = 0;

  const KOR_COLOR = { black: '검은돌 ⚫', white: '흰돌 ⚪' };
  const COLOR_PREF_LABEL = { black: '방장이 ⚫ 선택', white: '방장이 ⚪ 선택', random: '색 랜덤 🎲' };

  /* ---------- 좌표 변환 ---------- */
  function toLogical(e) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (BOARD / rect.width),
      y: (e.clientY - rect.top) * (BOARD / rect.height)
    };
  }

  // 내 진영 y 범위 (검은돌: 아래 절반 / 흰돌: 위 절반)
  function myZone() {
    return state.myColor === 'black'
      ? { yMin: HALF + R, yMax: BOARD - R }
      : { yMin: R, yMax: HALF - R };
  }

  /* ---------- 렌더링 ---------- */
  function draw() {
    ctx.clearRect(0, 0, BOARD, BOARD);

    // 바둑판 격자
    ctx.strokeStyle = 'rgba(60,40,10,0.35)';
    ctx.lineWidth = 1;
    const n = 6;
    const gap = BOARD / n;
    for (let i = 1; i < n; i++) {
      ctx.beginPath();
      ctx.moveTo(i * gap, gap * 0.5);
      ctx.lineTo(i * gap, BOARD - gap * 0.5);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(gap * 0.5, i * gap);
      ctx.lineTo(BOARD - gap * 0.5, i * gap);
      ctx.stroke();
    }

    if (state.mode === 'placing' || state.mode === 'placed') {
      drawPlacement();
    } else {
      drawStones();
    }

    if (drag && drag.stone) drawAimArrow();
  }

  // 배치 단계: 내 진영 하이라이트 + 내 돌만 표시
  function drawPlacement() {
    const zone = myZone();
    ctx.fillStyle = 'rgba(79,140,255,0.12)';
    ctx.fillRect(0, zone.yMin - R, BOARD, (zone.yMax + R) - (zone.yMin - R));
    // 중앙선
    ctx.strokeStyle = 'rgba(0,0,0,0.3)';
    ctx.setLineDash([10, 8]);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, HALF);
    ctx.lineTo(BOARD, HALF);
    ctx.stroke();
    ctx.setLineDash([]);

    state.placeStones.forEach((p, i) => {
      const grabbed = drag && drag.placeIdx === i;
      drawStone(p.x, p.y, state.myColor, grabbed);
    });
  }

  function drawStones() {
    const myTurn = isMyTurn();
    state.stones.forEach((s) => {
      if (!s.alive) return;
      if (state.mode === 'playing' && myTurn && s.color === state.myColor && !state.animating) {
        ctx.beginPath();
        ctx.arc(s.x, s.y, R + 5, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(79,140,255,0.55)';
        ctx.lineWidth = 3;
        ctx.stroke();
      }
      drawStone(s.x, s.y, s.color, false);
    });
  }

  function drawStone(x, y, color, highlight) {
    // 그림자
    ctx.beginPath();
    ctx.arc(x + 2, y + 3, R, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.fill();
    // 본체
    const grad = ctx.createRadialGradient(x - R * 0.35, y - R * 0.35, R * 0.2, x, y, R);
    if (color === 'black') {
      grad.addColorStop(0, '#4a4f57');
      grad.addColorStop(1, '#111318');
    } else {
      grad.addColorStop(0, '#ffffff');
      grad.addColorStop(1, '#c9cdd4');
    }
    ctx.beginPath();
    ctx.arc(x, y, R, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();
    if (highlight) {
      ctx.beginPath();
      ctx.arc(x, y, R + 4, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(242,201,76,0.9)';
      ctx.lineWidth = 3;
      ctx.stroke();
    }
  }

  function drawAimArrow() {
    const s = drag.stone;
    let dx = s.x - drag.curX;
    let dy = s.y - drag.curY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 2) return;

    const vel = AlkPhysics.vectorToVelocity(dx, dy);
    const speed = Math.sqrt(vel.vx * vel.vx + vel.vy * vel.vy);
    const maxed = speed >= CFG.MAX_SPEED - 0.001;
    const power = Math.min(1, speed / CFG.MAX_SPEED);

    const arrowLen = 40 + power * 150;
    const ux = dx / dist, uy = dy / dist;
    const ex = s.x + ux * arrowLen;
    const ey = s.y + uy * arrowLen;

    ctx.save();
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    // 당긴 방향 가이드
    ctx.setLineDash([6, 8]);
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(drag.curX, drag.curY);
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.stroke();
    ctx.setLineDash([]);
    // 파워에 따라 색 변화 (강할수록 위험!)
    const col = maxed ? '#ff5b6e' : (power > 0.65 ? '#f2c94c' : '#4f8cff');
    ctx.strokeStyle = col;
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    const ah = 16;
    const ang = Math.atan2(uy, ux);
    ctx.beginPath();
    ctx.moveTo(ex, ey);
    ctx.lineTo(ex - ah * Math.cos(ang - 0.4), ey - ah * Math.sin(ang - 0.4));
    ctx.lineTo(ex - ah * Math.cos(ang + 0.4), ey - ah * Math.sin(ang + 0.4));
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  /* ---------- 입력 ---------- */
  function isMyTurn() { return state.turn === state.myColor; }

  function onDown(e) {
    const p = toLogical(e);

    // 배치 모드: 내 돌 집기
    if (state.mode === 'placing') {
      for (let i = 0; i < state.placeStones.length; i++) {
        const s = state.placeStones[i];
        if (Math.hypot(s.x - p.x, s.y - p.y) <= R + 8) {
          drag = { placeIdx: i, offX: s.x - p.x, offY: s.y - p.y };
          e.preventDefault();
          draw();
          return;
        }
      }
      return;
    }

    // 대국 모드: 슬링샷 시작
    if (state.mode !== 'playing' || state.animating || !isMyTurn()) return;
    const hit = state.stones.find(s =>
      s.alive && s.color === state.myColor &&
      Math.hypot(s.x - p.x, s.y - p.y) <= R + 6
    );
    if (!hit) return;
    e.preventDefault();
    drag = { stone: hit, curX: p.x, curY: p.y };
    draw();
  }

  function onMove(e) {
    if (!drag) return;
    e.preventDefault();
    const p = toLogical(e);

    // 배치 모드: 돌 이동 (내 진영으로 클램프 + 겹침 방지)
    if (drag.placeIdx !== undefined) {
      const zone = myZone();
      let nx = Math.min(BOARD - R, Math.max(R, p.x + drag.offX));
      let ny = Math.min(zone.yMax, Math.max(zone.yMin, p.y + drag.offY));
      // 다른 내 돌과 겹치면 이동 보류
      const ok = state.placeStones.every((s, i) =>
        i === drag.placeIdx || Math.hypot(s.x - nx, s.y - ny) >= R * 2 + 2
      );
      if (ok) {
        state.placeStones[drag.placeIdx].x = nx;
        state.placeStones[drag.placeIdx].y = ny;
      }
      draw();
      return;
    }

    // 대국 모드: 조준 갱신
    drag.curX = p.x;
    drag.curY = p.y;
    draw();
  }

  function onUp(e) {
    if (!drag) return;
    e.preventDefault();

    // 배치 모드: 그냥 내려놓기
    if (drag.placeIdx !== undefined) {
      drag = null;
      draw();
      return;
    }

    // 대국 모드: 발사
    const s = drag.stone;
    const dx = s.x - drag.curX;
    const dy = s.y - drag.curY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const stoneId = s.id;
    drag = null;
    if (dist < 8) { draw(); return; }

    const vel = AlkPhysics.vectorToVelocity(dx, dy);
    socket.emit('shot', { stoneId: stoneId, vx: vel.vx, vy: vel.vy });
    state.animating = true;
    draw();
  }

  canvas.addEventListener('mousedown', onDown);
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  canvas.addEventListener('touchstart', (e) => onDown(e.touches[0]), { passive: false });
  window.addEventListener('touchmove', (e) => { if (drag) onMove(e.touches[0]); }, { passive: false });
  window.addEventListener('touchend', (e) => onUp(e.changedTouches[0]), { passive: false });

  /* ---------- 발사 애니메이션 ---------- */
  function animateShot(preStones, stoneId, vx, vy, finalStones, onDone) {
    const sim = preStones.map(s => Object.assign({}, s));
    const shooter = sim.find(s => s.id === stoneId);
    if (shooter) { shooter.vx = vx; shooter.vy = vy; }
    state.animating = true;

    function frame() {
      const moving = AlkPhysics.step(sim);
      state.stones = sim.map(s => Object.assign({}, s));
      draw();
      if (moving) {
        requestAnimationFrame(frame);
      } else {
        state.stones = finalStones;
        state.animating = false;
        draw();
        onDone();
      }
    }
    requestAnimationFrame(frame);
  }

  /* ---------- 타이머 ---------- */
  function startTimer(seconds) {
    stopTimer();
    remaining = seconds;
    updateTimerUI();
    timerInterval = setInterval(() => {
      remaining -= 1;
      if (remaining < 0) remaining = 0;
      updateTimerUI();
      if (remaining <= 0) stopTimer();
    }, 1000);
  }
  function stopTimer() {
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  }
  function updateTimerUI() {
    timerEl.textContent = remaining;
    timerEl.classList.toggle('urgent', remaining <= 5);
  }

  /* ---------- UI 전환 ---------- */
  function updateStatus() {
    myColorEl.textContent = KOR_COLOR[state.myColor] || '-';
    if (state.mode === 'placing' || state.mode === 'placed') {
      turnEl.textContent = '배치 중';
      turnEl.classList.remove('turn-mine', 'turn-theirs');
    } else if (state.turn) {
      const mine = isMyTurn();
      turnEl.textContent = mine ? '내 차례!' : '상대 차례';
      turnEl.classList.toggle('turn-mine', mine);
      turnEl.classList.toggle('turn-theirs', !mine);
    }
  }

  function showLobby() {
    state.mode = 'lobby';
    stopTimer();
    statusbar.classList.add('hidden');
    placebar.classList.add('hidden');
    lobbyView.classList.remove('hidden');
    msgView.classList.add('hidden');
    overlay.classList.remove('hidden');
    socket.emit('getLobby');
  }

  function showMsg(title, msg, opts) {
    opts = opts || {};
    lobbyView.classList.add('hidden');
    msgView.classList.remove('hidden');
    overlay.classList.remove('hidden');
    overlayTitle.textContent = title;
    overlayMsg.textContent = msg;
    rematchBtn.classList.toggle('hidden', !opts.rematch);
    lobbyBtn.classList.toggle('hidden', !opts.lobby);
    cancelBtn.classList.toggle('hidden', !opts.cancel);
    spinner.classList.toggle('hidden', !opts.spinner);
  }

  function hideOverlay() { overlay.classList.add('hidden'); }

  function renderRoomList(roomsArr) {
    roomList.innerHTML = '';
    if (!roomsArr || roomsArr.length === 0) {
      const li = document.createElement('li');
      li.className = 'room-empty';
      li.textContent = '아직 열린 방이 없어요.';
      roomList.appendChild(li);
      return;
    }
    roomsArr.forEach((r) => {
      const li = document.createElement('li');
      const info = document.createElement('div');
      const nameEl = document.createElement('div');
      nameEl.className = 'room-name';
      nameEl.textContent = r.name;
      const colorEl = document.createElement('div');
      colorEl.className = 'room-color';
      colorEl.textContent = COLOR_PREF_LABEL[r.hostColor] || '';
      info.appendChild(nameEl);
      info.appendChild(colorEl);
      const joinBtn = document.createElement('button');
      joinBtn.className = 'btn tiny';
      joinBtn.textContent = '참가';
      joinBtn.addEventListener('click', () => {
        socket.emit('joinRoom', { roomId: r.id });
      });
      li.appendChild(info);
      li.appendChild(joinBtn);
      roomList.appendChild(li);
    });
  }

  /* ---------- 버튼 ---------- */
  createRoomBtn.addEventListener('click', () => {
    const name = roomNameInput.value.trim();
    const colorEl = document.querySelector('input[name="colorPick"]:checked');
    socket.emit('createRoom', { name: name, color: colorEl ? colorEl.value : 'random' });
  });
  refreshBtn.addEventListener('click', () => socket.emit('getLobby'));
  quickBtn.addEventListener('click', () => {
    socket.emit('findMatch');
    showMsg('상대를 찾는 중...', '빠른 매칭 대기 중입니다. 색은 랜덤으로 정해져요.', { spinner: true, cancel: true });
  });
  cancelBtn.addEventListener('click', () => {
    socket.emit('leaveRoom');
    showLobby();
  });
  lobbyBtn.addEventListener('click', () => {
    socket.emit('leaveRoom');
    showLobby();
  });
  rematchBtn.addEventListener('click', () => {
    socket.emit('rematch');
    showMsg('재대국 준비 중...', '상대의 응답을 기다립니다.', { spinner: true, lobby: true });
  });
  placeDoneBtn.addEventListener('click', () => {
    if (state.mode !== 'placing') return;
    state.mode = 'placed';
    drag = null;
    socket.emit('placeStones', { positions: state.placeStones });
    placeMsg.textContent = '배치 완료! 상대를 기다리는 중...';
    placeDoneBtn.classList.add('hidden');
    updateStatus();
    draw();
  });

  /* ---------- 소켓 이벤트 ---------- */
  socket.on('lobbyUpdate', (data) => {
    if (state.mode === 'lobby') renderRoomList(data.rooms);
  });

  socket.on('roomWaiting', (data) => {
    state.mode = 'waiting';
    showMsg('⏳ 상대 기다리는 중', '방 「' + data.name + '」 을 만들었어요. 누군가 들어오면 바로 시작됩니다!', { spinner: true, cancel: true });
  });

  socket.on('waiting', () => {
    state.mode = 'waiting';
    showMsg('상대를 찾는 중...', '빠른 매칭 대기 중입니다. 색은 랜덤으로 정해져요.', { spinner: true, cancel: true });
  });

  // 돌 배치 단계 시작
  socket.on('placementStart', (data) => {
    state.mode = 'placing';
    state.myColor = data.color;
    state.turn = null;
    state.animating = false;
    state.stones = [];
    state.placeStones = data.defaults.map(p => ({ x: p.x, y: p.y }));
    drag = null;

    hideOverlay();
    statusbar.classList.remove('hidden');
    placebar.classList.remove('hidden');
    placeDoneBtn.classList.remove('hidden');
    placeMsg.textContent = '파란 영역(내 진영)에 돌 3개를 드래그로 배치하세요!';
    updateStatus();
    startTimer(data.seconds);
    draw();
  });

  socket.on('opponentPlaced', () => {
    if (state.mode === 'placing') {
      placeMsg.textContent = '상대는 배치를 마쳤어요! 서두르세요 😎';
    }
  });

  // 대국 시작
  socket.on('gameStart', (data) => {
    state.mode = 'playing';
    state.stones = data.stones;
    state.turn = data.turn;
    state.animating = false;
    drag = null;
    placebar.classList.add('hidden');
    hideOverlay();
    updateStatus();
    startTimer(data.seconds || 15);
    draw();
  });

  socket.on('shotResult', (data) => {
    stopTimer();
    const pre = state.stones.map(s => Object.assign({}, s));
    animateShot(pre, data.stoneId, data.vx, data.vy, data.stones, () => {
      state.turn = data.turn;
      updateStatus();
      if (data.winner) {
        endGame(data.winner);
      } else {
        startTimer(15);
      }
    });
  });

  socket.on('turnTimeout', (data) => {
    state.turn = data.turn;
    updateStatus();
    startTimer(15);
    draw();
  });

  socket.on('opponentLeft', () => {
    stopTimer();
    if (state.mode === 'lobby') return;
    state.mode = 'over';
    placebar.classList.add('hidden');
    showMsg('상대가 나갔어요 😥', '부전승입니다! 로비로 돌아가 새 대국을 시작하세요.', { lobby: true });
  });

  socket.on('errorMsg', (data) => {
    // 로비에서의 오류는 간단히 알림
    if (state.mode === 'lobby') alert(data.message);
  });

  socket.on('disconnect', () => {
    stopTimer();
    showMsg('연결 끊김 🔌', '서버와의 연결이 끊어졌습니다. 새로고침 해주세요.', {});
  });

  function endGame(winner) {
    stopTimer();
    state.mode = 'over';
    let title, msg;
    if (winner === 'draw') {
      title = '🤝 무승부!';
      msg = '두 돌이 동시에 모두 나갔어요. 다시 붙어봅시다!';
    } else if (winner === state.myColor) {
      title = '🎉 승리!';
      msg = '상대 돌을 모두 밀어냈습니다!';
    } else {
      title = '😢 패배';
      msg = '내 돌이 모두 판 밖으로 나갔어요.';
    }
    showMsg(title, msg, { rematch: true, lobby: true });
  }

  // 최초 화면: 로비
  showLobby();
  draw();
})();
