/*
 * physics.js — 알까기 공용 2D 물리 엔진
 * -------------------------------------------------
 * 서버(Node)와 클라이언트(브라우저)가 "동일한 코드"로 시뮬레이션을 돌려
 * 결과가 항상 일치하도록(결정론적) 설계되었습니다.
 * - 돌끼리의 충돌: 질량이 같은 완전 탄성 충돌 (법선 성분 교환)
 * - 벽: 알까기에는 벽이 없습니다. 판 밖으로 나간 돌은 "탈락" 처리합니다.
 *   (승리 조건: 상대의 돌 3개를 모두 판 밖으로 밀어내기)
 */
(function (root) {
  'use strict';

  // 게임판/돌 기본 설정값 (서버·클라이언트가 공유)
  var CONFIG = {
    BOARD: 600,        // 게임판 한 변의 논리적 크기(정사각형)
    RADIUS: 22,        // 돌 반지름
    FRICTION: 0.96,    // 매 스텝마다 속도에 곱해지는 마찰 계수 (낮을수록 빨리 멈춤)
    MIN_SPEED: 0.06,   // 이 속도 미만이면 정지한 것으로 간주
    MAX_STEPS: 4000,   // 무한 루프 방지용 최대 시뮬레이션 스텝
    MAX_SPEED: 40,     // 한 스텝당 최대 속도 — 세게 치면 자기 돌도 판 밖으로 날아갈 수 있음
    PLACE_TIME: 30     // 돌 배치 제한시간(초)
  };

  // 두 돌이 겹쳐 있는지 검사하고, 겹쳤다면 완전 탄성 충돌로 해소
  function resolveCollision(a, b) {
    var dx = b.x - a.x;
    var dy = b.y - a.y;
    var dist = Math.sqrt(dx * dx + dy * dy);
    var minDist = CONFIG.RADIUS * 2;
    if (dist === 0) {
      // 완전히 겹친 예외 상황: 아주 살짝 밀어 분리
      dx = 0.01; dy = 0; dist = 0.01;
    }
    if (dist >= minDist) return; // 겹치지 않음

    // 1) 겹친 만큼 서로 밀어내어 위치 분리
    var overlap = minDist - dist;
    var nx = dx / dist; // 충돌 법선(단위 벡터)
    var ny = dy / dist;
    a.x -= nx * overlap / 2;
    a.y -= ny * overlap / 2;
    b.x += nx * overlap / 2;
    b.y += ny * overlap / 2;

    // 2) 법선 방향 상대 속도 계산
    var dvx = b.vx - a.vx;
    var dvy = b.vy - a.vy;
    var relVelAlongNormal = dvx * nx + dvy * ny;
    if (relVelAlongNormal > 0) return; // 이미 서로 멀어지는 중

    // 질량 동일 + 완전 탄성 => 법선 방향 속도 성분을 교환
    var impulse = relVelAlongNormal;
    a.vx += impulse * nx;
    a.vy += impulse * ny;
    b.vx -= impulse * nx;
    b.vy -= impulse * ny;
  }

  // 시뮬레이션 한 스텝 진행. 아직 움직이는 돌이 있으면 true 반환
  function step(stones) {
    var moving = false;
    var i, j, s;

    // 위치 갱신 + 마찰 적용
    for (i = 0; i < stones.length; i++) {
      s = stones[i];
      if (!s.alive) continue;
      s.x += s.vx;
      s.y += s.vy;
      s.vx *= CONFIG.FRICTION;
      s.vy *= CONFIG.FRICTION;
      if (Math.abs(s.vx) < CONFIG.MIN_SPEED) s.vx = 0;
      if (Math.abs(s.vy) < CONFIG.MIN_SPEED) s.vy = 0;

      // 판 밖으로 중심이 벗어나면 탈락
      if (s.x < 0 || s.x > CONFIG.BOARD || s.y < 0 || s.y > CONFIG.BOARD) {
        s.alive = false;
        s.vx = 0; s.vy = 0;
      }
      if (s.vx !== 0 || s.vy !== 0) moving = true;
    }

    // 충돌 검사 (모든 살아있는 돌 쌍)
    for (i = 0; i < stones.length; i++) {
      if (!stones[i].alive) continue;
      for (j = i + 1; j < stones.length; j++) {
        if (!stones[j].alive) continue;
        resolveCollision(stones[i], stones[j]);
      }
    }
    return moving;
  }

  // 모든 돌이 멈출 때까지 끝까지 시뮬레이션 (서버 권위 계산용)
  function settle(stones) {
    var steps = 0;
    while (step(stones) && steps < CONFIG.MAX_STEPS) {
      steps++;
    }
    return steps;
  }

  // 드래그 벡터(픽셀)를 속도로 변환. 파워는 MAX_SPEED로 상한 처리
  function vectorToVelocity(dx, dy, scale) {
    scale = scale || 0.16;
    var vx = dx * scale;
    var vy = dy * scale;
    var speed = Math.sqrt(vx * vx + vy * vy);
    if (speed > CONFIG.MAX_SPEED) {
      var k = CONFIG.MAX_SPEED / speed;
      vx *= k; vy *= k;
    }
    return { vx: vx, vy: vy };
  }

  var api = {
    CONFIG: CONFIG,
    step: step,
    settle: settle,
    resolveCollision: resolveCollision,
    vectorToVelocity: vectorToVelocity
  };

  // Node & 브라우저 양쪽에서 사용 가능하도록 내보내기
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.AlkPhysics = api;
  }
})(typeof window !== 'undefined' ? window : this);
