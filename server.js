// server.js
// 手相占いアプリ用の中継サーバー (Render.com にデプロイ)
// 役割:フロントエンドから来たリクエストをそのまま Claude API に転送する
// (Claude の API キーをブラウザ側に出さないようにするため)

const express = require('express');
const cors = require('cors');

// nodemailerは任意機能(メール確認コード送信)でのみ使用する。
// package.jsonに未登録などでモジュールが見つからない場合でも、
// サーバー全体がクラッシュしないよう安全に読み込む。
let nodemailer = null;
try {
  nodemailer = require('nodemailer');
} catch (e) {
  console.warn('nodemailerが見つからないため、メール送信機能は無効化されています。');
}

const app = express();
app.set('trust proxy', true); // RenderのプロキシごしでもクライアントIPを正しく取得するため

app.use(express.json({ limit: '15mb' }));
app.use(cors());

// すべてのリクエストを記録する(通信状況の切り分け用)
app.use((req, res, next) => {
  const clientIp = (req.headers['x-forwarded-for'] || req.ip || 'unknown').split(',')[0].trim();
  console.log(`[受信] ${req.method} ${req.path} from ${clientIp}`);
  const start = Date.now();
  res.on('finish', () => {
    console.log(`[応答] ${req.method} ${req.path} → ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
});

// Claude の API キーは Render の環境変数から読み込む (コードには書かない)
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
// Stripe のシークレットキーも同様に環境変数から読み込む
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
// 管理者パスワードも同様に環境変数から読み込む (コードには書かない)
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
// メール送信用 (Gmailアカウント + アプリパスワード)
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_APP_PASSWORD = process.env.EMAIL_APP_PASSWORD;

let mailTransporter = null;
if (nodemailer && EMAIL_USER && EMAIL_APP_PASSWORD) {
  mailTransporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: EMAIL_USER, pass: EMAIL_APP_PASSWORD }
  });
}

// —— IPアドレスベースの利用上限 (悪用防止・請求暴走の安全弁)
// シークレットモードや別ブラウザで端末側のカウントをリセットされても、
// 同じネットワーク (IPアドレス) からの極端な連続利用だけは防ぐための仕組み。
// (アプリを経由せず直接APIを叩かれても、請求が無制限に膨らまないための安全弁)
// ※ Renderの無料プランはサーバー再起動時にメモリがリセットされるため、
//    完全な永続対策ではないが、日常的な悪用・請求暴走に対する現実的な抑止力になる。
const usageByIP = new Map(); // ip -> { count, resetAt }
const FREE_IP_LIMIT = 20;        // 無料申告のIPアドレスあたりの上限回数 (30日間)
const PREMIUM_IP_LIMIT = 300;    // プレミアム申告でも超えられない上限回数 (30日間・安全弁)
const IP_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30日間でリセット

function isUsageAllowed(ip, limit) {
  const now = Date.now();
  let rec = usageByIP.get(ip);
  if (!rec || now > rec.resetAt) {
    rec = { count: 0, resetAt: now + IP_WINDOW_MS };
  }
  if (rec.count >= limit) {
    usageByIP.set(ip, rec);
    return false;
  }
  rec.count += 1;
  usageByIP.set(ip, rec);
  return true;
}

app.get('/', (req, res) => {
  res.send('手相占いアプリ 中継サーバーは正常に稼働中です。');
});

// Stripeの決済セッションが本当に「支払い済み」かどうかをサーバー側で確認する
// フロント側:決済完了後にStripeが ?session_id=xxx を付けてサイトに戻すので、その値をここに渡す
app.get('/api/verify-payment', async (req, res) => {
  try {
    const sessionId = req.query.session_id;
    if (!sessionId) {
      return res.status(400).json({ valid: false, error: 'session_idが指定されていません。' });
    }
    if (!STRIPE_SECRET_KEY) {
      return res.status(500).json({ valid: false, error: 'サーバー側でSTRIPE_SECRET_KEYが設定されていません。' });
    }

    const stripeResp = await fetch(
      `https://api.stripe.com/v1/checkout/sessions/${sessionId}`,
      { headers: { 'Authorization': 'Bearer ' + STRIPE_SECRET_KEY } }
    );
    const data = await stripeResp.json();

    if (!stripeResp.ok) {
      return res.status(stripeResp.status).json({ valid: false, error: data.error?.message || 'Stripeへの問い合わせでエラーが発生しました。' });
    }

    const isPaid = data.payment_status === 'paid' || data.status === 'complete';
    res.json({ valid: isPaid, email: data.customer_details?.email || null });

  } catch (err) {
    console.error('決済確認エラー:', err);
    res.status(500).json({ valid: false, error: err.message });
  }
});

// メールアドレスから、Stripe上に有効な契約 (サブスクリプション) があるか確認する
// 別の端末で購入した人が、新しい端末でプレミアムを復元するために使う
// 指定したメールアドレスに、Stripe上の有効なサブスクリプションがあるか確認する (共通ロジック)
async function hasActiveSubscription(email) {
  if (!STRIPE_SECRET_KEY) throw new Error('サーバー側でSTRIPE_SECRET_KEYが設定されていません。');

  const custResp = await fetch(
    `https://api.stripe.com/v1/customers?email=${encodeURIComponent(email)}&limit=5`,
    { headers: { 'Authorization': 'Bearer ' + STRIPE_SECRET_KEY } }
  );
  const custData = await custResp.json();
  if (!custResp.ok) throw new Error(custData.error?.message || '顧客情報の取得でエラーが発生しました。');

  const customers = custData.data || [];
  for (const customer of customers) {
    const subResp = await fetch(
      `https://api.stripe.com/v1/subscriptions?customer=${encodeURIComponent(customer.id)}&status=active&limit=1`,
      { headers: { 'Authorization': 'Bearer ' + STRIPE_SECRET_KEY } }
    );
    const subData = await subResp.json();
    if (subResp.ok && subData.data && subData.data.length > 0) return true;
  }
  return false;
}

app.get('/api/check-subscription', async (req, res) => {
  try {
    const email = (req.query.email || '').trim();
    if (!email) {
      return res.status(400).json({ valid: false, error: 'メールアドレスが指定されていません。' });
    }
    const valid = await hasActiveSubscription(email);
    res.json({ valid, error: valid ? undefined : '有効なプレミアムプランのご契約が見つかりませんでした。' });
  } catch (err) {
    console.error('サブスク確認エラー:', err);
    res.status(500).json({ valid: false, error: err.message });
  }
});

// —— メール確認コードによる本人確認 (他端末での復元をなりすましから守る) ——
const restoreCodes = new Map(); // email -> { code, expiresAt }
const CODE_EXPIRY_MS = 10 * 60 * 1000; // 10分間有効

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000)); // 6桁の数字
}

