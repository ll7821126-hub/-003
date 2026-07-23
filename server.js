const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();

// 開放所有跨網域 CORS 存取 (配合 Netlify 前端)
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '10mb' }));

// ----------------------------------------------------
// 1. 環境變數與連線設定 (同時相容兩種變數命名)
// ----------------------------------------------------
const PORT = process.env.PORT || 10000;

const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || process.env.GEMINI_KEY || "AIzaSyCiJkOf1Q294uX1zS20N4gAms0U1c_VpsI").trim();
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb+srv://admin:admin112233@cluster0.pjhjmg1.mongodb.net/stockDB?retryWrites=true&w=majority';

// Mongoose 連線設定
mongoose.connect(MONGO_URI, {
  serverSelectionTimeoutMS: 5000
})
  .then(() => console.log('✅ MongoDB connected successfully'))
  .catch(err => console.error('❌ MongoDB connection error:', err.message));

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
const CACHE_DURATION = 30 * 1000;

// (A) 證交所 TWSE API 抓取邏輯
async function fetchTwsePrices(codes) {
  const results = {};
  if (!codes || codes.length === 0) return results;

  const channelList = codes.map(c => `tse_${c.trim()}.tw|otc_${c.trim()}.tw`).join('|');
  const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${channelList}&_=${Date.now()}`;

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

// (B) Yahoo Finance 備援抓取邏輯
async function fetchYahooPrices(codes) {
  const results = {};
  if (!codes || codes.length === 0) return results;

  try {
    const yahooFinanceModule = await import('yahoo-finance2');
    const yahooFinance = yahooFinanceModule.default || yahooFinanceModule;

    if (typeof yahooFinance.suppressNotices === 'function') {
      yahooFinance.suppressNotices(['yahooSurvey']);
    }
    
    const querySymbols = [];
    codes.forEach(c => {
      const clean = c.trim();
      if (!clean.endsWith('.TW') && !clean.endsWith('.TWO')) {
        querySymbols.push(`${clean}.TW`);
        querySymbols.push(`${clean}.TWO`);
      } else {
        querySymbols.push(clean);
      }
    });

    const quotes = await yahooFinance.quote(
      querySymbols, 
      { return: 'array' }, 
      { 
        validateResult: false,
        fetchOptions: {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
          }
        }
      }
    );

    if (Array.isArray(quotes)) {
      quotes.forEach(quote => {
        if (quote && quote.symbol) {
          const pureCode = quote.symbol.split('.')[0];
          const price = quote.regularMarketPrice || quote.postMarketPrice || quote.previousClose;
          
          if (price && price > 0 && !results[pureCode]) {
            results[pureCode] = parseFloat(Number(price).toFixed(2));
          }
        }
      });
    }
  } catch (err) {
    console.error('⚠️ Yahoo Finance 抓取失敗:', err.message);
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
        console.log(`⚠️ TWSE 未查到，轉用 Yahoo 備援查詢: ${stillMissing.join(', ')}`);
        const yahooPrices = await fetchYahooPrices(stillMissing);

        stillMissing.forEach(code => {
          if (yahooPrices[code]) {
            finalPrices[code] = yahooPrices[code];
            priceCache[code] = { price: yahooPrices[code], time: now };
          }
        });
      }
    }

    res.json({ success: true, prices: finalPrices });
  } catch (err) {
    console.error('❌ /api/prices 內部系統錯誤:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// 🤖 Gemini AI 診斷 API
app.post('/api/ai_diagnose', async (req, res) => {
  try {
    const { clientData } = req.body;
    if (!clientData) {
      return res.status(400).json({ success: false, message: 'Missing clientData' });
    }

    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    
    let modelName = "gemini-1.5-flash";
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_API_KEY}`);
      const data = await response.json();
      if (data.models) {
        const available = data.models
          .map(m => m.name.replace('models/', ''))
          .filter(name => name.includes('flash') || name.includes('pro'));
        if (available.length > 0) {
          modelName = available[0];
        }
      }
    } catch (e) {
      console.log("使用預設模型: gemini-1.5-flash");
    }

    const model = genAI.getGenerativeModel({ model: modelName });

    const prompt = `你是一位專業台股資產配置專家。請分析以下客戶持倉，給出簡潔、專業且具體的診斷報告（含建議操作）：
${JSON.stringify(clientData, null, 2)}`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();

    res.json({ success: true, diagnosis: text });
  } catch (err) {
    console.error('❌ AI 診斷 Error:', err);
    res.status(500).json({ success: false, message: 'AI 診斷暫時不可用: ' + err.message });
  }
});

// 💾 儲存資料 API (同時支援 customId 與 userId)
app.post('/api/save_data', async (req, res) => {
  try {
    const data = req.body;
    const targetId = data.customId || data.userId;
    if (!targetId) {
      return res.status(400).json({ success: false, message: 'customId or userId is required' });
    }

    const updated = await ClientData.findOneAndUpdate(
      { customId: targetId },
      { ...data, customId: targetId, updatedAt: new Date() },
      { upsert: true, new: true }
    );

    res.json({ success: true, data: updated });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 💾 取得資料 API (同時支援 customId 與 userId 查詢)
app.get('/api/get_data', async (req, res) => {
  try {
    const targetId = req.query.customId || req.query.userId;
    
    if (targetId) {
      const client = await ClientData.findOne({ customId: targetId });
      return res.json({ success: true, data: client || null });
    }

    const all = await ClientData.find({});
    res.json({ success: true, data: all });
  } catch (err) {
    console.error('❌ /api/get_data 錯誤:', err.message);
    res.status(500).json({ success: false, message: err.message });
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

// ----------------------------------------------------
// 5. 健康檢查 Endpoint (替代原本靜態頁面轉向)
// ----------------------------------------------------
app.get('/', (req, res) => {
  res.send('<h1>Backend API Online</h1><p>Frontend is hosted on Netlify.</p>');
});

// ----------------------------------------------------
// 6. 啟動伺服器
// ----------------------------------------------------
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
