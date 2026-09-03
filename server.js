const express = require('express');
const cors = require('cors');
const axios = require('axios');
const mongoose = require('mongoose');

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));

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
  const models = [...new Set([
    process.env.GEMINI_TEXT_MODEL,
    process.env.GEMINI_MODEL,
    "gemini-3.5-flash-lite",
    "gemini-3.6-flash",
    "gemini-flash-latest"
  ].filter(Boolean))];
  let lastError = null;

  for (const modelName of models) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
      const response = await axios.post(
        url,
        { contents: [{ parts: [{ text: prompt }] }] },
        { headers: { 'Content-Type': 'application/json' }, timeout: 45000 }
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
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    const allUsers = await User.find({}).lean();
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
      syncedAt: new Date().toISOString(),
      users: allUserData
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// 永久刪除單一客戶（保留所屬登入帳號與其他客戶）
app.post('/api/admin/delete_client', async (req, res) => {
  const { adminPassword, userId } = req.body;
  const clientName = String(req.body?.clientName || '').trim();
  const ADMIN_SECRET = process.env.ADMIN_PASSWORD || "Qq112233.";

  if (adminPassword !== ADMIN_SECRET) {
    return res.status(403).json({ success: false, message: '管理員密碼錯誤！' });
  }
  if (!userId || !clientName) {
    return res.status(400).json({ success: false, message: '缺少帳號或客戶姓名' });
  }

  try {
    const userData = await User.findOne({ customId: userId });
    if (!userData) return res.status(404).json({ success: false, message: '找不到所屬帳號' });

    const before = {
      holdings: (userData.holdings || []).length,
      transactions: (userData.transactions || []).length,
      profile: Object.prototype.hasOwnProperty.call(userData.profiles || {}, clientName)
    };
    userData.holdings = (userData.holdings || []).filter(item => String(item?.client || '未命名客戶') !== clientName);
    userData.transactions = (userData.transactions || []).filter(item => String(item?.client || '') !== clientName);
    const nextProfiles = { ...(userData.profiles || {}) };
    delete nextProfiles[clientName];
    userData.profiles = nextProfiles;
    userData.markModified('profiles');
    await userData.save();

    const removed = {
      holdings: before.holdings - userData.holdings.length,
      transactions: before.transactions - userData.transactions.length,
      profile: before.profile
    };
    console.log(`[Admin] 已永久刪除客戶 ${clientName}（帳號 ${userId}）`);
    return res.json({ success: true, message: `客戶 ${clientName} 已永久刪除`, removed });
  } catch (err) {
    console.error('刪除客戶失敗:', err);
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

// ==================== 4. 多圖持倉截圖辨識 ====================
const HOLDING_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

function normalizeBase64Image(image, index) {
  const rawMimeType = String(image?.mimeType || image?.type || '').toLowerCase();
  let data = String(image?.data || '').trim();
  let mimeType = rawMimeType;
  const dataUrlMatch = data.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
  if (dataUrlMatch) {
    mimeType = dataUrlMatch[1].toLowerCase();
    data = dataUrlMatch[2];
  }
  if (!HOLDING_IMAGE_TYPES.has(mimeType)) throw new Error(`第 ${index + 1} 張圖片格式不支援`);
  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(data)) throw new Error(`第 ${index + 1} 張圖片內容無效`);
  const size = Buffer.byteLength(data.replace(/\s/g, ''), 'base64');
  if (!size || size > 4 * 1024 * 1024) throw new Error(`第 ${index + 1} 張圖片超過 4MB`);
  return { mimeType, data: data.replace(/\s/g, ''), size };
}

function extractGeminiText(response) {
  return (response?.data?.candidates?.[0]?.content?.parts || [])
    .map(part => part?.text || '')
    .join('')
    .trim();
}

function parseGeminiJson(text) {
  const cleaned = String(text || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  return JSON.parse(cleaned);
}

async function recognizeHoldingImages(images, clientName) {
  const models = [...new Set([
    process.env.GEMINI_VISION_MODEL,
    process.env.GEMINI_MODEL,
    'gemini-3.5-flash-lite',
    'gemini-3.6-flash',
    'gemini-flash-latest'
  ].filter(Boolean))];
  const prompt = `你是台灣券商持倉截圖資料擷取助手。請閱讀接下來的 ${images.length} 張圖片，辨識所有台股、ETF 或上櫃股票持倉列，並輸出符合指定 schema 的 JSON。

規則：
1. 一張圖片可能有多檔股票，多張圖片可能是同一客戶「${clientName || '未指定'}」的連續頁面。
2. 只擷取實際持倉明細，不要把現金、總資產、損益合計或廣告文字當成股票。
3. code 是證券代碼；stockName 使用繁體中文。看不清楚時不要猜測，保留空字串並在 warnings 說明。
4. quantity 一律換算成「股」；若畫面單位是張，乘以 1000。
5. cost 是每股平均成本，不是總成本；currentPrice 是畫面現價，沒有就填 0。
6. stopLoss、takeProfit 截圖沒有時填 0。confidence 為 0 到 1。
7. sourceImage 填圖片順序（從 1 開始）。同一檔股票在重複截圖出現時只保留資訊最完整的一筆，不要把數量相加。
8. 所有數字移除逗號與貨幣符號後再輸出。`;
  const responseSchema = {
    type: 'object',
    properties: {
      holdings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            stockName: { type: 'string' },
            code: { type: 'string' },
            quantity: { type: 'number' },
            cost: { type: 'number' },
            currentPrice: { type: 'number' },
            stopLoss: { type: 'number' },
            takeProfit: { type: 'number' },
            confidence: { type: 'number' },
            sourceImage: { type: 'integer' },
            note: { type: 'string' }
          },
          required: ['stockName', 'code', 'quantity', 'cost', 'currentPrice', 'stopLoss', 'takeProfit', 'confidence', 'sourceImage', 'note']
        }
      },
      warnings: { type: 'array', items: { type: 'string' } }
    },
    required: ['holdings', 'warnings']
  };
  const modelErrors = [];

  for (const modelName of models) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
      const parts = [{ text: prompt }, ...images.map(image => ({ inlineData: { mimeType: image.mimeType, data: image.data } }))];
      const isLiteModel = /flash-lite/i.test(modelName);
      const timeoutMs = isLiteModel ? 60000 : 120000;
      const response = await axios.post(url, {
        contents: [{ role: 'user', parts }],
        generationConfig: {
          thinkingConfig: { thinkingLevel: isLiteModel ? 'minimal' : 'low' },
          responseMimeType: 'application/json',
          responseSchema
        }
      }, {
        headers: { 'Content-Type': 'application/json' },
        timeout: timeoutMs,
        maxBodyLength: 20 * 1024 * 1024
      });
      const text = extractGeminiText(response);
      if (text) return { ...parseGeminiJson(text), _model: modelName };
    } catch (error) {
      const isTimeout = error.code === 'ECONNABORTED' || /timeout/i.test(error.message || '');
      modelErrors.push({
        model: modelName,
        message: isTimeout ? '模型回應逾時，系統已自動嘗試下一個快速模型' : (error.response?.data?.error?.message || error.message)
      });
    }
  }
  const usefulError = modelErrors.find(error => !/no longer available|not found|deprecated/i.test(error.message)) || modelErrors.at(-1);
  const detail = usefulError ? `${usefulError.model}：${usefulError.message}` : '未取得模型回應';
  throw new Error(`圖片辨識服務暫時無法使用（${detail}）`);
}

