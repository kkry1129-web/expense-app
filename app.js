/**
 * app.js ― 立替・経費精算の画面の処理
 *
 * - データはすべて Apps Script の窓口（config.js の API_URL）から受け取る。通信は callApi の1か所だけ。
 * - 誰が何をできるか・状態の計算は、サーバー（Rules.gs）が正。
 *   画面はボタンの出し分けのために同じ決まりを真似するだけで、最終判断はサーバーに任せる。
 * - 画面はリアルタイムには更新しない。操作のあと・タブを切り替えたとき・「更新」を押したときに読み直す。
 * - 流用元：旧版 expense-app.html の card / renderSettle / buildCsv / buildHtml など。
 *
 * ※ このファイルは公開される。氏名・メールアドレスなどは書かない。
 */
(function () {
  'use strict';

  var CFG = window.APP_CONFIG || {};

  // サーバーで「承認者」とされている役割名（Auth.gs の ROLES_ と同じ）
  var APPROVER_ROLE = '承認者';

  // 状態の表示名と、バッジの色（Rules.gs の STATUS_LABELS_ と同じ表示名）
  var ST = {
    pending: ['申請中', 'b-p'],
    approved: ['承認済(未払)', 'b-a'],
    paid: ['支払済', 'b-ok'],
    rejected: ['差戻し', 'b-bad'],
    withdrawn: ['取下げ', 'b-m']
  };

  // 領収書の表示名（Rules.gs の RECEIPTS_ と同じ）
  var RC = { paper: '原本あり', digital: '電子データ', none: 'なし' };

  // 飲食の注意文（Rules.gs の MEAL_HINT_ / MEAL_WORDS_ と同じ。直すときは両方そろえる）
  var MEAL_WORDS = /飲食|居酒屋|懇親|食事|ランチ|ディナー|飲み会|弁当/;
  var MEAL_HINT = '打合せの記録（いつ・誰と・何の打合せか）があれば会議費にできます。' +
    '創業メンバーだけで、打合せの記録がない飲食は経費にしません。';

  // 2回押して確定するボタンの、待ち時間（ミリ秒）
  var ARM_MS = 4000;

  /**
   * 画面の状態。サーバーから受け取ったものと、画面だけの状態をここにまとめる。
   * expenses の各要素は、サーバーの toView_ の形（applicantEmail は含まない。mine / status / flags が付く）。
   */
  var S = {
    idToken: null,   // GIS のIDトークン（約1時間で切れる。切れたらログインし直してもらう）
    me: null,        // { name, role }
    settings: null,  // { company, approverName, foundingCap, cats, pays }
    today: '',       // サーバーの今日（日本時間 YYYY-MM-DD）
    expenses: [],
    editing: null,   // 修正中の申請 { id, rev }
    filter: 'all',   // 一覧の状態の絞り込み
    tab: 'new',
    busy: false,     // 保存中（二重送信を防ぐ）
    payPeople: []    // 精算タブの「まとめて支払済」の対象者（ボタンの番号 → 氏名）
  };

  /* =====================================================================
   * 小さな道具
   * ===================================================================== */

  function $(id) { return document.getElementById(id); }

  /** HTML に埋め込む文字を無害にする */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /** 金額の表示（¥12,000） */
  function yen(n) { return '¥' + Number(n || 0).toLocaleString('ja-JP'); }

  function pad(n) { return String(n).padStart(2, '0'); }

  /** 日時の文字列を YYYY/MM/DD にする。読めなければそのまま返す */
  function dstr(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    return isNaN(d) ? String(iso) : d.getFullYear() + '/' + pad(d.getMonth() + 1) + '/' + pad(d.getDate());
  }

  /** 金額の読み取り（申請欄の注意表示に使うだけ。正式な判定はサーバー） */
  function parseAmt(v) {
    var n = Number(String(v)
      .replace(/[０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); })
      .replace(/[,，円\s]/g, ''));
    return Number.isInteger(n) && n > 0 ? n : 0;
  }

  /** select の選択肢を作る */
  function opts(el, arr, first) {
    el.innerHTML = (first ? '<option value="">' + esc(first) + '</option>' : '') +
      arr.map(function (v) { return '<option>' + esc(v) + '</option>'; }).join('');
  }

  function isApprover() { return !!S.me && S.me.role === APPROVER_ROLE; }

  /** お知らせ欄（画面上部）。cls：w=注意 b=エラー o=完了 i=情報 */
  function banner(msg, cls) {
    $('banner').innerHTML = msg ? '<div class="note ' + (cls || 'w') + '" style="margin:0 0 10px">' + esc(msg) + '</div>' : '';
  }

  /** 指定の欄にメッセージを出す */
  function note(el, msg, cls) {
    el.innerHTML = msg ? '<div class="note ' + (cls || 'b') + '">' + esc(msg) + '</div>' : '';
  }

  /** 申請者の氏名の一覧（申請に出てくる人。五十音順） */
  function people() {
    var seen = {};
    S.expenses.forEach(function (e) { if (e.applicantName) seen[e.applicantName] = 1; });
    return Object.keys(seen).sort(function (a, b) { return a.localeCompare(b, 'ja'); });
  }

  function findExpense(id) {
    for (var i = 0; i < S.expenses.length; i++) if (S.expenses[i].id === id) return S.expenses[i];
    return null;
  }

  /* =====================================================================
   * 通信
   * ===================================================================== */

  /**
   * Apps Script の窓口を呼ぶ。成功なら data を返し、失敗なら Error を投げる。
   * - Content-Type を text/plain にするのは、ブラウザの事前確認（プリフライト）を起こさないため。
   * - ログインの問題（期限切れなど）のエラーには err.auth = true を付ける。
   */
  function callApi(action, payload) {
    return fetch(CFG.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ idToken: S.idToken, action: action, payload: payload || {} })
    }).then(function (res) {
      if (!res.ok) throw new Error('サーバーの応答が異常です（' + res.status + '）。');
      return res.json();
    }, function () {
      throw new Error('通信できませんでした。ネットワークを確かめて、もう一度操作してください。');
    }).then(function (r) {
      if (r && r.ok) return r.data;
      var err = new Error((r && r.error) || 'エラーが発生しました。');
      // サーバー（Auth.gs）のログイン関係のエラーは、どれも「ログイン」を含む
      err.auth = /ログイン/.test(err.message);
      throw err;
    });
  }

  /**
   * 保存する操作を送る。保存中はボタンを押せなくし、成功したら全件を描き直す。
   * エラーは呼び出し側で表示する（ログインの問題ならログイン欄を出す）。
   */
  function run(action, payload) {
    if (S.busy) return Promise.reject(new Error('保存中です。少し待ってください。'));
    setBusy(true);
    return callApi(action, payload).then(function (data) {
      if (data && data.expenses) S.expenses = data.expenses;
      renderAll();
      return data;
    }).finally(function () { setBusy(false); });
  }

  function setBusy(on) {
    S.busy = on;
    document.body.classList.toggle('busy', on);
    $('btnSubmit').disabled = on;
  }

  /** エラーを表示する。ログインの問題ならログイン欄も出す */
  function showError(err, el) {
    if (err && err.auth) showLogin(err.message);
    if (el) note(el, err && err.message, 'b');
    else banner(err && err.message, 'b');
  }

  /** 一覧を読み直す（タブ切り替え・「更新」ボタン） */
  function refresh(withMessage) {
    if (!S.me || S.busy) return;
    callApi('list').then(function (data) {
      S.expenses = data.expenses;
      renderAll();
      if (withMessage) banner('最新の内容を読み込みました。', 'o');
    }).catch(function (err) { showError(err); });
  }

  /* =====================================================================
   * ログイン
   * ===================================================================== */

  /** ログイン欄を出す（最初と、ログインの有効期限が切れたとき） */
  function showLogin(msg) {
    $('login').hidden = false;
    note($('loginMsg'), msg, 'b');
    window.scrollTo(0, 0);
  }

  /** GIS のログインが済んだときに呼ばれる */
  function onCredential(resp) {
    S.idToken = resp.credential;
    note($('loginMsg'), '確認しています…', 'i');
    callApi('init').then(function (data) {
      var first = !S.me;
      S.me = data.me;
      S.settings = data.settings;
      S.today = data.today;
      S.expenses = data.expenses;
      $('login').hidden = true;
      note($('loginMsg'), '');
      $('app').hidden = false;
      $('btnReload').hidden = false;
      $('btnLogout').hidden = false;
      if (first) setupForm();
      renderAll();
      // ログインし直したときは、入力中の内容はそのまま。操作をもう一度してもらう
      banner(first ? '' : 'ログインし直しました。必要なら、もう一度操作してください。', 'o');
    }).catch(function (err) {
      S.idToken = null;
      note($('loginMsg'), err.message, 'b');
    });
  }

  /** ログアウト：IDトークンと読み込んだデータを捨て、ログイン欄に戻す */
  function logout() {
    S.idToken = null;
    S.me = null;
    S.expenses = [];
    S.editing = null;
    if (window.google && google.accounts && google.accounts.id) google.accounts.id.disableAutoSelect();
    $('app').hidden = true;
    $('btnReload').hidden = true;
    $('btnLogout').hidden = true;
    $('who').textContent = '';
    banner('');
    // 次の人がログインしたときに、前の人の入力が残らないようにする
    resetForm();
    note($('formMsg'), '');
    showLogin('');
  }

  /** GIS（index.html の最後で読み込む）の準備ができたら呼ばれる */
  window.onGisLoad = function () {
    whenReady(function () {
      if (!CFG.CLIENT_ID || !CFG.API_URL) {
        note($('loginMsg'), 'config.js の CLIENT_ID または API_URL が未設定です。', 'b');
        return;
      }
      google.accounts.id.initialize({ client_id: CFG.CLIENT_ID, callback: onCredential });
      google.accounts.id.renderButton($('gbtn'), { theme: 'outline', size: 'large', text: 'signin_with', locale: 'ja' });
    });
  };

  /** 画面の部品が読み込まれてから fn を実行する */
  function whenReady(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  /* =====================================================================
   * タブ
   * ===================================================================== */

  function showTab(t) {
    S.tab = t;
    banner(''); // 前の操作のお知らせは、別のタブでは紛らわしいので消す
    ['new', 'list', 'settle', 'doc'].forEach(function (k) { $('v-' + k).hidden = (k !== t); });
    document.querySelectorAll('#tabs button').forEach(function (b) { b.classList.toggle('on', b.dataset.t === t); });
    window.scrollTo(0, 0);
    // 申請タブ以外に切り替えたら、最新の内容を読み直す（先に手元の内容で描き、届いたら描き直す）
    if (t !== 'new') refresh(false);
  }

  /* =====================================================================
   * 申請タブ
   * ===================================================================== */

  /** 最初のログインのあとに1回だけ：区分・支払方法の選択肢を作る */
  function setupForm() {
    opts($('f_cat'), S.settings.cats);
    opts($('f_pay'), S.settings.pays);
    resetForm();
  }

  /** 金額と内容に応じて、注意の表示を切り替える */
  function formHints() {
    var amt = parseAmt($('f_amt').value);
    $('wPre').hidden = !(amt >= 50000);
    $('wQuote').hidden = !(amt > 500000);
    var t = $('f_memo').value + ' ' + $('f_payee').value;
    $('memoHint').innerHTML = MEAL_WORDS.test(t) ? '<div class="note w">' + esc(MEAL_HINT) + '</div>' : '';
  }

  /** 申請欄を空に戻す（修正中ならやめる） */
  function resetForm() {
    S.editing = null;
    ['f_payee', 'f_amt', 'f_memo'].forEach(function (id) { $(id).value = ''; });
    $('f_date').value = S.today || '';
    $('f_date').max = S.today || '';
    $('f_cat').selectedIndex = 0;
    $('f_pay').selectedIndex = 0;
    $('f_rc').value = 'paper';
    $('f_pre').checked = false;
    $('f_quote').checked = false;
    $('formTitle').textContent = '立替の申請';
    $('btnSubmit').textContent = '申請する';
    $('btnCancelEdit').hidden = true;
    formHints();
  }

  /** 一覧の「修正して再申請」：申請欄に今の内容を入れる */
  function startEdit(e) {
    S.editing = { id: e.id, rev: e.rev };
    $('f_date').value = e.date;
    $('f_payee').value = e.payee;
    $('f_amt').value = e.amount;
    $('f_cat').value = e.cat;
    $('f_memo').value = e.memo;
    $('f_pay').value = e.pay;
    $('f_rc').value = e.receipt;
    $('f_pre').checked = !!e.pre;
    $('f_quote').checked = !!e.quote;
    $('formTitle').textContent = '修正して再申請（' + e.id + '）';
    $('btnSubmit').textContent = '再申請する';
    $('btnCancelEdit').hidden = false;
    formHints();
    note($('formMsg'), '');
    showTab('new');
  }

  /** 申請する／再申請する。入力の確かめはサーバーで行い、だめならその文面を出す */
  function submitForm() {
    var value = {
      date: $('f_date').value,
      payee: $('f_payee').value,
      amount: $('f_amt').value,          // 全角・カンマなどの読み取りはサーバーで行う
      cat: $('f_cat').value,
      memo: $('f_memo').value,
      pay: $('f_pay').value,
      receipt: $('f_rc').value,
      // 隠れているチェック欄は送らない（金額を下げたのにチェックが残る誤りを防ぐ）
      pre: $('f_pre').checked && !$('wPre').hidden,
      quote: $('f_quote').checked && !$('wQuote').hidden
    };
    var msgEl = $('formMsg');
    note(msgEl, '保存しています…', 'i');
    var ed = S.editing;
    var p = ed
      ? run('edit', { id: ed.id, rev: ed.rev, value: value })
      : run('create', { value: value });
    p.then(function (data) {
      resetForm();
      if (ed) {
        note(msgEl, '修正して再申請しました（' + ed.id + '）。', 'o');
      } else {
        note(msgEl, '申請しました（申請番号 ' + data.id + '）。領収書の裏面に申請番号を書いておくと、あとで照合しやすくなります。', 'o');
      }
    }).catch(function (err) { showError(err, msgEl); });
  }

  /* =====================================================================
   * 一覧タブ
   * ===================================================================== */

  /**
   * 申請1件のカード。操作ボタンは Rules.gs の ACTIONS_ と同じ条件で出す：
   *   承認・差戻し … 承認者、申請中のとき
   *   支払済・承認取消 … 承認者、承認済のとき
   *   修正・取下げ … 申請した本人、申請中か差戻しのとき
   */
  function card(e) {
    var st = e.status, b = ST[st] || [st, 'b-m'], id = esc(e.id);
    var act = '';
    if (isApprover() && st === 'pending') {
      act += '<input id="n_' + id + '" maxlength="500" placeholder="差戻し理由（差し戻す場合のみ入力）" style="margin-top:10px">' +
        '<div class="row"><button class="btn" data-act="approve" data-id="' + id + '">承認</button>' +
        '<button class="btn bad" data-act="reject" data-id="' + id + '">差戻し</button></div>';
    }
    if (isApprover() && st === 'approved') {
      act += '<div class="row"><input id="d_' + id + '" type="date" value="' + esc(S.today) + '">' +
        '<input id="r_' + id + '" maxlength="100" placeholder="振込メモ（任意）"></div>' +
        '<div class="row"><button class="btn" data-act="pay" data-id="' + id + '">支払済にする</button>' +
        '<button class="btn ghost" data-act="unapprove" data-id="' + id + '">承認を取り消す</button></div>';
    }
    if (e.mine && (st === 'pending' || st === 'rejected')) {
      act += '<div class="row"><button class="btn ghost" data-act="edit" data-id="' + id + '">修正して再申請</button>' +
        '<button class="btn bad" data-act="withdraw" data-id="' + id + '">取り下げ</button></div>';
    }
    var extra = '';
    if (st === 'rejected' && e.note) extra = '<div class="note b">差戻し理由：' + esc(e.note) + '</div>';
    if (st === 'approved') extra = '<div class="meta" style="margin-top:6px">承認：' + esc(e.apBy) + '（' + esc(dstr(e.apAt)) + '）</div>';
    if (st === 'paid') extra = '<div class="note o">' + esc(e.paidDate) + ' 支払済' + (e.ref ? '（' + esc(e.ref) + '）' : '') + '</div>';
    var flags = (e.flags || []).map(function (f) { return '<span class="flag">⚠ ' + esc(f) + '</span>'; }).join('');
    return '<div class="card' + (st === 'withdrawn' ? ' dim' : '') + '">' +
      '<div class="h"><div><div class="no">' + id + ' ・ ' + esc(e.date) + (e.rev > 1 ? ' ・ 修正' + (e.rev - 1) + '回' : '') + '</div>' +
      '<div class="pay">' + esc(e.payee) + '</div></div><div class="amt">' + yen(e.amount) + '</div></div>' +
      '<div class="meta">' + esc(e.cat) + ' ・ 申請者 ' + esc(e.applicantName) + ' ・ ' + esc(e.pay) + ' ・ 領収書 ' + esc(RC[e.receipt] || e.receipt) + '</div>' +
      '<div class="memo">' + esc(e.memo) + '</div>' +
      '<div style="margin-top:8px"><span class="badge ' + b[1] + '">' + esc(b[0]) + '</span> ' + flags + '</div>' +
      extra + act + '</div>';
  }

  function renderList() {
    var app = $('l_app').value;
    var rows = S.expenses.filter(function (e) {
      return (!app || e.applicantName === app) && (S.filter === 'all' || e.status === S.filter);
    });
    $('list').innerHTML = rows.length ? rows.map(card).join('') : '<div class="empty">該当する申請はありません</div>';
  }

  /* =====================================================================
   * 精算タブ
   * ===================================================================== */

  /** 申請者ごとの、状態別の合計 */
  function sums(name) {
    var o = { pending: 0, approved: 0, paid: 0 };
    S.expenses.forEach(function (e) {
      if (e.applicantName === name && o[e.status] !== undefined) o[e.status] += e.amount;
    });
    return o;
  }

  function renderSettle() {
    var h = '';
    var cap = S.settings.foundingCap;
    // 創立費（区分名が「創立費」で始まるもの）の上限バー
    var fee = S.expenses.filter(function (e) { return String(e.cat).indexOf('創立費') === 0; });
    var total = function (list) { return list.reduce(function (a, e) { return a + e.amount; }, 0); };
    var done = total(fee.filter(function (e) { return e.status === 'approved' || e.status === 'paid'; }));
    var wait = total(fee.filter(function (e) { return e.status === 'pending'; }));
    if (cap > 0) {
      var pct = function (x) { return Math.min(100, Math.round(x / cap * 100)); };
      var over = done > cap;
      h += '<div class="card"><h3>創立費の上限（定款：' + yen(cap) + '以内）</h3>' +
        '<div class="bar"><i style="width:' + pct(done) + '%;background:' + (over ? 'var(--bad)' : 'var(--acc)') + '"></i>' +
        '<i style="width:' + Math.min(100 - pct(done), pct(wait)) + '%;background:var(--warn)"></i></div>' +
        '<div class="meta">承認済 ' + yen(done) + ' ・ 申請中 ' + yen(wait) + ' ・ 残り ' + yen(Math.max(0, cap - done - wait)) + '</div>' +
        (over ? '<div class="note b">定款の上限を超えています。超えた分は会社から精算できません。</div>' : '') + '</div>';
    } else {
      h += '<div class="card"><h3>創立費</h3><div class="meta">承認済 ' + yen(done) + ' ・ 申請中 ' + yen(wait) + '</div>' +
        '<div class="note w">設定シートに「創立費上限」がないため、上限との比較は表示していません。</div></div>';
    }

    var ps = people();
    h += '<div class="card"><h3>申請者別の状況</h3>';
    if (ps.length) {
      h += '<div class="scroll"><table><tr><th>申請者</th><th class="r">申請中</th><th class="r">未払</th><th class="r">支払済</th></tr>';
      ps.forEach(function (p) {
        var s = sums(p);
        h += '<tr><td>' + esc(p) + '</td><td class="r">' + yen(s.pending) + '</td><td class="r">' + yen(s.approved) + '</td><td class="r">' + yen(s.paid) + '</td></tr>';
      });
      h += '</table></div>';
    } else {
      h += '<div class="empty" style="padding:8px 0">申請はまだありません</div>';
    }
    h += '</div>';

    // まとめて支払済（承認者だけ）
    S.payPeople = [];
    if (isApprover()) {
      ps.forEach(function (p) {
        var list = S.expenses.filter(function (e) { return e.applicantName === p && e.status === 'approved'; });
        if (!list.length) return;
        var i = S.payPeople.push(p) - 1;
        h += '<div class="card"><h3>' + esc(p) + ' さんへ支払う分</h3>' +
          '<div class="meta">承認済 ' + list.length + '件 ・ 合計 <b>' + yen(total(list)) + '</b>（' + list.map(function (e) { return esc(e.id); }).join('、') + '）</div>' +
          '<div class="row"><input id="pd_' + i + '" type="date" value="' + esc(S.today) + '"><input id="pr_' + i + '" maxlength="100" placeholder="振込メモ（任意）"></div>' +
          '<div class="row"><button class="btn" data-act="paybulk" data-p="' + i + '">まとめて支払済にする</button></div>' +
          '<div class="note i">法人口座から本人口座へ振り込んだあとに押してください。振込の摘要は「創立費立替精算」または「立替経費精算」とすると、あとで照合しやすくなります。</div></div>';
      });
      if (!S.payPeople.length) h += '<div class="card"><div class="empty" style="padding:8px 0">支払待ちの承認済みはありません</div></div>';
    }
    $('settle').innerHTML = h;
  }

  /* =====================================================================
   * 帳票タブ
   * ===================================================================== */

  /** 精算書の対象：承認済・支払済（または支払済のみ）を、条件で絞って番号順に */
  function docRows() {
    var app = $('d_app').value, from = $('d_from').value, to = $('d_to').value, only = $('d_st').value === 'paid';
    return S.expenses.filter(function (e) {
      var s = e.status;
      if (!(s === 'paid' || (!only && s === 'approved'))) return false;
      if (app && e.applicantName !== app) return false;
      if (from && e.date < from) return false;
      if (to && e.date > to) return false;
      return true;
    }).sort(function (a, b) { return a.seq - b.seq; });
  }

  function renderDoc() {
    var rows = docRows();
    if (!rows.length) {
      $('docPrev').innerHTML = '<div class="empty">条件に合う承認済・支払済の申請はありません</div>';
      return;
    }
    var tot = rows.reduce(function (a, e) { return a + e.amount; }, 0);
    $('docPrev').innerHTML = '<table><tr><th>番号</th><th>日付</th><th>支払先/内容</th><th class="r">金額</th><th>状態</th></tr>' +
      rows.map(function (e) {
        return '<tr><td>' + esc(e.id) + '</td><td>' + esc(e.date) + '</td><td>' + esc(e.payee) +
          '<div class="mute">' + esc(e.cat) + ' / ' + esc(e.memo) + '</div></td><td class="r">' + yen(e.amount) + '</td><td>' + esc(ST[e.status][0]) + '</td></tr>';
      }).join('') +
      '<tr><th colspan="3" class="r">合計（' + rows.length + '件）</th><th class="r">' + yen(tot) + '</th><th></th></tr></table>';
  }

  /**
   * CSV の1セル。カンマ・改行・" を含むなら囲む。
   * = + - @ で始まる文字は、Excel が数式として実行しないよう先頭に ' を付ける。
   */
  function csvCell(v) {
    var s = String(v == null ? '' : v);
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  /** 全件の台帳CSV（Excel で開けるよう、先頭に BOM を付ける）。旧版に「版数」を追加 */
  function buildCsv() {
    var head = ['申請番号', '版数', '申請者', '領収書日付', '支払先', '区分', '内容', '金額', '支払方法', '領収書', '事前承認', '相見積',
      '状態', '承認日', '承認者', '支払日', '振込メモ', '差戻し理由', '申請日'];
    var lines = [head.map(csvCell).join(',')];
    S.expenses.slice().sort(function (a, b) { return a.seq - b.seq; }).forEach(function (e) {
      var s = e.status, ok = (s === 'approved' || s === 'paid');
      lines.push([e.id, e.rev, e.applicantName, e.date, e.payee, e.cat, e.memo, e.amount, e.pay, RC[e.receipt] || e.receipt,
        e.pre ? 'あり' : '', e.quote ? 'あり' : '', ST[s][0],
        ok ? dstr(e.apAt) : '', ok ? e.apBy : '', s === 'paid' ? e.paidDate : '', s === 'paid' ? e.ref : '',
        s === 'rejected' ? e.note : '', dstr(e.createdAt)].map(csvCell).join(','));
    });
    return '﻿' + lines.join('\r\n');
  }

  /** 精算書（印刷用HTML）。会社名・承認者名は設定シートの値を使う */
  function buildHtml(rows) {
    var app = $('d_app').value || '全員', from = $('d_from').value, to = $('d_to').value;
    var tot = rows.reduce(function (a, e) { return a + e.amount; }, 0);
    var ats = rows.map(function (e) { return e.apAt; }).filter(Boolean).sort();
    var body = rows.map(function (e) {
      return '<tr><td>' + esc(e.id) + '</td><td>' + esc(e.date) + '</td><td>' + esc(e.payee) + '</td><td>' + esc(e.cat) + '</td><td>' + esc(e.memo) +
        '</td><td>' + esc(e.pay) + '</td><td>' + esc(RC[e.receipt] || e.receipt) + '</td><td class="r">' + Number(e.amount).toLocaleString('ja-JP') +
        '</td><td>' + esc(dstr(e.apAt)) + '</td><td>' + esc(e.status === 'paid' ? e.paidDate : '未払') + '</td></tr>';
    }).join('');
    return '<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>立替経費精算書</title><style>' +
      '@page{size:A4 landscape;margin:14mm}body{font-family:"Hiragino Sans","Noto Sans JP","Yu Gothic",sans-serif;color:#111;font-size:11px}' +
      'h1{font-size:18px;margin:0 0 4px}.m{color:#444;margin:2px 0}table{width:100%;border-collapse:collapse;margin-top:10px}th,td{border:1px solid #888;padding:4px 5px;text-align:left;vertical-align:top}th{background:#eee}td.r,th.r{text-align:right}' +
      '.sig{display:flex;gap:14px;margin-top:16px;justify-content:flex-end}.sig div{width:110px;height:70px;border:1px solid #888;padding:4px;font-size:10px}' +
      '</style></head><body><h1>立替経費精算書</h1>' +
      '<div class="m">' + esc(S.settings.company) + '</div>' +
      '<div class="m">申請者：' + esc(app) + '　／　対象期間（領収書日付）：' + esc(from || '指定なし') + ' 〜 ' + esc(to || '指定なし') +
      '　／　作成日：' + esc(S.today.replace(/-/g, '/')) + '</div>' +
      '<table><tr><th>番号</th><th>領収書日付</th><th>支払先</th><th>区分</th><th>内容</th><th>支払方法</th><th>領収書</th><th class="r">金額（円）</th><th>承認日</th><th>支払日</th></tr>' +
      body + '<tr><th colspan="7" class="r">合計（' + rows.length + '件）</th><th class="r">' + tot.toLocaleString('ja-JP') + '</th><th colspan="2"></th></tr></table>' +
      '<div class="m" style="margin-top:8px">承認者：' + esc(S.settings.approverName) + (ats.length ? '（最終承認日 ' + esc(dstr(ats[ats.length - 1])) + '）' : '') + '</div>' +
      '<div class="m">領収書の原本（電子データは電子のまま）は別途保管しています。番号は領収書に付記した申請番号と対応します。</div>' +
      '<div class="sig"><div>承認印</div><div>受領印</div></div></body></html>';
  }

  /** ファイルとして保存する（ブラウザのダウンロード） */
  function saveFile(name, text, type) {
    var url = URL.createObjectURL(new Blob([text], { type: type }));
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
    note($('docMsg'), '保存しました。精算書は開いて「印刷→PDFで保存」で帳票にできます。', 'o');
  }

  /* =====================================================================
   * 描き直し
   * ===================================================================== */

  /** 申請者の絞り込み欄を作り直す（選んでいた人はそのまま） */
  function fillPeopleSelect(el) {
    var prev = el.value, ps = people();
    opts(el, ps, '全員');
    el.value = ps.indexOf(prev) >= 0 ? prev : '';
  }

  /**
   * 全部を描き直す。一覧・精算の中で入力途中の欄（差戻し理由・支払日など）は、
   * 描き直しで消えないよう、値を控えて戻す。
   */
  function renderAll() {
    if (!S.me) return;
    var kept = {};
    document.querySelectorAll('#list input, #settle input').forEach(function (el) { if (el.id) kept[el.id] = el.value; });

    $('who').textContent = S.me.name + '（' + S.me.role + '）';
    $('f_who').textContent = S.me.name;
    fillPeopleSelect($('l_app'));
    fillPeopleSelect($('d_app'));
    renderList();
    renderSettle();
    renderDoc();

    Object.keys(kept).forEach(function (id) { var el = $(id); if (el) el.value = kept[id]; });
  }

  /* =====================================================================
   * 一覧・精算のボタン
   * ===================================================================== */

  /**
   * 取り消しにくい操作は「2回押して確定」にする。
   * 1回目は文字を変えて true 以外を返し、一定時間たったら元に戻す。
   */
  function armed(b) {
    if (b.dataset.armed === '1') return true;
    var orig = b.textContent;
    b.dataset.armed = '1';
    b.textContent = 'もう一度押して確定';
    setTimeout(function () {
      if (b.isConnected && b.dataset.armed === '1') { b.dataset.armed = ''; b.textContent = orig; }
    }, ARM_MS);
    return false;
  }

  /** 操作を送り、結果をお知らせ欄に出す */
  function act(action, payload, okMsg) {
    banner('保存しています…', 'i');
    run(action, payload).then(function () { banner(okMsg, 'o'); }).catch(function (err) { showError(err); });
  }

  function onActionClick(ev) {
    var b = ev.target.closest('button[data-act]');
    if (!b || S.busy) return;
    var a = b.dataset.act, id = b.dataset.id;
    var e = id ? findExpense(id) : null;
    var val = function (key) { var el = $(key); return el ? el.value.trim() : ''; };

    if (a === 'paybulk') {
      var name = S.payPeople[Number(b.dataset.p)];
      var list = S.expenses.filter(function (x) { return x.applicantName === name && x.status === 'approved'; });
      if (!list.length) return;
      act('payBulk', {
        items: list.map(function (x) { return { id: x.id, rev: x.rev }; }),
        paidDate: val('pd_' + b.dataset.p) || S.today,
        ref: val('pr_' + b.dataset.p)
      }, name + ' さんの ' + list.length + '件を支払済にしました。');
      return;
    }
    if (!e) return;

    if (a === 'approve') {
      act('approve', { id: e.id, rev: e.rev }, e.id + ' を承認しました。');
    } else if (a === 'reject') {
      var n = val('n_' + e.id);
      if (!n) { banner('差戻し理由を入力してください。', 'w'); return; }
      act('reject', { id: e.id, rev: e.rev, note: n }, e.id + ' を差し戻しました。');
    } else if (a === 'pay') {
      act('pay', { id: e.id, rev: e.rev, paidDate: val('d_' + e.id) || S.today, ref: val('r_' + e.id) }, e.id + ' を支払済にしました。');
    } else if (a === 'unapprove') {
      if (!armed(b)) return;
      act('unapprove', { id: e.id, rev: e.rev }, e.id + ' の承認を取り消しました。');
    } else if (a === 'withdraw') {
      if (!armed(b)) return;
      // 修正中の申請を取り下げたら、申請欄の修正もやめる
      if (S.editing && S.editing.id === e.id) resetForm();
      act('withdraw', { id: e.id, rev: e.rev }, e.id + ' を取り下げました。');
    } else if (a === 'edit') {
      startEdit(e);
    }
  }

  /* =====================================================================
   * 画面の部品にイベントを付ける（読み込み時に1回）
   * ===================================================================== */

  whenReady(function () {
    $('tabs').addEventListener('click', function (ev) {
      var b = ev.target.closest('button');
      if (b) showTab(b.dataset.t);
    });
    $('chips').addEventListener('click', function (ev) {
      var b = ev.target.closest('button');
      if (!b) return;
      S.filter = b.dataset.f;
      document.querySelectorAll('#chips .chip').forEach(function (c) { c.classList.toggle('on', c === b); });
      renderList();
    });
    $('l_app').addEventListener('change', renderList);
    ['d_app', 'd_st', 'd_from', 'd_to'].forEach(function (id) { $(id).addEventListener('change', renderDoc); });

    ['f_amt', 'f_memo', 'f_payee'].forEach(function (id) { $(id).addEventListener('input', formHints); });
    $('btnSubmit').addEventListener('click', submitForm);
    $('btnCancelEdit').addEventListener('click', function () { resetForm(); note($('formMsg'), ''); });

    $('list').addEventListener('click', onActionClick);
    $('settle').addEventListener('click', onActionClick);

    $('btnReload').addEventListener('click', function () { refresh(true); });
    $('btnLogout').addEventListener('click', logout);

    $('btnCsv').addEventListener('click', function () {
      saveFile('経費台帳_' + S.today + '.csv', buildCsv(), 'text/csv;charset=utf-8');
    });
    $('btnHtml').addEventListener('click', function () {
      var rows = docRows();
      if (!rows.length) { note($('docMsg'), '対象の申請がありません。', 'w'); return; }
      saveFile('立替経費精算書_' + ($('d_app').value || '全員') + '_' + S.today + '.html', buildHtml(rows), 'text/html;charset=utf-8');
    });
  });
})();