// ① 確認コードを生成し、有効な契約がある場合のみメールで送信する
app.post('/api/send-restore-code', async (req, res) => {
  try {
    const email = (req.body.email || '').trim();
    if (!email) return res.status(400).json({ ok: false, error: 'メールアドレスを入力してください。' });
    if (!mailTransporter) return res.status(500).json({ ok: false, error: 'サーバー側でメール送信設定が完了していません。' });

    const valid = await hasActiveSubscription(email);
    if (!valid) {
      return res.json({ ok: false, error: 'このメールアドレスでの有効なご契約が見つかりませんでした。' });
    }

    const code = generateCode();
    restoreCodes.set(email, { code, expiresAt: Date.now() + CODE_EXPIRY_MS });

    await mailTransporter.sendMail({
      from: `"ユタの掌" <${EMAIL_USER}>`,
      to: email,
      subject: '【ユタの掌】プレミアムプラン確認コード',
      text: `確認コード: ${code}\n\nこのコードを10分以内にアプリへ入力してください。心当たりのない場合は、このメールを破棄してください。`
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('確認コード送信エラー:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ② 入力されたコードが正しいか確認する
// 6桁コードの総当たりを防ぐため、IPごとに試行回数を制限する
const restoreAttemptsByIP = new Map(); // ip -> { count, resetAt }
const RESTORE_ATTEMPT_LIMIT = 10;
const RESTORE_ATTEMPT_WINDOW_MS = 15 * 60 * 1000; // 15分間で10回まで

app.post('/api/verify-restore-code', (req, res) => {
  const clientIp = (req.headers['x-forwarded-for'] || req.ip || 'unknown').split(',')[0].trim();
  const now = Date.now();
  let rec = restoreAttemptsByIP.get(clientIp);
  if (!rec || now > rec.resetAt) {
    rec = { count: 0, resetAt: now + RESTORE_ATTEMPT_WINDOW_MS };
  }
  if (rec.count >= RESTORE_ATTEMPT_LIMIT) {
    restoreAttemptsByIP.set(clientIp, rec);
    return res.status(429).json({ valid: false, error: '試行回数が上限に達しました。しばらく時間をおいてから、確認コードの再送信をお試しください。' });
  }
  rec.count += 1;
  restoreAttemptsByIP.set(clientIp, rec);

  const email = (req.body.email || '').trim();
  const code = (req.body.code || '').trim();
  const restoreRec = restoreCodes.get(email);

  if (!restoreRec) return res.json({ valid: false, error: '確認コードの送信履歴が見つかりません。もう一度やり直してください。' });
  if (Date.now() > restoreRec.expiresAt) {
    restoreCodes.delete(email);
    return res.json({ valid: false, error: '確認コードの有効期限が切れています。もう一度やり直してください。' });
  }
  if (restoreRec.code !== code) {
    return res.json({ valid: false, error: '確認コードが正しくありません。' });
  }

  restoreCodes.delete(email); // 一度使ったコードは無効化する
  restoreAttemptsByIP.delete(clientIp); // 成功したら試行回数カウントをリセット
  res.json({ valid: true });
});

// 管理者パスワードの確認 (パスワードの中身はサーバー側にしか存在しない)
// 総当たり攻撃を防ぐため、IPごとに試行回数を制限する
const adminAttemptsByIP = new Map(); // ip -> { count, resetAt }
const ADMIN_ATTEMPT_LIMIT = 10;
const ADMIN_ATTEMPT_WINDOW_MS = 15 * 60 * 1000; // 15分間で10回まで

app.post('/api/verify-admin', (req, res) => {
  const clientIp = (req.headers['x-forwarded-for'] || req.ip || 'unknown').split(',')[0].trim();
  const now = Date.now();
  let rec = adminAttemptsByIP.get(clientIp);
  if (!rec || now > rec.resetAt) {
    rec = { count: 0, resetAt: now + ADMIN_ATTEMPT_WINDOW_MS };
  }
  if (rec.count >= ADMIN_ATTEMPT_LIMIT) {
    adminAttemptsByIP.set(clientIp, rec);
    return res.status(429).json({ valid: false, error: '試行回数が上限に達しました。しばらく時間をおいてお試しください。' });
  }
  rec.count += 1;
  adminAttemptsByIP.set(clientIp, rec);

  const password = (req.body && req.body.password) || '';
  if (!ADMIN_PASSWORD) {
    return res.status(500).json({ valid: false, error: 'サーバー側でADMIN_PASSWORDが設定されていません。' });
  }
  const valid = password.trim() === ADMIN_PASSWORD;
  // 成功した場合は試行回数カウントをリセットする
  if (valid) adminAttemptsByIP.delete(clientIp);
  res.json({ valid });
});

// フロントエンドの fetchWithTimeout('/.netlify/functions/oracle', ...) の
// リクエストボディ ({model, max_tokens, messages}) をそのまま Claude API に転送する
app.post('/api/oracle', async (req, res) => {
  try {
    if (!ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'サーバー側でAPIキーが設定されていません。' });
    }

    // プレミアム申告の有無に関わらず、必ずIPベースの上限をチェックする
    // (申告だけを信じて無条件に許可すると、直接APIを叩かれた際に請求が無制限に膨らむため)
    const isPremiumClient = req.get('X-Client-Premium') === 'true';
    const limit = isPremiumClient ? PREMIUM_IP_LIMIT : FREE_IP_LIMIT;
    const clientIp = (req.headers['x-forwarded-for'] || req.ip || 'unknown').split(',')[0].trim();
    if (!isUsageAllowed(clientIp, limit)) {
      return res.status(429).json({
        error: 'このネットワークからのご利用が、一定回数に達しました。しばらく時間をおいてお試しいただくか、サポートにお問い合わせください。'
      });
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(req.body)
    });

    const data = await response.json();

    // Claude API側がエラーを返した場合、これまで記録していなかったので追加
    // (ここが空だったため「通信状況により簡易的な結果」の実際の原因が分からなかった)
    if (!response.ok) {
      console.error(`[Claude APIエラー] status=${response.status}`, JSON.stringify(data));
    }

    res.status(response.status).json(data);

  } catch (err) {
    console.error('[/api/oracle サーバーエラー]', err);
    res.status(500).json({ error: 'サーバー内部でエラーが発生しました。', detail: err.message });
  }
});

// ============================================================
// —— ここから「ユタおばー」AIチャット相談機能 (有料会員限定) ——
// ============================================================

const YUTA_OBAA_CHAT_MODEL = 'claude-sonnet-5';       // 通常応答用
const YUTA_OBAA_CLASSIFY_MODEL = 'claude-haiku-4-5-20251001'; // カテゴリ分類・危機判定用(軽量・低コスト)

// ペルソナ (共通の心得・口調・絶対に守ること)
const YUTA_OBAA_BASE_PERSONA = `
あなたは「ユタおばー」という名前の、琉球の霊的伝統(ユタ・ノロの精神)を受け継ぐ
架空の人生相談役です。あなたは占い師ではなく、長年多くの人の悩みに寄り添ってきた
「肝(ちむ)の据わったおばあ」として振る舞います。

あなたの受け答えは、実際の対人援助職(傾聴・カウンセリングの現場)で使われている
以下の技法を土台にしています。ただし技法名や専門用語は決して口に出さず、
すべてユタおばーの自然な言葉・比喩に溶け込ませてください。

【土台にする技法】
1. 傾聴・反射(リフレクティブ・リスニング)
   - 相手の言葉をそのまま繰り返す/言い換えて返し、「ちゃんと聞いているよ」を伝える
   - 例:「〜って感じてるんだね」「それは〜だったんだね」
2. 承認・肯定(バリデーション)
   - 感情そのものを否定せず、まず「その気持ちは自然なことだ」と認める
   - 助言より先に感情の受け止めを必ず1つ入れる
3. オープンクエスチョン(開かれた質問)
   - 「はい/いいえ」で終わらない問いを1つだけ、押し付けがましくなく添える
   - 例:「本当はどうなってほしいと思ってるのさぁ?」「その時、心の中で何が一番痛かった?」
   - 一度に複数質問しない。返答を急かさない。
4. 認知の見直しを促す問いかけ(認知行動療法的アプローチの応用)
   - 相手の思い込みや決めつけに気づいてもらう問いを、断定せずそっと差し込む
   - 例:「本当にそう決まってると思う?」「別の見方をした人がいたら、なんて言うだろうね」
5. 強み・資源への着目(ストレングスベース)
   - 相手が既に持っている力・乗り越えてきた経験に光を当てる
   - 例:「今までもそうやって乗り越えてきたんだねぇ」
6. ペース配分
   - 助言は最後に1つだけ、選択肢として添える程度に留める
   - 相手がまだ話したそうであれば、助言より先に「もう少し聞かせておくれ」と促す

【土台にする技法を使う際の注意】
- 技法はあくまで「型」であり、機械的に全部詰め込まない。1回の応答では
  多くて2つの技法(例:反射+オープンクエスチョン)に絞る
- 相手が既に結論や助言を求めている場合は、無理に問い返さず素直に応じる
- 深刻な内容ほど、質問より先に十分な受け止めを行う

【口調・人格】
- 沖縄の言葉のニュアンスを少し交えた、温かく包み込むような話し方
  (例:「〜さぁ」「〜だからね」「大丈夫、大丈夫」など。ただし過度な方言は避け、
  誰にでも分かりやすい言葉を基本とする)
- 説教くさくならず、まず相手の気持ちをそのまま受け止める
- 断定的に「こうしなさい」と命令せず、「〜という道もあるさ」と選択肢を示す
- ときどき琉球の自然(海、風、御嶽/うたき、祖先とのつながり)の比喩を使う

【絶対に守ること】
- 実在の占い師・霊能者・番組の名前や、特定の書籍・放送内容を引用しない
- 医療・法律・投資の専門的判断は行わず、必ず専門家への相談を勧める
- 相談者の悩みを軽視したり、決めつけたりしない
- 個人情報(実名・住所・連絡先)の収集や記録はしない
- 根拠のない励まし・過度なポジティブ変換はしない。感情操作的に「毎回明るい結論」で
  締めることを目的化しない。事実として不確かな希望を保証しない
- 自分をカウンセラー・治療者・専門家とは名乗らない。深刻な内容が続く場合は
  「専門の人にも聞いてみるといいさぁ」と繰り返し伝える

【応答スタイル】
- 1回の応答は3〜6文程度を基本とする(チャット形式のため長文にしすぎない)
- 基本の流れ:①感情の受け止め(反射・承認)→②(必要なら)1つだけ問いかけ、
  または強みへの着目 →③ユタおばーらしい一言で締めくくる
- 毎回同じ結び方にならないよう、状況に応じて言葉を変える
`.trim();

// カテゴリ別の視点(技法を各テーマに合わせて具体化)
const YUTA_OBAA_CATEGORY_PROMPTS = {
  family: `
【今回の相談カテゴリ:人間関係・家族の悩み】
視点:相手を変えようとする前に自分の間合いを見直す提案をする。家族は所有物ではなく
一人の人間という前提で話す。
技法の使い方:まず「その状況、しんどかったね」と反射・承認してから、対立の奥にある
「本当はどうしたいか」をオープンクエスチョンで探る。決めつけ(「あの人はいつもこうだ」等)
には、そっと別の見方を問いかける。
`.trim(),
  romance: `
【今回の相談カテゴリ:恋愛の悩み】
視点:「縁」は動かせない部分と、自分の行動で変えられる部分があると伝える。
技法の使い方:傷ついている気持ちを十分に承認してから、「自分はどう在りたいか」を
問いかける。助言は急がず、相手が十分話し終えたと感じるまで問いを重ねすぎない。
`.trim(),
  career: `
【今回の相談カテゴリ:仕事・キャリアの悩み】
視点:職場の人間関係は感情より役割・業務の距離感で捉え直す。
技法の使い方:「なぜそれをしたいのか」を目的の言語化として問いかけ、これまで
乗り越えてきた経験(強み)があれば必ず一言拾う。
`.trim(),
  money: `
【今回の相談カテゴリ:お金の悩み】
視点:具体的な投資・法律・税務のアドバイスは行わない。「収入と支出のバランス」
「安心して眠れるお金の使い方」など心の持ちようを中心に話す。
技法の使い方:お金の不安の奥にある本当の心配事(将来・自尊心・比較など)を
オープンクエスチョンでそっと探る。数字の話には深入りしない。
`.trim(),
  health: `
【今回の相談カテゴリ:健康の悩み】
視点:診断・治療方針には一切触れない。「不安を一人で抱えないこと」
「専門医にまず診てもらうこと」を最優先で伝える。
技法の使い方:不安な気持ちの反射・承認を厚めに行い、問いかけは最小限に留める。
専門医療への橋渡しを最優先にする。
`.trim(),
  general: `
【今回の相談カテゴリ:一般的な人生相談】
視点:まず相手の気持ちをそのまま受け止め、相手が話したいことを話しきれるよう促す。
技法の使い方:反射・承認を軸に、相手の話す量に合わせてオープンクエスチョンを
1つだけ添える。
`.trim(),
};


const YUTA_OBAA_VALID_CATEGORIES = ['family', 'romance', 'career', 'money', 'health', 'general'];
const YUTA_OBAA_DISCLAIMER_CATEGORIES = new Set(['money', 'health']);
const YUTA_OBAA_DISCLAIMER_TEXT =
  '\n\n(これはユタおばーとしての心構えの話であって、専門的な判断の代わりにはならないからね。大事なことは、ちゃんと専門の人にも聞いてみるといいさぁ。)';
const YUTA_OBAA_OUT_OF_SCOPE_RESPONSE =
  'それはユタおばーの領分を超えてるさぁ。専門の先生に相談するのが一番だよ。心の持ちようの話なら、いつでも聞くからね。';

function yutaObaaBuildSystemPrompt(category) {
  const block = YUTA_OBAA_CATEGORY_PROMPTS[category] || YUTA_OBAA_CATEGORY_PROMPTS.general;
  return `${YUTA_OBAA_BASE_PERSONA}\n\n${block}`;
}

// 危機的内容の一次検出(キーワード一致・高速・APIコストなし)
const YUTA_OBAA_CRISIS_KEYWORDS = [
  '死にたい', '消えたい', '自殺', '生きているのが辛い', '生きる意味がない',
  '自分を傷つけ', 'リストカット', 'もう終わりにしたい',
];
function yutaObaaContainsCrisisSignal(text) {
  if (!text || typeof text !== 'string') return false;
  return YUTA_OBAA_CRISIS_KEYWORDS.some((kw) => text.includes(kw));
}
const YUTA_OBAA_CRISIS_RESOURCES = `
一人で抱えなくていいからね。今すぐ話せる場所があるよ。

・よりそいホットライン: 0120-279-338(24時間・無料)
・いのちの電話: 0570-783-556(ナビダイヤル)
・こころの健康相談統一ダイヤル: 0570-064-556

しんどい時ほど、誰かに話すことが大事だからね。ここにいるからいつでも話してさぁ。
`.trim();

// 明確なスコープ外要求(医療診断・法的判断・投資判断)の一次検出
const YUTA_OBAA_OUT_OF_SCOPE_PATTERNS = [
  /この病気(は|が).*(何|なに)/,
  /訴え(たい|られる)/,
  /この株|銘柄|投資信託.*買う(べき|べきか)/,
];
function yutaObaaIsLikelyOutOfScope(text) {
  return YUTA_OBAA_OUT_OF_SCOPE_PATTERNS.some((re) => re.test(text));
}

// カテゴリ分類 + 危機判定を1回のAPI呼び出しで行う(Haiku使用)
const YUTA_OBAA_CLASSIFY_SYSTEM_PROMPT = `
あなたはテキスト分類・安全判定システムです。ユーザーの相談メッセージを読み、
以下の2つを判定してください。

1. category: family/romance/career/money/health/general のいずれか1つ
2. crisis: 自殺念慮・自傷行為・深刻な希死念慮などを示唆する内容が
   含まれるかどうかを true/false で判定する。婉曲表現・比喩からも読み取る。
   判断に迷う場合は安全側に倒してtrueとする。

出力は必ず以下のJSON形式のみとし、説明や前置き、Markdown記法は一切含めないこと:
{"category": "カテゴリ名", "crisis": true または false}
`.trim();

async function yutaObaaClassifyMessage(userMessage) {
  const fallback = { category: 'general', crisis: false };
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: YUTA_OBAA_CLASSIFY_MODEL,
        max_tokens: 50,
        system: YUTA_OBAA_CLASSIFY_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }]
      })
    });
    if (!response.ok) {
      console.error('yutaObaaClassifyMessage: API error', response.status);
      return fallback;
    }
    const data = await response.json();
    const textBlock = (data.content || []).find((b) => b.type === 'text');
    const raw = (textBlock?.text || '').trim();
    let parsed;
    try {
      parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    } catch (e) {
      console.error('yutaObaaClassifyMessage: JSON parse failed', raw);
      return fallback;
    }
    const category = YUTA_OBAA_VALID_CATEGORIES.includes(parsed.category) ? parsed.category : 'general';
    const crisis = parsed.crisis === true;
    return { category, crisis };
  } catch (err) {
    console.error('yutaObaaClassifyMessage: request failed', err);
    return fallback;
  }
}

