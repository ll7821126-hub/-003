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
  profiles: { type: Object, default: {} },
  transactions: { type: Array, default: [] }
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

// ==================== 全台股清單與搜尋 API ====================
let allTaiwanStocks = [];

// 伺服器啟動時抓取全台股清單（上市 + 上櫃）
async function loadAllTaiwanStocks() {
  try {
    const twseRes = await axios.get('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL', { timeout: 8000 });
    const twseList = (twseRes.data || []).map(item => ({
      code: String(item.Code).trim(),
      name: String(item.Name).trim()
    }));

    const tpexRes = await axios.get('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes', { timeout: 8000 });
    const tpexList = (tpexRes.data || []).map(item => ({
      code: String(item.SecuritiesCompanyCode || item.Code).trim(),
      name: String(item.CompanyName || item.Name).trim()
    }));

    allTaiwanStocks = [...twseList, ...tpexList].filter(s => s.code && s.name && !s.code.startsWith('00'));
    console.log(`✅ 已成功載入全台股數據庫，共 ${allTaiwanStocks.length} 檔標的`);
  } catch (err) {
    console.warn("⚠️ 台股清單初始化失敗，使用基礎備用清單:", err.message);
  }
}
loadAllTaiwanStocks();

// 前端即時搜尋 API
app.get('/api/search_stocks', (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase();
  if (!q) return res.json({ success: true, list: [] });

  const cleanQ = q.replace(/臺/g, '台');
  const matched = allTaiwanStocks.filter(s => 
    s.code.includes(cleanQ) || 
    s.name.toLowerCase().replace(/臺/g, '台').includes(cleanQ)
  ).slice(0, 15);

  return res.json({ success: true, list: matched });
});

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
        data: { password: "", holdings: [], profiles: {}, transactions: [] }
      });
    }
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// 儲存用戶資料
app.post('/api/save_data', async (req, res) => {
  const { customId, password, holdings, profiles, transactions } = req.body;

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
      userData = new User({ customId, password, holdings, profiles, transactions });
    } else {
      userData.password = password || userData.password;
      if (Array.isArray(holdings)) userData.holdings = holdings;
      if (profiles && typeof profiles === 'object') userData.profiles = profiles;
      if (Array.isArray(transactions)) userData.transactions = transactions;
    }

    await userData.save();
    return res.json({ success: true, message: '雲端同步成功 (已永久寫入數據庫)' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ==================== 2. 管理員後台 API (MongoDB 版) ====================

// 讀取所有用戶數據
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
      profiles: u.profiles || {},
      transactions: u.transactions || []
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

// 刪除用戶帳號 API
app.post('/api/admin/delete_user', async (req, res) => {
  const { adminPassword, userId } = req.body;
  const ADMIN_SECRET = process.env.ADMIN_PASSWORD || "Qq112233.";

  if (adminPassword !== ADMIN_SECRET) {
    return res.status(403).json({ success: false, message: '管理員密碼錯誤！' });
  }

  if (!userId) {
    return res.status(400).json({ success: false, message: '缺少要刪除的帳號 ID (userId)' });
  }

  try {
    const deletedUser = await User.findOneAndDelete({ customId: userId });
    
    if (!deletedUser) {
      return res.status(404).json({ success: false, message: '找不到該帳號，可能已被刪除' });
    }

    console.log(`[Admin] 帳號已成功從 MongoDB 刪除: ${userId}`);
    return res.json({ success: true, message: `帳號 ${userId} 已成功刪除` });
  } catch (err) {
    console.error("刪除帳號失敗:", err);
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

// ==================== 5. 持倉公司官方資訊 API ====================
// 資料來源：臺灣證券交易所與櫃買中心 OpenAPI。結果快取 30 分鐘，避免重複抓取大型資料集。
const marketDatasetCache = new Map();
const MARKET_CACHE_TTL = 30 * 60 * 1000;

async function fetchMarketDataset(cacheKey, url) {
  const cached = marketDatasetCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  const response = await axios.get(url, {
    timeout: 15000,
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'PortfolioOS/2.0 market-calendar'
    }
  });
  const data = Array.isArray(response.data) ? response.data : [];
  marketDatasetCache.set(cacheKey, { data, expiresAt: Date.now() + MARKET_CACHE_TTL });
  return data;
}

function normalizeStockCode(value) {
  return String(value || '').trim().replace(/[^0-9A-Za-z]/g, '');
}

function rocDateToIso(value, monthOnly = false) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length < 5) return '';
  const rocYear = Number(digits.slice(0, 3));
  const year = rocYear + 1911;
  const month = digits.slice(3, 5);
  if (monthOnly || digits.length < 7) return `${year}-${month}`;
  const day = digits.slice(5, 7);
  return `${year}-${month}-${day}`;
}

function cleanNumber(value) {
  const parsed = Number(String(value ?? '').replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function groupLatestByCode(rows, getCode, getSortValue) {
  const latest = new Map();
  rows.forEach(row => {
    const code = normalizeStockCode(getCode(row));
    if (!code) return;
    const sortValue = String(getSortValue(row) || '');
    const current = latest.get(code);
    if (!current || sortValue > current.sortValue) latest.set(code, { row, sortValue });
  });
  return latest;
}

app.post('/api/market_events', async (req, res) => {
  const codes = [...new Set((req.body?.codes || []).map(normalizeStockCode).filter(code => /^\d{4,6}$/.test(code)))].slice(0, 80);
  if (!codes.length) return res.json({ success: true, events: [], updatedAt: new Date().toISOString() });
  const codeSet = new Set(codes);

  const sources = [
    ['twse_announcements', 'https://openapi.twse.com.tw/v1/opendata/t187ap04_L'],
    ['twse_revenue', 'https://openapi.twse.com.tw/v1/opendata/t187ap05_L'],
    ['twse_dividends', 'https://openapi.twse.com.tw/v1/opendata/t187ap45_L'],
    ['tpex_announcements', 'https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap04_O'],
    ['tpex_revenue', 'https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap05_O'],
    ['tpex_dividends', 'https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap39_O']
  ];

  try {
    const settled = await Promise.allSettled(sources.map(([key, url]) => fetchMarketDataset(key, url)));
    const datasets = Object.fromEntries(settled.map((result, index) => [sources[index][0], result.status === 'fulfilled' ? result.value : []]));
    const sourceStatus = Object.fromEntries(settled.map((result, index) => [sources[index][0], result.status]));
    const events = [];

    const appendAnnouncements = (rows, market) => {
      rows
        .filter(row => codeSet.has(normalizeStockCode(row['公司代號'] || row.SecuritiesCompanyCode)))
        .sort((a, b) => String(b['發言日期'] || '').localeCompare(String(a['發言日期'] || '')))
        .slice(0, 30)
        .forEach(row => {
          const code = normalizeStockCode(row['公司代號'] || row.SecuritiesCompanyCode);
          const rawTime = String(row['發言時間'] || '').padStart(6, '0');
          events.push({
            id: `announcement-${market}-${code}-${row['發言日期'] || ''}-${rawTime}`,
            category: 'announcement',
            market,
            code,
            companyName: row['公司名稱'] || row.CompanyName || code,
            date: rocDateToIso(row['發言日期']),
            time: `${rawTime.slice(0, 2)}:${rawTime.slice(2, 4)}`,
            title: String(row['主旨 '] || row['主旨'] || '重大訊息').replace(/\s+/g, ' ').trim(),
            detail: String(row['說明'] || '').slice(0, 1200),
            sourceUrl: 'https://mops.twse.com.tw/'
          });
        });
    };

    appendAnnouncements(datasets.twse_announcements, '上市');
    appendAnnouncements(datasets.tpex_announcements, '上櫃');

    const appendRevenue = (rows, market) => {
      const latest = groupLatestByCode(rows, row => row['公司代號'], row => row['資料年月']);
      codes.forEach(code => {
        const entry = latest.get(code);
        if (!entry) return;
        const row = entry.row;
        events.push({
          id: `revenue-${market}-${code}-${row['資料年月'] || ''}`,
          category: 'revenue',
          market,
          code,
          companyName: row['公司名稱'] || code,
          date: rocDateToIso(row['出表日期']),
          period: rocDateToIso(row['資料年月'], true),
          title: `${rocDateToIso(row['資料年月'], true)} 月營收`,
          revenue: cleanNumber(row['營業收入-當月營收']),
          mom: cleanNumber(row['營業收入-上月比較增減(%)']),
          yoy: cleanNumber(row['營業收入-去年同月增減(%)']),
          sourceUrl: 'https://mops.twse.com.tw/'
        });
      });
    };

    appendRevenue(datasets.twse_revenue, '上市');
    appendRevenue(datasets.tpex_revenue, '上櫃');

    const appendDividends = (rows, market) => {
      const latest = groupLatestByCode(
        rows,
        row => row['公司代號'],
        row => row['董事會（擬議）股利分派日'] || row['董事會決議通過股利分派日'] || row['出表日期']
      );
      codes.forEach(code => {
        const entry = latest.get(code);
        if (!entry) return;
        const row = entry.row;
        const dateValue = row['董事會（擬議）股利分派日'] || row['董事會決議通過股利分派日'] || row['出表日期'];
        const cashDividend = market === '上市'
          ? [
              row['股東配發-盈餘分配之現金股利(元/股)'],
              row['股東配發-法定盈餘公積發放之現金(元/股)'],
              row['股東配發-資本公積發放之現金(元/股)']
            ].reduce((sum, value) => sum + (cleanNumber(value) || 0), 0)
          : [
              row['股東配發內容-盈餘分配之現金股利(元/股)'],
              row['股東配發內容-法定盈餘公積、資本公積發放之現金(元/股)']
            ].reduce((sum, value) => sum + (cleanNumber(value) || 0), 0);
        events.push({
          id: `dividend-${market}-${code}-${row['股利年度'] || ''}-${row['期別'] || ''}`,
          category: 'dividend',
          market,
          code,
          companyName: row['公司名稱'] || code,
          date: rocDateToIso(dateValue),
          title: cashDividend > 0 ? `現金股利 ${cashDividend.toFixed(2)} 元/股` : '股利分派資訊更新',
          cashDividend,
          dividendYear: row['股利年度'] || '',
          progress: row['決議（擬議）進度'] || '董事會通過',
          sourceUrl: 'https://mops.twse.com.tw/'
        });
      });
    };

    appendDividends(datasets.twse_dividends, '上市');
    appendDividends(datasets.tpex_dividends, '上櫃');

    events.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || a.code.localeCompare(b.code));
    return res.json({ success: true, events: events.slice(0, 80), sourceStatus, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('官方市場資訊抓取失敗:', err.message);
    return res.status(502).json({ success: false, events: [], message: '官方市場資訊暫時無法取得' });
  }
});

process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));
process.on('unhandledRejection', (reason) => console.error('Unhandled Rejection:', reason));

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
