const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();

// ----------------------------------------------------
// 0. 強制放行 CORS 與 Preflight (徹底解決 403 / 跨網域阻擋)
// ----------------------------------------------------
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  
  // 處理瀏覽器的 OPTIONS 預檢請求 (Preflight Request)
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ----------------------------------------------------
// 1. 環境變數與連線設定
// ----------------------------------------------------
const PORT = process.env.PORT || 10000;

const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || process.env.GEMINI_KEY || "").trim();
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI || "";

if (MONGO_URI) {
  mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000 })
    .then(() => console.log('✅ MongoDB connected successfully'))
    .catch(err => console.error('❌ MongoDB connection error:', err.message));
} else {
  console.error('⚠️ 警告：未設定 MONGO_URI 環境變數！');
}

// ----------------------------------------------------
// 2. Data Models (Mongoose)
// ----------------------------------------------------
const ClientDataSchema = new mongoose.Schema({
  customId: { type: String, unique: true, required: true },
  name: String,
  totalCapital: Number,
  availableFund: Number,
  occupiedFund: Number,
  totalProfit: Number,
  profitRate: Number,
  holdings: Array,
  history: Array,
  aiDiagnosis: String,
  updatedAt: { type: Date, default: Date.now }
});

const ClientData = mongoose.model('ClientData', ClientDataSchema);

// ----------------------------------------------------
// 3. 快取與股價抓取核心邏輯
// ----------------------------------------------------
const priceCache = {}; 
const CACHE_DURATION = 30 * 1000; // 30 秒快取

// (A) 證交所 TWSE API
async function fetchTwsePrices(codes) {
  const results = {};
  if (!codes || codes.length === 0) return results;

  const channels = [];
  codes.forEach(c => {
    const clean = c.trim();
    channels.push(`tse_${clean}.tw`);
    channels.push(`otc_${clean}.tw`);
  });

  const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${channels.join('|')}&_=${Date.now()}`;

  try {
    const resp = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://mis.twse.com.tw/stock/fibest.jsp',
        'Accept': 'application/json, text/javascript, */*; q=0.01'
      },
      timeout: 5000
    });

    if (resp.data && resp.data.msgArray) {
      resp.data.msgArray.forEach(item => {
        const code = item.c;
        if (!code) return;

        let priceStr = item.z; 
        if (!priceStr || priceStr === '-') {
          if (item.a) priceStr = item.a.split('_')[0]; 
        }
        if (!priceStr || priceStr === '-') {
          priceStr = item.y; 
        }

        const price = parseFloat(priceStr);
        if (!isNaN(price) && price > 0) {
          results[code] = price;
        }
      });
    }
  } catch (err) {
    console.error('⚠️ TWSE 抓取失敗:', err.message);
  }
  return results;
}

// (B) Yahoo Finance 抗封鎖直連 API (帶 CORS Proxy 備援)
async function fetchYahooDirectPrices(codes) {
  const results = {};
  if (!codes || codes.length === 0) return results;

  for (const code of codes) {
    const clean = code.trim();
    const suffixes = ['.TW', '.TWO'];

    for (const suffix of suffixes) {
      const symbol = `${clean}${suffix}`;
      const targets = [
        `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1m&range=1d`,
        `https://corsproxy.io/?${encodeURIComponent(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1m&range=1d`)}`
      ];

      for (const targetUrl of targets) {
        try {
          const resp = await axios.get(targetUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            timeout: 3000
          });

          const meta = resp.data?.chart?.result?.[0]?.meta;
          if (meta) {
            const price = meta.regularMarketPrice || meta.chartPreviousClose || meta.previousClose;
            if (price && !isNaN(price) && price > 0) {
              results[clean] = parseFloat(Number(price).toFixed(2));
              break;
            }
          }
        } catch (err) {
          // 自動嘗試下一個 Proxy
        }
      }

      if (results[clean]) break;
    }
  }

  return results;
}

// ----------------------------------------------------
// 4. API Endpoints
// ----------------------------------------------------

