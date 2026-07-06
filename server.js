// server.js
// 手相占いアプリ用の中継サーバー（Render.com にデプロイ）
// 役割：フロントエンドから来たリクエストをそのまま Claude API に転送する
// （Claude の API キーをブラウザ側に出さないようにするため）

const express = require('express');
const cors = require('cors');

const app = express();

app.use(express.json({ limit: '15mb' }));
app.use(cors());

// Claude の API キーは Render の環境変数から読み込む（コードには書かない）
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
// Stripe のシークレットキーも同様に環境変数から読み込む
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;

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
app.get('/api/check-subscription', async (req, res) => {
  try {
    const email = (req.query.email || '').trim();
    if (!email) {
      return res.status(400).json({ valid: false, error: 'メールアドレスが指定されていません。' });
    }
    if (!STRIPE_SECRET_KEY) {
      return res.status(500).json({ valid: false, error: 'サーバー側でSTRIPE_SECRET_KEYが設定されていません。' });
    }

    // ① メールアドレスからStripeの顧客を検索する
    const custResp = await fetch(
      `https://api.stripe.com/v1/customers?email=${encodeURIComponent(email)}&limit=5`,
      { headers: { 'Authorization': 'Bearer ' + STRIPE_SECRET_KEY } }
    );
    const custData = await custResp.json();
    if (!custResp.ok) {
      return res.status(custResp.status).json({ valid: false, error: custData.error?.message || '顧客情報の取得でエラーが発生しました。' });
    }

    const customers = custData.data || [];
    if (customers.length === 0) {
      return res.json({ valid: false, error: 'このメールアドレスでのご契約が見つかりませんでした。' });
    }

    // ② 見つかった顧客ごとに、有効なサブスクリプション（プレミアムプラン）があるか確認する
    for (const customer of customers) {
      const subResp = await fetch(
        `https://api.stripe.com/v1/subscriptions?customer=${encodeURIComponent(customer.id)}&status=active&limit=1`,
        { headers: { 'Authorization': 'Bearer ' + STRIPE_SECRET_KEY } }
      );
      const subData = await subResp.json();
      if (subResp.ok && subData.data && subData.data.length > 0) {
        return res.json({ valid: true });
      }
    }

    res.json({ valid: false, error: '有効なプレミアムプランのご契約が見つかりませんでした。' });

  } catch (err) {
    console.error('サブスク確認エラー:', err);
    res.status(500).json({ valid: false, error: err.message });
  }
});

// フロントエンドの fetchWithTimeout('/.netlify/functions/oracle', ...) の
// リクエストボディ（{model, max_tokens, messages}）をそのまま Claude API に転送する
app.post('/api/oracle', async (req, res) => {
  try {
    if (!ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'サーバー側でAPIキーが設定されていません。' });
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
