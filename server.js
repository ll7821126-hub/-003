const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

// --- 1. 金鑰與變數設定 ---
// 優先讀取環境變數，若無則使用你提供的金鑰
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

// [基礎功能] 儲存資料
app.post('/api/save_data', async (req, res) => {
  try {
    const newPos = new Position(req.body);
    await newPos.save();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// [基礎功能] 取得特定使用者的所有持倉
app.get('/api/get_data', async (req, res) => {
  try {
    const data = await Position.find({ userId: req.query.userId });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// [新增功能] 更新單筆持倉 (修改數量或成本)
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

// [基礎功能] 刪除單筆持倉
app.post('/api/delete_position', async (req, res) => {
  try {
    const { userId, client, code } = req.body;
    await Position.deleteOne({ userId, client, code });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// [新增功能] 批量刪除特定客戶所有持倉
app.post('/api/delete_client_all', async (req, res) => {
  try {
    const { userId, client } = req.body;
    const result = await Position.deleteMany({ userId, client });
    res.json({ success: true, deletedCount: result.deletedCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// [基礎功能] 更新客戶檔案 (Profile)
app.post('/api/update_client_profile', async (req, res) => {
  try {
    const { userId, client, clientProfile } = req.body;
    await Position.updateMany({ userId, client }, { clientProfile });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// [進階功能] 實時抓取台股報價 (判斷上市/上櫃)
app.post('/api/prices', async (req, res) => {
  const { codes } = req.body;
  const results = {};
  try {
    const requests = codes.map(async (code) => {
      try {
        // 判斷代碼長度與開頭，簡單區分上市(.TW)與上櫃(.TWO)
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

// [進階功能] AI 分析 (修正 Key 引用)
app.post('/api/ai_analyze', async (req, res) => {
  const { prompt } = req.body;
  try {
    const