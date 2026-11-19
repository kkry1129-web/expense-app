/**
 * app.js ― 立替・経費精算の画面の処理
 *
 * - データはすべて Apps Script の窓口（config.js の API_URL）から受け取る。通信は callApi の1か所だけ。
 * - 誰が何をできるか・状態の計算は、サーバー（Rules.gs）が正。
 *   画面はボタンの出し分けのために同じ決まりを真似するだけで、最終判断はサーバーに任せる。
 * - 画面はリアルタイムには更新しない。操作のあと・タブを切り替えたとき・「更新」を押したときに読み直す。
 * - 流用元：旧版 expense-app.html の card / renderSettle / buildCsv / buildHtml など。
 * - 2026-11-19 追加（経費・旅費規程）：出張・研修、自家用車の計算、事前連絡、代理入力、添付、
 *   原本受領、ほかの取締役の確認。金額の計算・判定の正はサーバー（Rules.gs）で、画面は同じ式で表示するだけ。
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

  // 金額の境目（Rules.gs の THRESH_ と同じ。直すときは両方そろえる）
  var TH = { notice: 10000, pre: 50000, quote: 500000, check: 50000 };
  // 宿泊上限が設定にないときの値（Rules.gs の HOTEL_CAP_DEFAULT_ と同じ）
  var HOTEL_CAP_DEFAULT = 12000;
  // 申請の種類・添付の種類の表示名（Rules.gs の KINDS_ / FILE_KINDS_ と同じ）
  var KIND_LABEL = { normal: '通常', trip: '出張・研修' };
  var FILE_KIND_LABEL = { chat: '事前連絡', receipt: '領収書' };
  var MAX_FILES = 6;
  // 添付する画像を縮める大きさ（長い辺のピクセル）と、PDF の上限（バイト）
  var IMG_MAX_PX = 1600;
  var PDF_MAX_BYTES = 5 * 1024 * 1024;

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
    payPeople: [],   // 精算タブの「まとめて支払済」の対象者（ボタンの番号 → 氏名）
    people: [],      // 代理入力で選べる申請者 [{ name, role }]（承認者にだけ届く）
    files: [],       // 申請欄で添付したファイル [{ id, name, kind }]
    uploading: false // 添付を保存中（終わるまで申請を送らない）
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

  /** 確認者（ほかの取締役）か。承認者は確認できない（Rules.gs の checker と同じ） */
  function isChecker() { return !!S.me && !!S.me.canCheck && S.me.role !== APPROVER_ROLE; }

  /** 0以上の整数の読み取り（Rules.gs の parseCount_ と同じ。空は0、不正は -1） */
  function parseCount(v) {
    var t = String(v == null ? '' : v)
      .replace(/[０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); })
      .replace(/[,，円\s]/g, '').replace(/km$/i, '').replace(/泊$/, '');
    if (t === '') return 0;
    var n = Number(t);
    return Number.isInteger(n) && n >= 0 ? n : -1;
  }

  /** 自家用車の単価（設定シートの値） */
  function mileRate() { return Number(S.settings && S.settings.mileRate) || 0; }
  /** 宿泊の上限（1泊） */
  function hotelCap() { return Number(S.settings && S.settings.hotelCap) || HOTEL_CAP_DEFAULT; }

  /** 1泊あたりの宿泊費（Rules.gs の perNight_ と同じ） */
  function perNight(e) {
    return e.stay && Number(e.nights) > 0 ? Math.round(Number(e.hotel) / Number(e.nights)) : 0;
  }

  /** 走行距離の内訳の文字（例：120km×20円＝¥2,400） */
  function kmText(km, rate) {
    return Number(km) > 0 ? Number(km) + 'km×' + Number(rate) + '円＝' + yen(Math.round(Number(km) * Number(rate))) : '';
  }

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
      S.people = data.people || [];
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
    S.people = [];
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

  /** 最初のログインのあとに1回だけ：区分・支払方法・代理入力の申請者の選択肢を作る */
  function setupForm() {
    opts($('f_cat'), S.settings.cats);
    opts($('f_pay'), S.settings.pays);
    fillApplicants();
    resetForm();
  }

  /** 代理入力の申請者の選択肢（承認者だけ） */
  function fillApplicants() {
    $('proxyBox').hidden = !isApprover() || !S.people.length;
    opts($('f_applicant'), S.people.map(function (p) { return p.name; }), '選んでください');
  }

  /** 申請欄の今の金額（出張・自家用車は計算した値）と内訳 */
  function formAmount() {
    var trip = $('f_kind').value === 'trip';
    var car = !trip && $('f_car').checked;
    if (!trip && !car) return { amount: parseAmt($('f_amt').value), calc: false };
    var km = parseCount($('f_km').value), other = parseCount($('f_other').value);
    var stay = trip && $('f_stay').checked;
    var nights = stay ? parseCount($('f_nights').value) : 0, hotel = stay ? parseCount($('f_hotel').value) : 0;
    var ok = km >= 0 && other >= 0 && nights >= 0 && hotel >= 0;
    var rate = mileRate();
    var amount = ok ? Math.round(km * rate) + hotel + other : 0;
    return { amount: amount, calc: true, ok: ok, km: km, other: other, nights: nights, hotel: hotel, stay: stay, rate: rate };
  }

  /**
   * 種類・金額・内容に応じて、欄と注意の表示を切り替える。
   * 規程の判定（事前連絡・事前承認・相見積・宿泊・確認）は Rules.gs と同じ条件で出す。
   */
  function formHints() {
    var trip = $('f_kind').value === 'trip';
    var car = !trip && $('f_car').checked;
    $('tripBox').hidden = !trip;
    $('normalBox').hidden = trip;
    $('calcBox').hidden = !(trip || car);
    $('amtBox').hidden = trip || car;
    $('stayBox').hidden = !(trip && $('f_stay').checked);
    $('otherLabel').textContent = trip ? 'その他の実費（交通費・高速代・駐車場代・受講料など／円）' : '高速代・駐車場代など（円）';
    $('memoLabel').textContent = trip ? '内容（経路・内訳など）' : '内容（何のための支出か具体的に）';

    // 代理入力
    var proxy = !$('proxyBox').hidden && $('f_proxy').checked;
    $('proxyWho').hidden = !proxy;
    $('whoLine').hidden = proxy;

    // 金額（出張・自家用車は計算して表示する）
    var fa = formAmount();
    if (fa.calc) {
      var parts = [];
      if (fa.km > 0) parts.push(kmText(fa.km, fa.rate));
      if (fa.hotel > 0) parts.push('宿泊費 ' + yen(fa.hotel));
      if (fa.other > 0) parts.push('実費 ' + yen(fa.other));
      $('calcSum').textContent = !fa.ok ? '数字を確かめてください（0以上の整数）。'
        : (fa.km > 0 && !fa.rate) ? '自家用車の単価が設定されていません。管理者に連絡してください。'
          : '金額：' + yen(fa.amount) + (parts.length ? '（' + parts.join('＋') + '）' : '');
      $('otherNote').textContent = car || trip ? '自家用車の単価は 1kmあたり ' + fa.rate + '円です（設定）。' : '';
    }
    var amt = fa.amount;

    // 宿泊（規程5条）
    var stayMsg = [];
    var over = false;
    if (trip && $('f_stay').checked) {
      stayMsg.push('宿泊を伴う出張は、事前に代表の承認が必要です。');
      var per = fa.nights > 0 && fa.hotel > 0 ? Math.round(fa.hotel / fa.nights) : 0;
      if (per > hotelCap()) {
        over = true;
        stayMsg.push('1泊 ' + yen(per) + ' は上限 ' + yen(hotelCap()) + ' を超えています。事前に代表の承認が必要です。');
      }
    }
    $('stayHint').innerHTML = stayMsg.length ? '<div class="note w">' + esc(stayMsg.join(' ')) + '</div>' : '';

    // 事前連絡・事前承認・相見積（規程3条）
    var preWhy = [];
    if (amt >= TH.pre) preWhy.push('5万円以上');
    if (trip && $('f_stay').checked) preWhy.push('宿泊を伴う出張');
    if (over) preWhy.push('宿泊費が上限超');
    $('wPre').hidden = !preWhy.length;
    $('preLabel').textContent = preWhy.join('・') + 'のため、支出前に代表の承認を得ている';
    $('wNotice').hidden = !(amt >= TH.notice && amt < TH.pre) || !$('wPre').hidden;
    $('wQuote').hidden = !(amt > TH.quote);

    // 飲食の注意
    var t = $('f_memo').value + ' ' + (trip ? $('f_dest').value : $('f_payee').value);
    $('memoHint').innerHTML = MEAL_WORDS.test(t) ? '<div class="note w">' + esc(MEAL_HINT) + '</div>' : '';

    // 関係者の名前が支払先にあれば、チェックを促す（自動では付けない）
    var payee = trip ? $('f_dest').value : $('f_payee').value;
    var hit = (S.settings && S.settings.related || []).filter(function (n) { return n && payee.indexOf(n) >= 0; });
    $('relatedHint').innerHTML = hit.length && !$('f_related').checked
      ? '<div class="note w">支払先に「' + esc(hit[0]) + '」が含まれています。関係者との取引なら、下の「関係者との取引」にチェックを付けてください。</div>' : '';

    // ほかの取締役の確認が要るか（Rules.gs の needCheck_ と同じ）
    var role = S.me ? S.me.role : '';
    if (S.editing) role = S.editing.role || role;
    else if (proxy) {
      var pick = S.people.filter(function (p) { return p.name === $('f_applicant').value; })[0];
      role = pick ? pick.role : '';
    }
    var need = (role === APPROVER_ROLE && amt >= TH.check) || $('f_related').checked;
    $('checkHint').innerHTML = need
      ? '<div class="note i">この申請は、ほかの取締役の確認が済んでから承認されます（規程3条2項）。</div>' : '';

    // 代理入力のときは、添付を促す（規程6条2項）
    if (proxy && !S.files.length) {
      note($('fileMsg'), '代理入力では、チャットの事前連絡と領収書の写真を添付してください。', 'w');
    } else if ($('fileMsg').dataset.keep !== '1') {
      note($('fileMsg'), '');
    }
  }

  /** 添付の一覧を描く（× で申請から外す。ドライブのファイルは残る） */
  function renderFiles() {
    $('fileList').innerHTML = S.files.map(function (f, i) {
      return '<span class="tag">' + esc(FILE_KIND_LABEL[f.kind] || f.kind) + '：' + esc(f.name) +
        ' <button class="link" data-fdel="' + i + '" title="外す" style="padding:0 2px">×</button></span>';
    }).join('');
    $('f_file').disabled = S.files.length >= MAX_FILES;
  }

  /** 申請欄を空に戻す（修正中ならやめる） */
  function resetForm() {
    S.editing = null;
    S.files = [];
    ['f_payee', 'f_amt', 'f_memo', 'f_dest', 'f_purpose', 'f_nights', 'f_hotel', 'f_km', 'f_other'].forEach(function (id) { $(id).value = ''; });
    $('f_date').value = S.today || '';
    $('f_date').max = S.today || '';
    $('f_from').value = S.today || '';
    $('f_to').value = S.today || '';
    $('f_from').max = S.today || '';
    $('f_to').max = S.today || '';
    $('f_kind').value = 'normal';
    $('f_kind').disabled = false;
    $('f_cat').selectedIndex = 0;
    $('f_pay').selectedIndex = 0;
    $('f_rc').value = 'paper';
    ['f_pre', 'f_quote', 'f_notice', 'f_related', 'f_stay', 'f_car', 'f_proxy'].forEach(function (id) { $(id).checked = false; });
    $('f_proxy').disabled = false;
    $('f_applicant').disabled = false;
    $('f_applicant').value = '';
    $('f_file').value = '';
    note($('fileMsg'), '');
    renderFiles();
    $('formTitle').textContent = '立替の申請';
    $('btnSubmit').textContent = '申請する';
    $('btnCancelEdit').hidden = true;
    formHints();
  }

  /** 一覧の「修正して再申請」：申請欄に今の内容を入れる */
  function startEdit(e) {
    var trip = e.kind === 'trip';
    // 確認が要るかの表示のため、申請者の役割を控える（代理入力の相手なら候補から探す）
    var who = S.people.filter(function (p) { return p.name === e.applicantName; })[0];
    S.editing = { id: e.id, rev: e.rev, role: e.proxy ? (who ? who.role : '') : (S.me ? S.me.role : '') };
    S.files = (e.files || []).slice();
    $('f_kind').value = trip ? 'trip' : 'normal';
    $('f_date').value = trip ? S.today : e.date;
    $('f_payee').value = trip ? '' : e.payee;
    $('f_amt').value = e.amount;
    $('f_dest').value = e.dest || '';
    $('f_purpose').value = e.purpose || '';
    $('f_from').value = e.tripFrom || S.today;
    $('f_to').value = e.tripTo || S.today;
    $('f_stay').checked = !!e.stay;
    $('f_nights').value = e.stay ? e.nights : '';
    $('f_hotel').value = e.stay ? e.hotel : '';
    $('f_car').checked = !!e.car;
    $('f_km').value = Number(e.km) > 0 ? e.km : '';
    $('f_other').value = Number(e.other) > 0 ? e.other : '';
    $('f_cat').value = e.cat;
    $('f_memo').value = e.memo;
    $('f_pay').value = e.pay;
    $('f_rc').value = e.receipt;
    $('f_pre').checked = !!e.pre;
    $('f_quote').checked = !!e.quote;
    $('f_notice').checked = !!e.notice;
    $('f_related').checked = !!e.related;
    // 代理入力の印と申請者は、修正では変えられない（表示だけ）
    $('f_proxy').checked = !!e.proxy;
    $('f_proxy').disabled = true;
    if (e.proxy) $('f_applicant').value = e.applicantName;
    $('f_applicant').disabled = true;
    renderFiles();
    $('formTitle').textContent = '修正して再申請（' + e.id + '）';
    $('btnSubmit').textContent = '再申請する';
    $('btnCancelEdit').hidden = false;
    formHints();
    note($('formMsg'), '');
    showTab('new');
  }

  /** 申請する／再申請する。入力の確かめはサーバーで行い、だめならその文面を出す */
  function submitForm() {
    if (S.uploading) { note($('formMsg'), '添付の保存が終わるまで待ってください。', 'w'); return; }
    var trip = $('f_kind').value === 'trip';
    var car = !trip && $('f_car').checked;
    var proxy = !S.editing && !$('proxyBox').hidden && $('f_proxy').checked;
    var value = {
      kind: trip ? 'trip' : 'normal',
      date: $('f_date').value,
      payee: $('f_payee').value,
      amount: $('f_amt').value,          // 全角・カンマなどの読み取りはサーバーで行う（出張・自家用車はサーバーが計算）
      cat: $('f_cat').value,
      memo: $('f_memo').value,
      pay: $('f_pay').value,
      receipt: $('f_rc').value,
      // 隠れているチェック欄は送らない（金額を下げたのにチェックが残る誤りを防ぐ）
      pre: $('f_pre').checked && !$('wPre').hidden,
      quote: $('f_quote').checked && !$('wQuote').hidden,
      notice: $('f_notice').checked && !$('wNotice').hidden,
      related: $('f_related').checked,
      car: car,
      km: trip || car ? $('f_km').value : '',
      other: trip || car ? $('f_other').value : '',
      files: S.files,
      proxy: proxy,
      applicantName: proxy ? $('f_applicant').value : ''
    };
    if (trip) {
      value.dest = $('f_dest').value;
      value.purpose = $('f_purpose').value;
      value.tripFrom = $('f_from').value;
      value.tripTo = $('f_to').value;
      value.stay = $('f_stay').checked;
      value.nights = value.stay ? $('f_nights').value : '';
      value.hotel = value.stay ? $('f_hotel').value : '';
    }
    if (proxy && !value.applicantName) { note($('formMsg'), '代理入力の申請者を選んでください。', 'b'); return; }
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
        note(msgEl, '申請しました（申請番号 ' + data.id + '）。' + (proxy ? '代理入力：' + value.applicantName + ' さんの申請です。' : '') +
          '領収書の裏面に申請番号を書いておくと、あとで照合しやすくなります。', 'o');
      }
    }).catch(function (err) { showError(err, msgEl); });
  }

  /* =====================================================================
   * 添付（画像は長い辺 1600px の JPEG に縮めてから送る）
   * ===================================================================== */

  /** ファイルを base64 にする（data: の前置きを除く） */
  function readAsBase64(blob) {
    return new Promise(function (ok, ng) {
      var r = new FileReader();
      r.onload = function () { ok(String(r.result).replace(/^data:[^,]*,/, '')); };
      r.onerror = function () { ng(new Error('ファイルを読み取れませんでした。')); };
      r.readAsDataURL(blob);
    });
  }

  /** 画像を縮めて JPEG にする。読めない形式（HEIC など）はエラー */
  function shrinkImage(file) {
    return new Promise(function (ok, ng) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var k = Math.min(1, IMG_MAX_PX / Math.max(img.naturalWidth, img.naturalHeight));
        var c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.naturalWidth * k));
        c.height = Math.max(1, Math.round(img.naturalHeight * k));
        var g = c.getContext('2d');
        g.fillStyle = '#fff'; // 透明な部分は白にする（JPEG は透明を持てないため）
        g.fillRect(0, 0, c.width, c.height);
        g.drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob(function (b) { b ? ok(b) : ng(new Error('画像を変換できませんでした。')); }, 'image/jpeg', 0.85);
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        ng(new Error('この画像は読み取れません。JPEG か PNG にしてから添付してください。'));
      };
      img.src = url;
    });
  }

  /** 選んだファイルを保存して、申請欄の添付に足す */
  function uploadFile() {
    var file = $('f_file').files && $('f_file').files[0];
    if (!file) return;
    var kind = $('f_fkind').value;
    var msg = $('fileMsg');
    if (S.files.length >= MAX_FILES) { note(msg, '添付は' + MAX_FILES + '件までです。', 'w'); return; }
    var isPdf = file.type === 'application/pdf';
    if (!isPdf && !/^image\//.test(file.type)) { note(msg, '添付できるのは画像と PDF だけです。', 'b'); return; }
    if (isPdf && file.size > PDF_MAX_BYTES) { note(msg, 'PDF が大きすぎます（5MBまで）。', 'b'); return; }
    S.uploading = true;
    msg.dataset.keep = '1';
    note(msg, '添付を保存しています…', 'i');
    (isPdf ? Promise.resolve(file) : shrinkImage(file)).then(function (blob) {
      return readAsBase64(blob).then(function (data) {
        return callApi('upload', { name: file.name, mime: isPdf ? 'application/pdf' : 'image/jpeg', data: data });
      });
    }).then(function (r) {
      S.files.push({ id: r.id, name: r.name, kind: kind });
      renderFiles();
      note(msg, '添付しました：' + r.name, 'o');
    }).catch(function (err) {
      if (err && err.auth) showLogin(err.message);
      note(msg, err && err.message, 'b');
    }).finally(function () {
      S.uploading = false;
      msg.dataset.keep = '';
      $('f_file').value = '';
    });
  }

  /**
   * 添付を開く。先に空のタブを開いておき（ポップアップの防止に止められないため）、届いたら中身を表示する。
   */
  function openFile(id) {
    var w = window.open('', '_blank');
    if (w) w.document.write('<p style="font-family:sans-serif">読み込んでいます…</p>');
    callApi('file', { id: id }).then(function (r) {
      var bin = atob(r.data), arr = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      var url = URL.createObjectURL(new Blob([arr], { type: r.mime }));
      if (w) w.location.href = url;
      else window.location.href = url;
      setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
    }).catch(function (err) {
      if (w) w.close();
      showError(err);
    });
  }

  /* =====================================================================
   * 一覧タブ
   * ===================================================================== */

  /**
   * 申請1件のカード。操作ボタンは Rules.gs の ACTIONS_ と同じ条件で出す：
   *   承認・差戻し … 承認者、申請中のとき
   *   支払済・承認取消 … 承認者、承認済のとき
   *   修正・取下げ … 申請した本人か代理で入力した人、申請中か差戻しのとき
   *   確認 … 確認者（承認者・申請者本人を除く）、確認が要る申請中のもの
   *   原本受領・受領取消 … 承認者、領収書が「原本あり」で取下げ以外
   */
  function card(e) {
    var st = e.status, b = ST[st] || [st, 'b-m'], id = esc(e.id);
    var waitCheck = e.needCheck && !e.checked;
    var act = '';
    if (isChecker() && st === 'pending' && waitCheck && !e.mine) {
      act += '<div class="row"><button class="btn" data-act="confirm" data-id="' + id + '">取締役として確認する</button></div>';
    }
    if (isApprover() && st === 'pending') {
      act += '<input id="n_' + id + '" maxlength="500" placeholder="差戻し理由（差し戻す場合のみ入力）" style="margin-top:10px">' +
        '<div class="row">' + (waitCheck ? '<span class="mute">ほかの取締役の確認が済むと承認できます。</span>'
          : '<button class="btn" data-act="approve" data-id="' + id + '">承認</button>') +
        '<button class="btn bad" data-act="reject" data-id="' + id + '">差戻し</button></div>';
    }
    if (isApprover() && st !== 'withdrawn' && e.receipt === 'paper') {
      act += e.origAt
        ? '<div class="row"><button class="btn ghost" data-act="unreceive" data-id="' + id + '">原本受領を取り消す</button></div>'
        : '<div class="row"><input id="o_' + id + '" type="date" value="' + esc(S.today) + '" style="max-width:180px">' +
          '<button class="btn ghost" data-act="receive" data-id="' + id + '">原本を受け取った</button></div>';
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
    var tags = (e.kind === 'trip' ? '<span class="tag">出張・研修</span>' : '') +
      (e.proxy ? '<span class="tag">代理入力（入力：' + esc(e.enteredByName) + '）</span>' : '') +
      (e.related ? '<span class="tag">関係者との取引</span>' : '');
    var info = detailText(e).map(function (t) { return '<div class="meta">' + esc(t) + '</div>'; }).join('');
    var files = (e.files || []).map(function (f) {
      return '<button class="fbtn" data-act="file" data-fid="' + esc(f.id) + '">📎 ' + esc(FILE_KIND_LABEL[f.kind] || f.kind) + '：' + esc(f.name) + '</button>';
    }).join('');
    return '<div class="card' + (st === 'withdrawn' ? ' dim' : '') + '">' +
      '<div class="h"><div><div class="no">' + id + ' ・ ' + esc(e.date) + (e.rev > 1 ? ' ・ 修正' + (e.rev - 1) + '回' : '') + '</div>' +
      '<div class="pay">' + esc(e.payee) + '</div></div><div class="amt">' + yen(e.amount) + '</div></div>' +
      (tags ? '<div style="margin-top:4px">' + tags + '</div>' : '') +
      '<div class="meta">' + esc(e.cat) + ' ・ 申請者 ' + esc(e.applicantName) + ' ・ ' + esc(e.pay) + ' ・ 領収書 ' + esc(RC[e.receipt] || e.receipt) + '</div>' +
      info +
      '<div class="memo">' + esc(e.memo) + '</div>' +
      (files ? '<div>' + files + '</div>' : '') +
      '<div style="margin-top:8px"><span class="badge ' + b[1] + '">' + esc(b[0]) + '</span> ' + flags + '</div>' +
      extra + act + '</div>';
  }

  /**
   * 申請の内訳の文（一覧・精算書で使う）：出張の行き先・日程・宿泊、走行距離、確認、原本受領
   */
  function detailText(e) {
    var t = [];
    if (e.kind === 'trip') {
      t.push('目的：' + e.purpose + ' ／ 日程：' + e.tripFrom + (e.tripTo !== e.tripFrom ? '〜' + e.tripTo : ''));
      if (e.stay) t.push('宿泊：' + e.nights + '泊 ' + yen(e.hotel) + '（1泊 ' + yen(perNight(e)) + '）');
    }
    var calc = [];
    if (Number(e.km) > 0) calc.push('自家用車 ' + kmText(e.km, e.mileRate));
    if (Number(e.other) > 0) calc.push('実費 ' + yen(e.other));
    if (calc.length) t.push(calc.join(' ＋ '));
    if (e.needCheck) t.push(e.checked ? '取締役の確認：' + e.checkBy + '（' + dstr(e.checkAt) + '）' : '取締役の確認：未');
    if (e.origAt) t.push('原本受領：' + e.origAt + '（' + e.origBy + '）');
    return t;
  }

  function renderList() {
    var app = $('l_app').value;
    var rows = S.expenses.filter(function (e) {
      if (app && e.applicantName !== app) return false;
      if (S.filter === 'all') return true;
      // 確認待ち・原本未受領は、状態ではなく注意印で絞る
      if (S.filter === 'check') return e.status === 'pending' && e.needCheck && !e.checked;
      if (S.filter === 'orig') return (e.flags || []).indexOf('原本未受領') >= 0;
      return e.status === S.filter;
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

      // 原本未受領（月末に手渡しでもらう分。規程6条2項）
      var orig = S.expenses.filter(function (e) { return (e.flags || []).indexOf('原本未受領') >= 0; })
        .sort(function (a, b) { return a.seq - b.seq; });
      h += '<div class="card"><h3>原本未受領（' + orig.length + '件）</h3>' + (orig.length
        ? '<div class="scroll"><table><tr><th>番号</th><th>申請者</th><th>日付</th><th>支払先</th><th class="r">金額</th></tr>' +
          orig.map(function (e) {
            return '<tr><td>' + esc(e.id) + '</td><td>' + esc(e.applicantName) + '</td><td>' + esc(e.date) + '</td><td>' + esc(e.payee) +
              '</td><td class="r">' + yen(e.amount) + '</td></tr>';
          }).join('') + '</table></div><div class="mute" style="margin-top:6px">受け取ったら、一覧の「原本を受け取った」を押してください。</div>'
        : '<div class="empty" style="padding:8px 0">ありません</div>') + '</div>';
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
      '状態', '承認日', '承認者', '支払日', '振込メモ', '差戻し理由', '申請日',
      // 2026-11-19 追加（経費・旅費規程）
      '種類', '行き先', '目的', '日程（開始）', '日程（終了）', '宿泊', '泊数', '宿泊費', '走行距離(km)', '単価(円/km)', 'その他の実費',
      '事前連絡', '関係者取引', '代理入力', '入力者', '確認者', '確認日', '原本受領日', '添付数'];
    var lines = [head.map(csvCell).join(',')];
    S.expenses.slice().sort(function (a, b) { return a.seq - b.seq; }).forEach(function (e) {
      var s = e.status, ok = (s === 'approved' || s === 'paid'), trip = e.kind === 'trip';
      lines.push([e.id, e.rev, e.applicantName, e.date, e.payee, e.cat, e.memo, e.amount, e.pay, RC[e.receipt] || e.receipt,
        e.pre ? 'あり' : '', e.quote ? 'あり' : '', ST[s][0],
        ok ? dstr(e.apAt) : '', ok ? e.apBy : '', s === 'paid' ? e.paidDate : '', s === 'paid' ? e.ref : '',
        s === 'rejected' ? e.note : '', dstr(e.createdAt),
        KIND_LABEL[e.kind] || '通常', trip ? e.dest : '', trip ? e.purpose : '', trip ? e.tripFrom : '', trip ? e.tripTo : '',
        e.stay ? 'あり' : '', e.stay ? e.nights : '', e.stay ? e.hotel : '',
        Number(e.km) > 0 ? e.km : '', Number(e.km) > 0 ? e.mileRate : '', Number(e.other) > 0 ? e.other : '',
        e.notice ? 'あり' : '', e.related ? 'あり' : '', e.proxy ? 'あり' : '', e.enteredByName || '',
        e.checked ? e.checkBy : '', e.checked ? dstr(e.checkAt) : '', e.origAt || '', (e.files || []).length
      ].map(csvCell).join(','));
    });
    return '﻿' + lines.join('\r\n');
  }

  /** 精算書（印刷用HTML）。会社名・承認者名は設定シートの値を使う */
  function buildHtml(rows) {
    var app = $('d_app').value || '全員', from = $('d_from').value, to = $('d_to').value;
    var tot = rows.reduce(function (a, e) { return a + e.amount; }, 0);
    var ats = rows.map(function (e) { return e.apAt; }).filter(Boolean).sort();
    var body = rows.map(function (e) {
      // 内容の欄に、出張の内訳・確認・原本受領を添える
      var memo = esc(e.memo) + detailText(e).map(function (t) { return '<br><span style="color:#555">' + esc(t) + '</span>'; }).join('') +
        (e.proxy ? '<br><span style="color:#555">代理入力（入力：' + esc(e.enteredByName) + '）</span>' : '');
      return '<tr><td>' + esc(e.id) + '</td><td>' + esc(e.date) + '</td><td>' + esc(e.payee) + '</td><td>' + esc(e.cat) + '</td><td>' + memo +
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
      '<div class="m">領収書の原本（電子データは電子のまま）は別途保管しています（経費・旅費規程 第7条）。番号は領収書に付記した申請番号と対応します。</div>' +
      '<div class="m">代表自身の5万円以上の支出と関係者との取引は、ほかの取締役1名が確認しています（同 第3条2項）。</div>' +
      '<div class="sig"><div>承認印</div><div>確認印</div><div>受領印</div></div></body></html>';
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
    if (a === 'file') { openFile(b.dataset.fid); return; }
    if (!e) return;

    if (a === 'confirm') {
      act('confirm', { id: e.id, rev: e.rev }, e.id + ' を確認しました。');
    } else if (a === 'receive') {
      act('receive', { id: e.id, rev: e.rev, date: val('o_' + e.id) || S.today }, e.id + ' の原本受領を記録しました。');
    } else if (a === 'unreceive') {
      if (!armed(b)) return;
      act('unreceive', { id: e.id, rev: e.rev }, e.id + ' の原本受領を取り消しました。');
    } else if (a === 'approve') {
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

    ['f_amt', 'f_memo', 'f_payee', 'f_dest', 'f_km', 'f_other', 'f_nights', 'f_hotel'].forEach(function (id) { $(id).addEventListener('input', formHints); });
    ['f_kind', 'f_stay', 'f_car', 'f_proxy', 'f_applicant', 'f_related'].forEach(function (id) { $(id).addEventListener('change', formHints); });
    $('f_file').addEventListener('change', uploadFile);
    $('fileList').addEventListener('click', function (ev) {
      var b = ev.target.closest('button[data-fdel]');
      if (!b) return;
      S.files.splice(Number(b.dataset.fdel), 1);
      renderFiles();
      formHints();
    });
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
