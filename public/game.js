/*
 * game.js — 클라이언트(브라우저) 로직
 * -------------------------------------------------
 * - Canvas 렌더링 (게임판, 돌, 조준 화살표)
 * - 드래그 앤 플릭 조작 (슬링샷 방식)
 * - Socket.io 로 서버와 통신, 서버 최종 상태에 동기화
 */
'use strict';

(function () {
  const socket = io();
  const CFG = AlkPhysics.CONFIG;
  const BOARD = CFG.BOARD;
  const R = CFG.RADIUS;

  // DOM 참조
  const canvas = document.getElementById('board');
  const ctx = canvas.getContext('2d');
  const overlay = document.getElementById('overlay');
  const overlayTitle = document.getElementById('overlayTitle');
  const overlayMsg = document.getElementById('overlayMsg');
  const findBtn = document.getElementById('findBtn');
  const rematchBtn = document.getElementById('rematchBtn');
  const spinner = document.getElementById('spinner');
  const statusbar = document.getElementById('statusbar');
  const myColorEl = document.getElementById('myColor');
  const turnEl = document.getElementById('turnIndicator');
  const timerEl = document.getElementById('timer');

  // 게임 상태
  const state = {
    stones: [],
    myColor: null,   // 'black' | 'white'
    turn: null,      // 'black' | 'white'
    over: false,
    animating: false,
    started: false
  };

  // 드래그 상태
  let drag = null; // { stone, curX, curY }

  // 타이머
  let timerInterval = null;
  let remaining = 15;

  const KOR_COLOR = { black: '검은돌 ⚫', white: '흰돌 ⚪' };

  /* ---------- 좌표 변환: 화면 픽셀 -> 논리 좌표(600 기준) ---------- */
  function toLogical(e) {
    const rect = canvas.getBoundingClientRect();
    const px = (e.clientX - rect.left) * (BOARD / rect.width);
    const py = (e.clientY - rect.top) * (BOARD / rect.height);
    return { x: px, y: py };
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

    // 돌 렌더링
    const myTurn = isMyTurn();
    state.stones.forEach((s) => {
      if (!s.alive) return;
      // 내 차례에 조작 가능한 내 돌은 은은하게 강조
      if (myTurn && s.color === state.myColor && !state.animating) {
        ctx.beginPath();
        ctx.arc(s.x, s.y, R + 5, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(79,140,255,0.55)';
        ctx.lineWidth = 3;
        ctx.stroke();
      }
      // 돌 그림자
      ctx.beginPath();
      ctx.arc(s.x + 2, s.y + 3, R, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,0,0,0.28)';
      ctx.fill();
      // 돌 본체 (그라데이션)
      const grad = ctx.createRadialGradient(
        s.x - R * 0.35, s.y - R * 0.35, R * 0.2,
        s.x, s.y, R
      );
      if (s.color === 'black') {
        grad.addColorStop(0, '#4a4f57');
        grad.addColorStop(1, '#111318');
      } else {
        grad.addColorStop(0, '#ffffff');
        grad.addColorStop(1, '#c9cdd4');
      }
      ctx.beginPath();
      ctx.arc(s.x, s.y, R, 0, Math.PI * 2);
      ctx.fillStyle = grad;
      ctx.fill();
    });

    // 조준 화살표
    if (drag) drawAimArrow();
  }

  function drawAimArrow() {
    const s = drag.stone;
    // 발사 방향 = (돌 중심 - 현재 포인터) : 슬링샷처럼 당긴 반대 방향
    let dx = s.x - drag.curX;
    let dy = s.y - drag.curY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 2) return;

    // 파워(속도) 계산 및 상한 여부
    const vel = AlkPhysics.vectorToVelocity(dx, dy);
    const speed = Math.sqrt(vel.vx * vel.vx + vel.vy * vel.vy);
    const maxed = speed >= CFG.MAX_SPEED - 0.001;
    const power = Math.min(1, speed / CFG.MAX_SPEED);

    // 화살표 길이(시각용): 파워에 비례
    const arrowLen = 40 + power * 150;
    const ux = dx / dist, uy = dy / dist;
    const ex = s.x + ux * arrowLen;
    const ey = s.y + uy * arrowLen;

    ctx.save();
    ctx.strokeStyle = maxed ? '#ff5b6e' : '#4f8cff';
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    // 당긴 방향(뒤쪽) 가이드 라인
    ctx.setLineDash([6, 8]);
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(drag.curX, drag.curY);
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.stroke();
    ctx.setLineDash([]);
    // 발사 화살표
    ctx.strokeStyle = maxed ? '#ff5b6e' : '#4f8cff';
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    // 화살촉
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

  /* ---------- 입력 (드래그 앤 플릭) ---------- */
  function canInteract() {
    return state.started && !state.over && !state.animating && isMyTurn();
  }
  function isMyTurn() {
    return state.turn === state.myColor;
  }

  function onDown(e) {
    if (!canInteract()) return;
    e.preventDefault();
    const p = toLogical(e);
    // 내 돌 중 포인터가 닿은 돌 선택
    const hit = state.stones.find(s =>
      s.alive && s.color === state.myColor &&
      Math.hypot(s.x - p.x, s.y - p.y) <= R + 6
    );
    if (!hit) return;
    drag = { stone: hit, curX: p.x, curY: p.y };
    draw();
  }

  function onMove(e) {
    if (!drag) return;
    e.preventDefault();
    const p = toLogical(e);
    drag.curX = p.x;
    drag.curY = p.y;
    draw();
  }

  function onUp(e) {
    if (!drag) return;
    e.preventDefault();
    const s = drag.stone;
    const dx = s.x - drag.curX;
    const dy = s.y - drag.curY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const stoneId = s.id;
    drag = null;

    if (dist < 8) { draw(); return; } // 너무 짧은 드래그는 무시

    const vel = AlkPhysics.vectorToVelocity(dx, dy);
    // 서버로 발사 전송 (실제 물리는 서버가 권위적으로 계산)
    socket.emit('shot', { stoneId: stoneId, vx: vel.vx, vy: vel.vy });
    // 발사 순간 조작 잠금 (서버 shotResult 대기)
    state.animating = true;
    draw();
  }

  canvas.addEventListener('mousedown', onDown);
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  canvas.addEventListener('touchstart', (e) => onDown(e.touches[0]), { passive: false });
  window.addEventListener('touchmove', (e) => { if (drag) onMove(e.touches[0]); }, { passive: false });
  window.addEventListener('touchend', (e) => onUp(e.changedTouches[0]), { passive: false });

  /* ---------- 발사 애니메이션 (동일 물리로 재생 후 서버 상태에 동기화) ---------- */
  function animateShot(preStones, stoneId, vx, vy, finalStones, onDone) {
    // 애니메이션용 사본 만들기
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
        // 서버가 계산한 최종 상태로 확정
        state.stones = finalStones;
        state.animating = false;
        draw();
        onDone();
      }
    }
    requestAnimationFrame(frame);
  }

  /* ---------- 타이머 ---------- */
  function startTimer() {
    stopTimer();
    remaining = 15;
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

  /* ---------- UI 갱신 ---------- */
  function updateStatus() {
    myColorEl.textContent = KOR_COLOR[state.myColor] || '-';
    if (state.turn) {
      const mine = isMyTurn();
      turnEl.textContent = mine ? '내 차례!' : '상대 차례';
      turnEl.classList.toggle('turn-mine', mine);
      turnEl.classList.toggle('turn-theirs', !mine);
    }
  }

  function showOverlay(title, msg, opts) {
    opts = opts || {};
    overlayTitle.textContent = title;
    overlayMsg.textContent = msg;
    findBtn.classList.toggle('hidden', !opts.find);
    rematchBtn.classList.toggle('hidden', !opts.rematch);
    spinner.classList.toggle('hidden', !opts.spinner);
    overlay.classList.remove('hidden');
  }
  function hideOverlay() { overlay.classList.add('hidden'); }

  /* ---------- 소켓 이벤트 ---------- */
  findBtn.addEventListener('click', () => {
    socket.emit('findMatch');
    showOverlay('상대를 찾는 중...', '다른 플레이어가 접속하기를 기다리고 있어요.', { spinner: true });
  });
  rematchBtn.addEventListener('click', () => {
    socket.emit('rematch');
    showOverlay('재대국 준비 중...', '상대의 응답을 기다립니다.', { spinner: true });
  });

  socket.on('waiting', () => {
    showOverlay('상대를 찾는 중...', '다른 플레이어가 접속하기를 기다리고 있어요.', { spinner: true });
  });

  socket.on('matchFound', (data) => {
    if (data.color) state.myColor = data.color; // 재대국 시엔 색 유지
    state.stones = data.stones;
    state.turn = data.turn;
    state.over = false;
    state.started = true;
    state.animating = false;
    statusbar.classList.remove('hidden');
    hideOverlay();
    updateStatus();
    startTimer();
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
        startTimer();
      }
    });
  });

  socket.on('turnTimeout', (data) => {
    state.turn = data.turn;
    updateStatus();
    startTimer();
    draw();
  });

  socket.on('opponentLeft', () => {
    stopTimer();
    state.over = true;
    state.started = false;
    showOverlay('상대가 나갔어요 😥', '부전승입니다! 새 상대를 찾아보세요.', { find: true });
  });

  function endGame(winner) {
    stopTimer();
    state.over = true;
    const win = winner === state.myColor;
    showOverlay(
      win ? '🎉 승리!' : '😢 패배',
      win ? '상대 돌을 모두 밀어냈습니다!' : '내 돌이 모두 판 밖으로 나갔어요.',
      { rematch: true }
    );
  }

  // 최초 화면
  showOverlay('환영합니다 👋', '아래 버튼을 눌러 상대를 찾아보세요. 상대 돌 3개를 모두 판 밖으로 밀어내면 승리!', { find: true });
  draw();
})();