app.post('/api/ocr_holdings', async (req, res) => {
  try {
    const customId = String(req.body?.customId || '').trim();
    const password = String(req.body?.password || '');
    if (!customId || !password) return res.status(401).json({ success: false, message: '請先登入有效帳號' });
    const authUser = await User.findOne({ customId });
    if (!authUser || authUser.password !== password) return res.status(401).json({ success: false, message: '帳號驗證失敗，請重新登入' });
    if (!apiKey) return res.status(503).json({ success: false, message: '後端尚未設定 GEMINI_API_KEY' });
    const clientName = String(req.body?.clientName || '').trim().slice(0, 80);
    const sourceImages = Array.isArray(req.body?.images) ? req.body.images.slice(0, 6) : [];
    if (!sourceImages.length) return res.status(400).json({ success: false, message: '請至少上傳一張持倉截圖' });
    if ((req.body?.images || []).length > 6) return res.status(400).json({ success: false, message: '每次最多辨識 6 張截圖' });

    const images = sourceImages.map(normalizeBase64Image);
    const totalSize = images.reduce((sum, image) => sum + image.size, 0);
    if (totalSize > 14 * 1024 * 1024) return res.status(413).json({ success: false, message: '圖片總容量過大，請分兩次辨識' });

    const recognized = await recognizeHoldingImages(images, clientName);
    const warnings = Array.isArray(recognized?.warnings) ? recognized.warnings.map(value => String(value).slice(0, 300)).slice(0, 20) : [];
    const stockByCode = new Map(allTaiwanStocks.map(stock => [stock.code, stock]));
    const stockByName = new Map(allTaiwanStocks.map(stock => [stock.name.replace(/臺/g, '台'), stock]));
    const deduped = new Map();

    (Array.isArray(recognized?.holdings) ? recognized.holdings : []).slice(0, 80).forEach((item, index) => {
      let code = normalizeStockCode(item?.code);
      let stockName = String(item?.stockName || '').trim().replace(/臺/g, '台').slice(0, 40);
      if (!code && stockName && stockByName.has(stockName)) code = stockByName.get(stockName).code;
      if (code && stockByCode.has(code)) stockName = stockByCode.get(code).name;
      if (!code && !stockName) return;
      const normalized = {
        id: `ocr-${Date.now()}-${index}`,
        stockName,
        code,
        quantity: Math.max(0, Math.round(cleanNumber(item?.quantity) || 0)),
        cost: Math.max(0, cleanNumber(item?.cost) || 0),
        currentPrice: Math.max(0, cleanNumber(item?.currentPrice) || 0),
        stopLoss: Math.max(0, cleanNumber(item?.stopLoss) || 0),
        takeProfit: Math.max(0, cleanNumber(item?.takeProfit) || 0),
        confidence: Math.min(1, Math.max(0, cleanNumber(item?.confidence) || 0)),
        sourceImage: Math.min(images.length, Math.max(1, Math.round(cleanNumber(item?.sourceImage) || 1))),
        note: String(item?.note || '').trim().slice(0, 160)
      };
      const key = code || stockName;
      const score = [normalized.stockName, normalized.code, normalized.quantity, normalized.cost, normalized.currentPrice].filter(Boolean).length + normalized.confidence;
      const previous = deduped.get(key);
      if (!previous || score > previous.score) deduped.set(key, { item: normalized, score });
      if (previous) warnings.push(`偵測到重複持倉 ${stockName || code}，已保留資訊較完整的一筆`);
    });

    const holdings = [...deduped.values()].map(entry => entry.item);
    return res.json({ success: true, holdings, warnings: [...new Set(warnings)].slice(0, 20), imagesProcessed: images.length, model: recognized._model, recognizedAt: new Date().toISOString() });
  } catch (error) {
    const message = error.message || '持倉截圖辨識失敗';
    const status = /格式不支援|內容無效|超過 4MB/.test(message) ? 400 : 502;
    console.error('持倉截圖辨識失敗:', message);
    return res.status(status).json({ success: false, message });
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

function parseMarketPrice(value) {
  const first = String(value ?? '').split('_')[0].replace(/,/g, '').trim();
  const parsed = Number(first);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

async function fetchOfficialTaiwanPrices(codes) {
  const prices = {};
  const quotes = {};
  const chunks = [];
  for (let index = 0; index < codes.length; index += 35) chunks.push(codes.slice(index, index + 35));

  for (const chunk of chunks) {
    const channels = chunk.flatMap(code => [`tse_${code}.tw`, `otc_${code}.tw`]).join('|');
    const response = await axios.get('https://mis.twse.com.tw/stock/api/getStockInfo.jsp', {
      params: { ex_ch: channels, json: 1, delay: 0 },
      timeout: 12000,
      headers: {
        'Accept': 'application/json,text/plain,*/*',
        'Referer': 'https://mis.twse.com.tw/stock/index.jsp',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) PortfolioOS/4.5'
      }
    });
    for (const item of response.data?.msgArray || []) {
      const code = String(item?.c || '').trim();
      if (!code || !chunk.includes(code) || prices[code] !== undefined) continue;
      const price = parseMarketPrice(item.z) ?? parseMarketPrice(item.pz) ?? parseMarketPrice(item.o) ?? parseMarketPrice(item.y);
      if (price === null) continue;
      prices[code] = price;
      quotes[code] = {
        price,
        source: item.ex === 'otc' ? 'TPEX' : 'TWSE',
        market: item.ex || '',
        date: String(item.d || ''),
        time: String(item.t || '')
      };
    }
  }
  return { prices, quotes };
}

// ==================== 5. 股價抓取 API 路由 ====================
app.post('/api/prices', async (req, res) => {
  const startedAt = Date.now();
  const requestId = Math.random().toString(36).slice(2, 8).toUpperCase();
  try {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    const rawCodes = Array.isArray(req.body?.codes) ? req.body.codes : [];
    const codes = [...new Set(rawCodes.map(code => String(code || '').trim()).filter(code => /^\d{4,6}$/.test(code)))].slice(0, 200);
    console.log(`[Prices ${requestId}] 收到行情更新請求：${codes.length} 檔`);
    if (codes.length === 0) {
      console.log(`[Prices ${requestId}] 沒有有效證券代碼`);
      return res.json({ success: true, prices: {}, quotes: {}, failedCodes: [], updatedAt: new Date().toISOString() });
    }

    let official = { prices: {}, quotes: {} };
    try {
      official = await fetchOfficialTaiwanPrices(codes);
    } catch (error) {
      console.warn(`[Prices ${requestId}] 官方行情暫時不可用，改用備用來源：${error.message}`);
    }

    const priceMap = { ...official.prices };
    const quoteMap = { ...official.quotes };
    const missingCodes = codes.filter(code => priceMap[code] === undefined);
    await Promise.all(missingCodes.map(async code => {
      const price = await fetchPriceViaAxios(code);
      if (price !== null && price !== undefined) {
        priceMap[code] = price;
        quoteMap[code] = { price, source: 'Yahoo 備用', market: '', date: '', time: '' };
      }
    }));

    const failedCodes = codes.filter(code => priceMap[code] === undefined);
    const officialCount = Object.values(quoteMap).filter(quote => quote.source === 'TWSE' || quote.source === 'TPEX').length;
    console.log(`[Prices ${requestId}] 完成：更新 ${Object.keys(priceMap).length}/${codes.length} 檔，官方 ${officialCount} 檔，失敗 ${failedCodes.length} 檔，耗時 ${Date.now() - startedAt}ms${failedCodes.length ? `；失敗代碼 ${failedCodes.join(',')}` : ''}`);

    return res.json({ success: true, prices: priceMap, quotes: quoteMap, failedCodes, updatedAt: new Date().toISOString(), requestId });
  } catch (err) {
    console.error(`[Prices ${requestId}] 行情更新失敗，耗時 ${Date.now() - startedAt}ms：${err.message}`);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ==================== 6. 持倉公司官方資訊 API ====================
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
