// Settings, profile editor and connection info dialogs.
import { el, esc, copyText } from './util.js';
import { avatar, icon, openModal, toast, confirmDialog } from './ui.js';
import * as store from './store.js';
import { BOARD_STYLES } from './three/textures.js';
import { AVATAR_PIECES, AVATAR_HUES, PIECE_NAMES, BROKERS, CUSTOM_BROKER, APP_VERSION } from './config.js';
import { listSets, setStripHTML, setPreviewHTML, setName } from './pieceSets.js';

export function openPieceSetPicker(app) {
  const sets = listSets();
  const cur = app.settings.pieceSet || 'classic';
  const body = el(`<div style="display:flex;flex-direction:column;gap:14px">
    <p class="modal-msg" style="font-size:14px">고른 세트가 <b>내 진영의 말</b>이 되고, 상대와 관전자 화면에도 똑같이 보여요. 둘이 같은 세트면 흑은 어둡게 표시돼요.</p>
    <div class="set-grid">${sets.map((s) => `
      <button type="button" class="set-card ${s.id === cur ? 'on' : ''}" data-set="${esc(s.id)}">
        <div class="set-strip">${setStripHTML(s.id)}</div>
        <div class="set-name">${esc(s.name)}</div>
        <div class="set-desc">${esc(s.desc || (s.kind === 'image' ? (s.single ? '이미지 1장 · 크기와 배지로 역할 구분' : '역할별 이미지 · 배지로 역할 표시') : ''))}</div>
      </button>`).join('')}
    </div>
    ${sets.length === 1
    ? '<div class="set-empty">아직 추가된 이미지 세트가 없어요.<br>사이트의 <code>assets/pieces</code> 폴더에 PNG 이미지를 넣고 <code>sets.json</code>에 등록하면 여기에 나타나요. (같은 폴더의 README 참고)</div>'
    : '<p class="hint">새 세트는 <code>assets/pieces</code> 폴더에 이미지를 넣고 <code>sets.json</code>에 등록하면 추가돼요.</p>'}
  </div>`);
  const m = openModal({ title: '체스말 세트', body, actions: [{ label: '완료', kind: 'primary' }] });
  body.addEventListener('click', (e) => {
    const b = e.target.closest('[data-set]');
    if (!b) return;
    app.setPieceSet(b.dataset.set);
    for (const x of body.querySelectorAll('.set-card')) x.classList.toggle('on', x === b);
    app.sfx.play('pick');
  });
  return m;
}

