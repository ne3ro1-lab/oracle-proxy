// server.js
// 手相占いアプリ用の中継サーバー（Render.com にデプロイ）
// 役割：フロントエンドから来たリクエストをそのまま Claude API に転送する
// （Claude の API キーをブラウザ側に出さないようにするため）

const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');

const app = express();
app.set('trust proxy', true); // RenderのプロキシごしでもクライアントIPを正しく取得するため

app.use(express.json({ limit: '15mb' }));
app.use(cors());

// Claude の API キーは Render の環境変数から読み込む（コードには書かない）
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
// Stripe のシークレットキーも同様に環境変数から読み込む
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
// 管理者パスワードも同様に環境変数から読み込む（コードには書かない）
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
// メール送信用（Gmailアカウント + アプリパスワード）
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_APP_PASSWORD = process.env.EMAIL_APP_PASSWORD;

let mailTransporter = null;
if (EMAIL_USER && EMAIL_APP_PASSWORD) {
  mailTransporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: EMAIL_USER, pass: EMAIL_APP_PASSWORD }
  });
}

// ── IPアドレスベースの利用上限（悪用防止・請求暴走の安全弁） ──────────
// シークレットモードや別ブラウザで端末側のカウントをリセットされても、
// 同じネットワーク（IPアドレス）からの極端な連続利用だけは防ぐための仕組み。
// 「プレミアム申告」があっても、この上限だけは必ずチェックする
//（＝アプリを経由せず直接APIを叩かれても、請求が無制限に膨らまないための安全弁）。
// ※ Renderの無料プランはサーバー再起動時にメモリがリセットされるため、
//    完全な永続対策ではないが、日常的な悪用・請求暴走に対する現実的な抑止力になる。
const usageByIP = new Map(); // ip -> { count, resetAt }
const FREE_IP_LIMIT = 20;       // 無料申告のIPアドレスあたりの上限回数（30日間）
const PREMIUM_IP_LIMIT = 300;   // プレミアム申告でも超えられない上限回数（30日間・安全弁）
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
// フロント側：決済完了後にStripeが ?session_id=xxx を付けてサイトに戻すので、その値をここに渡す
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
      `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
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

// メールアドレスから、Stripe上に有効な契約（サブスクリプション）があるか確認する
// 別の端末で購入した人が、新しい端末でプレミアムを復元するために使う
// 指定したメールアドレスに、Stripe上の有効なサブスクリプションがあるか確認する（共通ロジック）
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

// ── メール確認コードによる本人確認（他端末での復元をなりすましから守る） ──
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
      text: `確認コード: ${code}\n\nこのコードを10分以内にアプリへ入力してください。\n心当たりのない場合は、このメールを破棄してください。`
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('確認コード送信エラー:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ② 入力されたコードが正しいか確認する
app.post('/api/verify-restore-code', (req, res) => {
  const email = (req.body.email || '').trim();
  const code = (req.body.code || '').trim();
  const rec = restoreCodes.get(email);

  if (!rec) return res.json({ valid: false, error: '確認コードの送信履歴が見つかりません。もう一度やり直してください。' });
  if (Date.now() > rec.expiresAt) {
    restoreCodes.delete(email);
    return res.json({ valid: false, error: '確認コードの有効期限が切れています。もう一度やり直してください。' });
  }
  if (rec.code !== code) {
    return res.json({ valid: false, error: '確認コードが正しくありません。' });
  }

  restoreCodes.delete(email); // 一度使ったコードは無効化する
  res.json({ valid: true });
});

// 管理者パスワードの確認（パスワードの中身はサーバー側にしか存在しない）
app.post('/api/verify-admin', (req, res) => {
  const password = (req.body && req.body.password) || '';
  if (!ADMIN_PASSWORD) {
    return res.status(500).json({ valid: false, error: 'サーバー側でADMIN_PASSWORDが設定されていません。' });
  }
  const valid = password.trim() === ADMIN_PASSWORD;
  res.json({ valid });
});

// フロントエンドの fetchWithTimeout('/.netlify/functions/oracle', ...) の
// リクエストボディ（{model, max_tokens, messages}）をそのまま Claude API に転送する
app.post('/api/oracle', async (req, res) => {
  try {
    if (!ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'サーバー側でAPIキーが設定されていません。' });
    }

    // プレミアム申告の有無に関わらず、必ずIPベースの上限をチェックする
    // （申告だけを信じて無条件に許可すると、直接APIを叩かれた際に請求が無制限に膨らむため）
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
    res.status(response.status).json(data);

  } catch (err) {
    console.error('サーバーエラー:', err);
    res.status(500).json({ error: 'サーバー内部でエラーが発生しました。', detail: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`サーバーがポート ${PORT} で起動しました`);
});
