// server.js
const express = require('express');
const cors = require('cors');

const app = express();

app.use(express.json({ limit: '15mb' }));
app.use(cors());

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

app.get('/', (req, res) => {
  res.send('手相占いアプリ 中継サーバーは正常に稼働中です。');
});

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