// 📡 股價查詢 API
app.post('/api/prices', async (req, res) => {
  try {
    const { codes } = req.body;
    if (!codes || !Array.isArray(codes)) {
      return res.json({ success: true, prices: {} });
    }

    const uniqueCodes = [...new Set(codes.map(c => String(c).trim()))].filter(Boolean);
    const finalPrices = {};
    const missingCodes = [];
    const now = Date.now();

    uniqueCodes.forEach(code => {
      if (priceCache[code] && (now - priceCache[code].time < CACHE_DURATION)) {
        finalPrices[code] = priceCache[code].price;
      } else {
        missingCodes.push(code);
      }
    });

    if (missingCodes.length > 0) {
      console.log(`🔍 正在向網路抓取最新股價: ${missingCodes.join(', ')}`);

      const twsePrices = await fetchTwsePrices(missingCodes);
      const stillMissing = [];

      missingCodes.forEach(code => {
        if (twsePrices[code]) {
          finalPrices[code] = twsePrices[code];
          priceCache[code] = { price: twsePrices[code], time: now };
        } else {
          stillMissing.push(code);
        }
      });

      if (stillMissing.length > 0) {
        console.log(`⚠️ TWSE 未查到，轉用 Yahoo 直連備援: ${stillMissing.join(', ')}`);
        const yahooPrices = await fetchYahooDirectPrices(stillMissing);

        stillMissing.forEach(code => {
          if (yahooPrices[code]) {
            finalPrices[code] = yahooPrices[code];
            priceCache[code] = { price: yahooPrices[code], time: now };
          }
        });
      }
    }

    console.log('✅ 最終抓取到的價格結果:', finalPrices);
    res.json({ success: true, prices: finalPrices });
  } catch (err) {
    console.error('❌ /api/prices 錯誤:', err);
    res.json({ success: false, prices: {}, error: err.message });
  }
});

// 🤖 Gemini AI 診斷 API
app.post('/api/ai_diagnose', async (req, res) => {
  try {
    const { clientData } = req.body;
    if (!clientData || !GEMINI_API_KEY) {
      return res.json({ success: false, diagnosis: 'AI 服務尚未配置 KEY 或缺少資料' });
    }

    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    const prompt = `你是一位專業台股資產配置專家。請分析以下客戶持倉，給出簡潔、專業且具體的診斷報告（含建議操作）：
${JSON.stringify(clientData, null, 2)}`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    res.json({ success: true, diagnosis: response.text() });
  } catch (err) {
    console.error('❌ AI 診斷 Error:', err);
    res.json({ success: false, diagnosis: 'AI 診斷暫時不可用: ' + err.message });
  }
});

// 💾 取得資料 API
app.get('/api/get_data', async (req, res) => {
  try {
    const targetId = req.query.customId || req.query.userId;

    if (mongoose.connection.readyState !== 1) {
      return res.json({ success: false, data: null, message: 'DB not connected' });
    }

    if (targetId) {
      const client = await ClientData.findOne({ customId: targetId });
      return res.json({ success: true, data: client || null });
    }

    const all = await ClientData.find({});
    res.json({ success: true, data: all });
  } catch (err) {
    console.error('❌ /api/get_data 錯誤:', err.message);
    res.json({ success: false, data: null, message: err.message });
  }
});

// 💾 儲存資料 API
app.post('/api/save_data', async (req, res) => {
  try {
    const data = req.body;
    const targetId = data.customId || data.userId;

    if (!targetId || mongoose.connection.readyState !== 1) {
      return res.json({ success: false, message: 'Invalid ID or DB disconnected' });
    }

    const updated = await ClientData.findOneAndUpdate(
      { customId: targetId },
      { ...data, customId: targetId, updatedAt: new Date() },
      { upsert: true, new: true }
    );

    res.json({ success: true, data: updated });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// 🔑 後台登入認證
app.post('/api/admin_login', (req, res) => {
  const { password } = req.body;
  if (password === 'Qq112233.') {
    res.json({ success: true, token: 'authenticated-admin-token' });
  } else {
    res.status(401).json({ success: false, message: '密碼錯誤' });
  }
});

app.get('/', (req, res) => {
  res.send('<h1>Backend API Online</h1>');
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
