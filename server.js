// server.js
// 手相占いアプリ用の中継サーバー（Render.com にデプロイ）
// 役割：ブラウザから来たリクエストを受け取り、Claude API に安全に転送する
// （Claude の API キーをブラウザ側に出さないようにするため）

const express = require('express');
const cors = require('cors');

const app = express();

// JSONボディを受け取れるようにする（画像などを送る場合を考えて上限を大きめに）
app.use(express.json({ limit: '10mb' }));

// どのサイトからのアクセスも許可する（必要なら特定のドメインだけに絞ってOK）
app.use(cors());

// Claude の API キーは Render の環境変数から読み込む（コードには書かない）
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// 動作確認用（ブラウザで直接アクセスした時に表示される）
app.get('/', (req, res) => {
  res.send('手相占いアプリ 中継サーバーは正常に稼働中です。');
});

// 手相占いのメインエンドポイント
// フロント側からは { "prompt": "占ってほしい内容やプロンプト" } の形式で送ってもらう想定
app.post('/api/palm-reading', async (req, res) => {
  try {
    if (!ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'サーバー側でAPIキーが設定されていません。' });
    }

    const { prompt, image } = req.body;

    if (!prompt && !image) {
      return res.status(400).json({ error: 'prompt または image を送ってください。' });
    }

    // Claude API に送るメッセージの中身を組み立てる
    const content = [];

    // 手のひらの画像がある場合（base64データを想定）
    if (image) {
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/jpeg',
          data: image
        }
      });
    }

    content.push({
      type: 'text',
      text: prompt || 'この手相を占ってください。'
    });

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 1000,
        messages: [
          { role: 'user', content }
        ]
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Claude APIエラー:', data);
      return res.status(response.status).json({ error: 'Claude APIでエラーが発生しました。', detail: data });
    }

    // テキスト部分だけ取り出してフロントに返す
    const resultText = data.content
      ?.filter(item => item.type === 'text')
      .map(item => item.text)
      .join('\n') || '';

    res.json({ result: resultText });

  } catch (err) {
    console.error('サーバーエラー:', err);
    res.status(500).json({ error: 'サーバー内部でエラーが発生しました。', detail: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`サーバーがポート ${PORT} で起動しました`);
});
