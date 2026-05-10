const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const axios = require('axios');
const path = require('path'); 
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

// 託管靜態檔案 (讓 Render 能讀取 index.html)
app.use(express.static(__dirname));

// --- 1. 金鑰與變數設定 ---
const GEMINI_KEY = process.env.GEMINI_KEY || "AIzaSyAH9bL5cjHmIvWX96oao46sjoGKSphC_sI";
const MONGODB_URI = process.env.MONGODB_URI; 

// --- 2. 資料庫連接 ---
mongoose.connect(MONGODB_URI)
  .then(() => console.log("✅ MongoDB 已連接"))
  .catch(err => console.error("❌ MongoDB 連接失敗:", err));

// --- 3. 資料模型 ---
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

// 首頁：直接讀取 index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// [實時報價] 修正 Yahoo Finance 抓取邏輯
app.post('/api/prices', async (req, res) => {
  const { codes } = req.body;
  const results = {};
  try {
    const requests = codes.map(async (code) => {
      try {
        const suffix = (code.length === 4 && (code.startsWith('6') || code.startsWith('3') || code.startsWith('8'))) ? '.TWO' : '.TW';
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${code}${suffix}`;
        // 加入 User-Agent 與延長超時，防止抓取失敗
        const resp = await axios.get(url, { 
          timeout: 8000,
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });
        results[code] = resp.data.chart.result[0].meta.regularMarketPrice;
      } catch (e) {
        results[code] = null;
      }
    });
    await Promise.all(requests);
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: "報價系統異常" });
  }
});

// [AI 分析] 調用 Gemini 1.5 Flash
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

// 其他資料庫操作路由 (省略部分以保持簡潔，請保留您原有的 save_data, get_data 等)
app.post('/api/save_data', async (req, res) => { try { const n = new Position(req.body); await n.save(); res.json({success:true}); } catch(e) { res.status(500).send(e); } });
app.get('/api/get_data', async (req, res) => { try { const d = await Position.find({userId:req.query.userId}); res.json(d); } catch(e) { res.status(500).send(e); } });

// --- 5. 啟動伺服器 ---
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => { console.log(`🚀 Server on ${PORT}`); });