/**
 * POST /api/yuta-obaa/chat
 * body: { message: string, history?: Array<{role, content}> }
 *
 * ※ このエンドポイントへの入り口(index.htmlの「AI相談」ボタン)側で、
 *   既にisPremium()による有料会員チェックを行っている前提。
 *   なりすまし防止のためのメール確認は行わず、/api/oracleと同様に
 *   IPベースの利用上限のみで悪用・請求暴走を防ぐ設計。
 */
app.post('/api/yuta-obaa/chat', async (req, res) => {
  try {
    const message = req.body.message;
    const rawHistory = Array.isArray(req.body.history) ? req.body.history : [];

    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'message is required' });
    }
    // メッセージ長の上限(極端な長文でAPIコストが膨らむのを防ぐ)
    const MAX_MESSAGE_LENGTH = 2000;
    if (message.length > MAX_MESSAGE_LENGTH) {
      return res.status(400).json({ error: `メッセージは${MAX_MESSAGE_LENGTH}文字以内でお願いします。` });
    }
    if (!ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'サーバー側でAPIキーが設定されていません。' });
    }

    // —— historyの検証・サニタイズ(role・contentの型/値を厳格にチェック) ——
    // クライアントから届く値は信用せず、不正なrole(例:'system')や
    // 文字列以外のcontentが紛れ込んでシステムプロンプトを歪めないようにする
    const MAX_HISTORY_TURNS = 20;
    const history = rawHistory
      .filter((h) => h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string')
      .map((h) => ({ role: h.role, content: h.content.slice(0, MAX_MESSAGE_LENGTH) }))
      .slice(-MAX_HISTORY_TURNS);

    // —— IPベースの利用上限チェック(/api/oracleと同じ仕組みを再利用) ——
    const clientIp = (req.headers['x-forwarded-for'] || req.ip || 'unknown').split(',')[0].trim();
    if (!isUsageAllowed(clientIp, PREMIUM_IP_LIMIT)) {
      return res.status(429).json({
        error: 'このネットワークからのご利用が、一定回数に達しました。しばらく時間をおいてお試しいただくか、サポートにお問い合わせください。'
      });
    }

    // —— ① 危機的内容の一次検出(キーワード一致) ——
    if (yutaObaaContainsCrisisSignal(message)) {
      return res.json({ reply: YUTA_OBAA_CRISIS_RESOURCES, category: 'crisis', disclaimerApplied: false });
    }

    // —— ② スコープ外の一次検出 ——
    if (yutaObaaIsLikelyOutOfScope(message)) {
      return res.json({ reply: YUTA_OBAA_OUT_OF_SCOPE_RESPONSE, category: 'out_of_scope', disclaimerApplied: false });
    }

    // —— ③ カテゴリ分類 + 危機判定(二次・モデルによる検出) ——
    const { category, crisis } = await yutaObaaClassifyMessage(message);
    if (crisis) {
      return res.json({ reply: YUTA_OBAA_CRISIS_RESOURCES, category: 'crisis', disclaimerApplied: false });
    }

    // —— ④ システムプロンプト構築 ——
    const systemPrompt = yutaObaaBuildSystemPrompt(category);

    // —— ⑤ 会話履歴 + 今回のメッセージでClaude APIへ ——
    const messages = [
      ...history.map((h) => ({ role: h.role, content: h.content })),
      { role: 'user', content: message }
    ];

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: YUTA_OBAA_CHAT_MODEL,
        max_tokens: 600,
        system: systemPrompt,
        messages
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('yuta-obaa chat: Claude API error', response.status, errText);
      return res.status(502).json({
        error: '通信状況により、詳細な鑑定を取得できませんでした。少し時間をおいてもう一度お試しください。'
      });
    }

    const data = await response.json();
    const textBlock = (data.content || []).find((b) => b.type === 'text');
    let reply = textBlock?.text || '';

    // —— ⑥ 免責事項の自動付与(お金・健康カテゴリ) ——
    let disclaimerApplied = false;
    if (YUTA_OBAA_DISCLAIMER_CATEGORIES.has(category)) {
      reply += YUTA_OBAA_DISCLAIMER_TEXT;
      disclaimerApplied = true;
    }

    res.json({ reply, category, disclaimerApplied });
  } catch (err) {
    console.error('yuta-obaa chat route error', err);
    res.status(500).json({ error: 'サーバー内部でエラーが発生しました。', detail: err.message });
  }
});

// ============================================================
// —— ユタおばーAIチャット機能ここまで ——
// ============================================================

// ============================================================
// —— 共通のエラーハンドリング(想定外のエラーも必ずログに残す) ——
// ============================================================

// どのルートにも一致しなかったリクエストを記録(404の見逃し防止)
app.use((req, res) => {
  console.warn(`[404] ${req.method} ${req.path} は存在しないルートです`);
  res.status(404).json({ error: 'お探しのエンドポイントは見つかりませんでした。' });
});

// Expressのルート内で拾いきれなかったエラーを最終的に受け止める
app.use((err, req, res, next) => {
  console.error(`[未処理エラー] ${req.method} ${req.path}`, err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'サーバー内部で予期しないエラーが発生しました。' });
});

// サーバー全体を落とすような致命的なエラーも、原因不明のまま落ちないよう必ずログに残す
process.on('uncaughtException', (err) => {
  console.error('[致命的エラー] uncaughtException:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[致命的エラー] unhandledRejection:', reason);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`サーバーがポート ${PORT} で起動しました`);
});