export function sanitizeName(v) {
  return String(v || '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 12);
}

export function avatarPicker(container, av, onChange) {
  let cur = { ...av };
  const render = () => {
    container.innerHTML = `<div class="av-pieces">${AVATAR_PIECES.map((p) => `<button type="button" class="av-piece ${cur.p === p ? 'on' : ''}" data-p="${p}" title="${PIECE_NAMES[p]}" aria-label="${PIECE_NAMES[p]}">${avatar({ p, h: cur.h }, 46)}</button>`).join('')}</div>
      <div class="av-hues">${AVATAR_HUES.map((h) => `<button type="button" class="av-hue ${cur.h === h ? 'on' : ''}" data-h="${h}" style="--h:${h}" aria-label="색상 ${h}"></button>`).join('')}</div>`;
  };
  render();
  container.onclick = (e) => {
    const b = e.target.closest('[data-p],[data-h]');
    if (!b) return;
    if (b.dataset.p) cur = { ...cur, p: b.dataset.p };
    else cur = { ...cur, h: +b.dataset.h };
    render();
    onChange({ ...cur });
  };
}

export function openProfileEditor(app) {
  let av = { ...app.profile.av };
  const body = el(`<div style="display:flex;flex-direction:column;gap:16px">
    <div class="form-row"><span class="lbl">닉네임</span><input class="input" id="pf-name" maxlength="12" value="${esc(app.profile.name)}"></div>
    <div class="form-row"><span class="lbl">캐릭터</span><div class="avatar-picker" id="pf-av"></div></div>
    <p class="hint">닉네임을 바꿔도 전적과 레이팅은 그대로 유지돼요. (고유 ID로 저장)</p>
  </div>`);
  avatarPicker(body.querySelector('#pf-av'), av, (v) => { av = v; });
  const save = () => {
    const name = sanitizeName(body.querySelector('#pf-name').value);
    if (!name) { toast('닉네임을 입력해 주세요', { type: 'error' }); return false; }
    app.setProfile({ name, av });
    toast('프로필을 저장했어요', { type: 'success' });
    return true;
  };
  const m = openModal({
    title: '프로필', body, size: 'sm',
    actions: [{ label: '취소' }, { label: '저장', kind: 'primary', onClick: () => save() || false }],
  });
  body.querySelector('#pf-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); if (save()) m.close(); } });
}

function switchRow(id, title, desc, on) {
  return `<label class="switch-row"><div><div class="sr-t">${title}</div>${desc ? `<div class="sr-d">${desc}</div>` : ''}</div>
    <span class="switch"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}><i></i></span></label>`;
}

export function openSettings(app, tab = 'general') {
  const s = app.settings;
  const styleOpts = Object.entries(BOARD_STYLES).map(([k, v]) =>
    `<button type="button" class="style-opt ${s.boardStyle === k ? 'on' : ''}" data-style="${k}"><span class="sw" style="--l:${v.light};--d:${v.dark};--fr:${v.frame}"></span>${esc(v.name)}</button>`).join('');
  const brokers = [...(CUSTOM_BROKER ? [CUSTOM_BROKER] : []), ...BROKERS];
  const body = el(`<div style="display:flex;flex-direction:column;gap:14px">
    <div class="tabs">
      <button data-tab="general">일반</button><button data-tab="display">화면</button><button data-tab="data">데이터</button><button data-tab="server">서버</button>
    </div>
    <div data-pane="general">
      ${switchRow('st-sound', '효과음', '기물 이동, 체크, 승리 사운드', s.sound)}
      <div class="switch-row"><div><div class="sr-t">음량</div></div><input type="range" id="st-vol" min="0" max="1" step="0.05" value="${s.volume}"></div>
      ${switchRow('st-autoq', '자동 퀸 승급', '폰이 끝에 닿으면 묻지 않고 퀸으로 승급', s.autoQueen)}
      ${switchRow('st-confirm', '기권 전에 한 번 더 묻기', '', s.confirmResign)}
      <div class="switch-row"><div><div class="sr-t">프로필</div><div class="sr-d">닉네임과 캐릭터 변경</div></div><button class="btn btn-sm" data-act="profile">${icon('edit', 'sm')}변경</button></div>
    </div>
    <div data-pane="display" hidden style="display:flex;flex-direction:column;gap:14px">
      <div class="form-row"><span class="lbl">테마</span><div class="chips" id="st-theme">
        ${[['light', '라이트'], ['dark', '다크'], ['system', '시스템 설정']].map(([k, v]) => `<button type="button" class="chip ${s.theme === k ? 'on' : ''}" data-theme="${k}">${v}</button>`).join('')}
      </div></div>
      <div class="form-row"><span class="lbl">체스말</span>
        <div class="switch-row" style="padding:4px 0;border:0"><div style="display:flex;align-items:center;gap:8px">${setPreviewHTML(s.pieceSet, 'w', 30)}<b>${esc(setName(s.pieceSet))}</b></div><button class="btn btn-sm" data-act="pieceset">${icon('edit', 'sm')}바꾸기</button></div>
      </div>
      <div class="form-row"><span class="lbl">보드 스타일</span><div class="style-opts" id="st-style">${styleOpts}</div></div>
      <div class="form-row"><span class="lbl">애니메이션 속도</span><div class="chips" id="st-speed">
        ${[[0.7, '여유롭게'], [1, '보통'], [1.6, '빠르게']].map(([k, v]) => `<button type="button" class="chip ${s.animSpeed === k ? 'on' : ''}" data-speed="${k}">${v}</button>`).join('')}
      </div></div>
      <div>${switchRow('st-legal', '이동 가능한 칸 표시', '기물을 집으면 갈 수 있는 칸에 점을 보여줘요', s.showLegal)}</div>
    </div>
    <div data-pane="data" hidden style="display:flex;flex-direction:column;gap:14px">
      <div class="form-row"><span class="lbl">${icon('download')}백업 코드 만들기</span>
        <p class="hint">전적·레이팅·프로필이 들어 있는 코드예요. 다른 기기에서 ‘복원’하면 그대로 이어서 쓸 수 있어요.</p>
        <textarea class="input" id="st-export" readonly rows="3"></textarea>
        <div style="display:flex;gap:8px"><button class="btn btn-sm btn-primary" data-act="export">${icon('copy', 'sm')}코드 만들고 복사</button><button class="btn btn-sm" data-act="download">${icon('download', 'sm')}파일로 저장</button></div>
      </div>
      <div class="form-row"><span class="lbl">${icon('upload')}백업 코드로 복원</span>
        <textarea class="input" id="st-import" rows="3" placeholder="백업 코드를 붙여넣으세요"></textarea>
        <div><button class="btn btn-sm" data-act="import">${icon('upload', 'sm')}복원하기</button></div>
      </div>
      <div class="form-row"><span class="lbl" style="color:var(--danger)">전적 초기화</span>
        <p class="hint">레이팅과 대국 기록을 모두 지워요. 되돌릴 수 없어요.</p>
        <div><button class="btn btn-sm btn-danger" data-act="reset">전적 초기화</button></div>
      </div>
    </div>
    <div data-pane="server" hidden style="display:flex;flex-direction:column;gap:14px">
      <dl class="kv">
        <dt>상태</dt><dd>${app.net.online ? `연결됨 · ${esc(app.net.broker?.name || '')}` : '연결 안 됨'}</dd>
        <dt>로비</dt><dd>${esc(app.lobbyName)}</dd>
        <dt>버전</dt><dd>${APP_VERSION}</dd>
      </dl>
      <div class="form-row"><span class="lbl">중계 서버</span>
        <div class="chips" id="st-broker">
          <button type="button" class="chip ${s.broker === 'auto' ? 'on' : ''}" data-broker="auto">자동</button>
          ${brokers.map((b) => `<button type="button" class="chip ${s.broker === b.id ? 'on' : ''}" data-broker="${b.id}">${esc(b.name)}</button>`).join('')}
        </div>
        <p class="hint">친구와 같은 서버에 있어야 서로 보여요. 보통은 ‘자동’이면 충분해요. 바꾸면 새로고침돼요.</p>
      </div>
      <div class="form-row"><span class="lbl">우리끼리 로비 링크</span>
        <p class="hint">주소 뒤에 <b>?lobby=이름</b>을 붙이면 그 링크로 들어온 사람끼리만 보이는 별도 로비가 열려요.</p>
        <div style="display:flex;gap:8px"><input class="input" id="st-lobby" maxlength="24" placeholder="예: 우리반" value="${esc(app.lobbyParam || '')}"><button class="btn" data-act="lobbylink">${icon('copy', 'sm')}링크 복사</button></div>
      </div>
    </div>
  </div>`);

  const tabs = body.querySelector('.tabs');
  const setTab = (t) => {
    for (const b of tabs.children) b.classList.toggle('on', b.dataset.tab === t);
    for (const p of body.querySelectorAll('[data-pane]')) p.hidden = p.dataset.pane !== t;
  };
  setTab(tab);
  tabs.addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) setTab(b.dataset.tab); });

  const on = (sel, ev, fn) => body.querySelector(sel).addEventListener(ev, fn);
  on('#st-sound', 'change', (e) => app.saveSettings({ sound: e.target.checked }));
  on('#st-vol', 'input', (e) => app.saveSettings({ volume: +e.target.value }));
  on('#st-vol', 'change', () => app.sfx.play('move'));
  on('#st-autoq', 'change', (e) => app.saveSettings({ autoQueen: e.target.checked }));
  on('#st-confirm', 'change', (e) => app.saveSettings({ confirmResign: e.target.checked }));
  on('#st-legal', 'change', (e) => app.saveSettings({ showLegal: e.target.checked }));
  const chipGroup = (sel, attr, fn) => on(sel, 'click', (e) => {
    const b = e.target.closest(`[data-${attr}]`);
    if (!b) return;
    for (const x of body.querySelector(sel).children) x.classList.toggle('on', x === b);
    fn(b.dataset[attr]);
  });
  chipGroup('#st-theme', 'theme', (v) => { app.saveSettings({ theme: v }); app.applyTheme(); });
  chipGroup('#st-speed', 'speed', (v) => app.saveSettings({ animSpeed: +v }));
  chipGroup('#st-style', 'style', (v) => app.saveSettings({ boardStyle: v }));
  chipGroup('#st-broker', 'broker', async (v) => {
    app.saveSettings({ broker: v });
    if (app.room) { toast('방에서 나온 뒤 새로고침하면 적용돼요', { type: 'warn' }); return; }
    const ok = await confirmDialog({ title: '서버 변경', message: '새로고침해서 바뀐 서버로 접속할까요?', ok: '새로고침' });
    if (ok) location.reload();
  });

  body.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'profile') openProfileEditor(app);
    else if (act === 'pieceset') {
      const pm = openPieceSetPicker(app);
      pm.result.then(() => {
        const row = b.parentElement;
        row.firstElementChild.innerHTML = `${setPreviewHTML(app.settings.pieceSet, 'w', 30)}<b>${esc(setName(app.settings.pieceSet))}</b>`;
      });
    }
    else if (act === 'export') {
      const code = store.exportData();
      body.querySelector('#st-export').value = code;
      const ok = await copyText(code);
      toast(ok ? '백업 코드를 복사했어요. 안전한 곳에 보관하세요!' : '코드를 직접 선택해서 복사해 주세요', { type: ok ? 'success' : 'warn' });
    } else if (act === 'download') {
      const code = store.exportData();
      const blob = new Blob([code], { type: 'text/plain' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `chess-lounge-backup-${new Date().toISOString().slice(0, 10)}.txt`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    } else if (act === 'import') {
      const code = body.querySelector('#st-import').value.trim();
      if (!code) return;
      let data;
      try { data = store.parseBackup(code); } catch { toast('올바른 백업 코드가 아니에요', { type: 'error' }); return; }
      const st = data.stats || {};
      const ok = await confirmDialog({
        title: '복원할까요?',
        message: `<b>${esc(data.profile.name || '?')}</b>님의 데이터 (레이팅 ${st.rating ?? '-'}, ${(st.w || 0) + (st.l || 0) + (st.d || 0)}판)로 지금 데이터를 덮어써요.`,
        ok: '복원 후 새로고침', danger: true,
      });
      if (!ok) return;
      if (app.room) app.room.leave();
      store.importData(code);
      location.reload();
    } else if (act === 'reset') {
      const ok = await confirmDialog({ title: '전적 초기화', message: '레이팅과 모든 대국 기록이 삭제돼요. 정말 초기화할까요?', ok: '초기화', danger: true });
      if (!ok) return;
      store.resetStats();
      app.onStatsChanged();
      toast('전적을 초기화했어요', { type: 'success' });
    } else if (act === 'lobbylink') {
      const v = body.querySelector('#st-lobby').value.trim();
      const url = new URL(location.href);
      url.search = '';
      if (v) url.searchParams.set('lobby', v);
      const ok = await copyText(url.toString());
      toast(ok ? `링크를 복사했어요: ${url}` : url.toString(), { type: ok ? 'success' : 'info', timeout: 6000 });
    }
  });
  openModal({ title: '설정', body, actions: [{ label: '닫기', kind: 'primary' }] });
}

export function openConnInfo(app) {
  const n = app.net;
  const users = [...app.lobby.users.values()].filter((u) => !u.stale).length + 1;
  const statusText = { online: '연결됨', connecting: '연결 중', reconnecting: '다시 연결 중', failed: '연결 실패', closed: '연결 종료', idle: '대기' }[n.status] || n.status;
  const body = `<dl class="kv">
      <dt>상태</dt><dd>${esc(statusText)}</dd>
      <dt>서버</dt><dd>${esc(n.broker?.name || '-')} <span class="muted" style="font-weight:500">${esc(n.broker?.url || '')}</span></dd>
      <dt>로비</dt><dd>${esc(app.lobbyName)}</dd>
      <dt>접속자</dt><dd>${users}명</dd>
    </dl>
    <p class="hint">무료 공개 중계 서버(MQTT)를 사용해요. 친구가 안 보이면 둘 다 같은 서버에 연결됐는지 확인하고, 새로고침해 보세요.</p>`;
  openModal({
    title: '연결 정보', body, size: 'sm',
    actions: [{ label: '닫기' }, { label: '새로고침', kind: 'primary', icon: 'refresh', onClick: () => location.reload() }],
  });
}
