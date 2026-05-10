const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

// --- 1. 金鑰與變數設定 ---
const GEMINI_KEY = process.env.GEMINI_KEY || "AIzaSyAH9bL5cjHmIvWX96oao46sjoGKSphC_sI";
const MONGODB_URI = process.env.MONGODB_URI; 

// --- 2. 資料庫連接 ---
mongoose.connect(MONGODB_URI)
  .then(() => console.log("✅ MongoDB 已連接"))
  .catch(err => console.error("❌ MongoDB 連接失敗:", err));

// --- 3. 資料模型 (Schema) ---
const PositionSchema = new mongoose.Schema({
  userId: String,
  client: String,
  stockName: String,
  code: String,
  quantity: Number,
  cost: Number,
  stopLoss: Number,
  takeProfit: Number,
  recommendType: String,
  clientProfile: Object,
  createdAt: { type: Date, default: Date.now }
});

const Position = mongoose.model('Position', PositionSchema);

// --- 4. API 路由 ---

app.post('/api/save_data', async (req, res) => {
  try {
    const newPos = new Position(req.body);
    await newPos.save();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/get_data', async (req, res) => {
  try {
    const data = await Position.find({ userId: req.query.userId });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/update_position', async (req, res) => {
  try {
    const { userId, client, code, updates } = req.body;
    const result = await Position.findOneAndUpdate(
      { userId, client, code },
      { $set: updates },
      { new: true }
    );
    res.json({ success: !!result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/delete_position', async (req, res) => {
  try {
    const { userId, client, code } = req.body;
    await Position.deleteOne({ userId, client, code });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/delete_client_all', async (req, res) => {
  try {
    const { userId, client } = req.body;
    const result = await Position.deleteMany({ userId, client });
    res.json({ success: true, deletedCount: result.deletedCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/update_client_profile', async (req, res) => {
  try {
    const { userId, client, clientProfile } = req.body;
    await Position.updateMany({ userId, client }, { clientProfile });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/prices', async (req, res) => {
  const { codes } = req.body;
  const results = {};
  try {
    const requests = codes.map(async (code) => {
      try {
        const suffix = (code.length === 4 && (code.startsWith('6') || code.startsWith('3') || code.startsWith('8'))) ? '.TWO' : '.TW';
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${code}${suffix}`;
        const resp = await axios.get(url, { timeout: 5000 });
        results[code] = resp.data.chart.result[0].meta.regularMarketPrice;
      } catch (e) {
        results[code] = null;
      }
    });
    await Promise.all(requests);
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: "抓取報價失敗" });
  }
});

// [AI 分析] 補全此路由
app.post('/api/ai_analyze', async (req, res) => {
  const { prompt } = req.body;
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`;
    const response = await axios.post(url, {
      contents: [{ parts: [{ text: prompt }] }]
    });
    res.json({ result: response.data.candidates[0].content.parts[0].text });
  } catch (err) {
    res.status(500).json({ error: "AI 分析失敗" });
  }
});

// --- 5. 啟動伺服器 (Render 必需配置) ---
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 伺服器運行在端口 ${PORT}`);
});