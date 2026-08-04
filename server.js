const express = require('express');
const cors = require('cors');
const axios = require('axios');
const mongoose = require('mongoose');

// 安全載入 yahoo-finance2
let yahooFinance = null;
try {
  const YahooFinanceClass = require('yahoo-finance2').default;
  yahooFinance = new YahooFinanceClass();
  if (yahooFinance.suppressNotices) {
    yahooFinance.suppressNotices(['yahooSurvey']);
  }
} catch (e) {
  console.warn("⚠️ yahoo-finance2 模組初始化警告，將使用備用 API 機制");
}

const app = express();
app.use(cors());
app.use(express.json());

// ==================== 連接 MongoDB 雲端資料庫 ====================
const MONGODB_URI = process.env.MONGODB_URI;

if (MONGODB_URI) {
  mongoose.connect(MONGODB_URI)
    .then(() => console.log("✅ 成功連接至 MongoDB 雲端資料庫"))
    .catch(err => console.error("❌ MongoDB 連接失敗:", err.message));
} else {
  console.warn("⚠️ 警告：未設定 MONGODB_URI 環境變數，資料將無法永久保存！");
}

// 定義 User 資料結構 Schema
const userSchema = new mongoose.Schema({
  customId: { type: String, required: true, unique: true },
  password: { type: String, default: "" },
  holdings: { type: Array, default: [] },
  profiles: { type: Object, default: {} }
}, { timestamps: true });

const User = mongoose.model('User', userSchema);

// 獲取 GEMINI API KEY
const apiKey = process.env.GEMINI_API_KEY;

// 輔助函式：呼叫 Gemini REST API
async function callGeminiApi(prompt) {
  const models = ["gemini-2.0-flash", "gemini-1.5-flash", "gemini-1.5-pro"];
  let lastError = null;

  for (const modelName of models) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
      const response = await axios.post(
        url,
        { contents: [{ parts: [{ text: prompt }] }] },
        { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
      );
      const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) return text;
    } catch (err) {
      lastError = err.response?.data?.error?.message || err.message;
    }
  }
  throw new Error(lastError || "所有 Gemini API 模型均呼叫失敗");
}

// 全局根目錄健康檢查
app.get('/', (req, res) => res.send('Server is running normally!'));

// ==================== 1. 帳號與持倉數據 API (MongoDB 版) ====================

// 讀取用戶資料
app.get('/api/get_data', async (req, res) => {
  const customId = req.query.customId;
  if (!customId) {
    return res.status(400).json({ success: false, message: '缺少 customId 參數' });
  }

  try {
    const userData = await User.findOne({ customId });
    if (userData) {
      return res.json({ success: true, data: userData });
    } else {
      return res.json({
        success: true,
        data: { password: "", holdings: [], profiles: {} }
      });
    }
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// 儲存用戶資料
app.post('/api/save_data', async (req, res) => {
  const { customId, password, holdings, profiles } = req.body;

  if (!customId) {
    return res.status(400).json({ success: false, message: '缺少 customId' });
  }

  try {
    let userData = await User.findOne({ customId });

    if (userData && userData.password) {
      if (userData.password !== password) {
        return res.status(403).json({ success: false, message: '密碼不符，無法更新數據' });
      }
    }

    if (!userData) {
      userData = new User({ customId, password, holdings, profiles });
    } else {
      userData.password = password || userData.password;
      userData.holdings = holdings || [];
      userData.profiles = profiles || {};
    }

    await userData.save();
    return res.json({ success: true, message: '雲端同步成功 (已永久寫入數據庫)' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ==================== 2. 管理員後台 API (MongoDB 版) ====================
app.post('/api/admin/all_data', async (req, res) => {
  const { adminPassword } = req.body;
  const ADMIN_SECRET = process.env.ADMIN_PASSWORD || "Qq112233.";

  if (adminPassword !== ADMIN_SECRET) {
    return res.status(403).json({ success: false, message: '管理員密碼錯誤！' });
  }

  try {
    const allUsers = await User.find({});
    const allUserData = allUsers.map(u => ({
      userId: u.customId,
      password: u.password,
      holdingsCount: (u.holdings || []).length,
      holdings: u.holdings || [],
      profiles: u.profiles || {}
    }));

    return res.json({
      success: true,
      totalUsers: allUserData.length,
      users: allUserData
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ==================== 3. AI 診斷 API 路由 ====================
app.post('/api/ai_diagnose', async (req, res) => {
  try {
    if (!apiKey) {
      return res.status(500).json({ success: false, diagnosis: "未設定 GEMINI_API_KEY。" });
    }
    const { clientData } = req.body;
    if (!clientData) {
      return res.status(400).json({ success: false, diagnosis: "未收到有效的診斷數據。" });
    }

    let prompt = "你是一位專業的台灣股市投資顧問。請用繁體中文提供簡明、專業且客觀的診斷與操作建議：\n\n";
    if (clientData.type === "single_stock_analysis") {
      const stock = clientData.targetStock || {};
      prompt += `【單股分析】\n股票名稱/代碼：${stock.stockName || ''} (${stock.code || ''})\n買入成本：NT$ ${stock.cost || 0}\n當前現價：NT$ ${stock.currentPrice || stock.cost || 0}\n持股數量：${stock.quantity || 0} 股\n請針對短中線趨勢與後續策略給出建議。`;
    } else if (clientData.type === "portfolio_diagnosis") {
      prompt += `【整體持倉組合診斷】\n客戶姓名：${clientData.clientName || '未名'}\n背景檔案：${JSON.stringify(clientData.profile || {})}\n持倉清單：${JSON.stringify(clientData.holdings || [])}\n請評估風險並給出資產配置建議。`;
    } else {
      prompt += `請求內容：${JSON.stringify(clientData)}\n請提供投資分析。`;
    }

    const responseText = await callGeminiApi(prompt);
    return res.json({ success: true, diagnosis: responseText });
  } catch (error) {
    return res.status(500).json({ success: false, diagnosis: `AI 診斷失敗：${error.message}` });
  }
});

// 輔助函式：即時股價抓取
async function fetchPriceViaAxios(code) {
  const suffixes = ['.TW', '.TWO'];
  for (const suffix of suffixes) {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${code}${suffix}`;
      const resp = await axios.get(url, { 
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        timeout: 5000 
      });
      const meta = resp.data?.chart?.result?.[0]?.meta;
      if (meta && typeof meta.regularMarketPrice === 'number') {
        return meta.regularMarketPrice;
      }
    } catch (e) {}
  }
  return null;
}

// ==================== 4. 股價抓取 API 路由 ====================
app.post('/api/prices', async (req, res) => {
  try {
    const { codes } = req.body;
    if (!codes || !Array.isArray(codes) || codes.length === 0) {
      return res.json({ success: true, prices: {} });
    }

    const priceMap = {};
    await Promise.all(
      codes.map(async (code) => {
        let price = null;
        if (yahooFinance) {
          try {
            const quote = await yahooFinance.quote(`${code}.TW`);
            if (quote && quote.regularMarketPrice) price = quote.regularMarketPrice;
          } catch (e1) {
            try {
              const quoteTWO = await yahooFinance.quote(`${code}.TWO`);
              if (quoteTWO && quoteTWO.regularMarketPrice) price = quoteTWO.regularMarketPrice;
            } catch (e2) {}
          }
        }
        if (!price) price = await fetchPriceViaAxios(code);
        if (price !== null && price !== undefined) priceMap[code] = price;
      })
    );

    return res.json({ success: true, prices: priceMap });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));
process.on('unhandledRejection', (reason) => console.error('Unhandled Rejection:', reason));

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
