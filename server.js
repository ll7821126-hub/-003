const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bodyParser = require('body-parser');
const fetch = require('node-fetch'); 
const yahooFinance = require('yahoo-finance2').default;

const app = express();
const PORT = process.env.PORT || 10000;

// ★★★ API Key (確認有效) ★★★
const GEMINI_API_KEY = "AIzaSyAH9bL5cjHmIvWX96oao46sjoGKSphC_sI".trim();

app.use(cors());
app.use(bodyParser.json());

// MongoDB 連線
mongoose.connect('mongodb+srv://admin:admin112233@cluster0.is84pny.mongodb.net/stock_app?retryWrites=true&w=majority&appName=Cluster0')
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB error:', err));

const holdingSchema = new mongoose.Schema({
  userId: String,
  client: String,
  stockName: String,
  code: String,
  quantity: Number,
  cost: Number,
  currentPrice: Number,
  stopLoss: Number,
  takeProfit: Number,
  recommendType: { type: String, default: 'no' },
  clientProfile: Object,
  createdAt: { type: Date, default: Date.now }
});

const Holding = mongoose.model('Holding', holdingSchema);
const priceCache = new Map();
const CACHE_DURATION = 30000;

function normalizeCode(code) {
  if (!code) return '';
  return String(code).trim().replace(/[^\w]/g, '');
}

// 抓取股價邏輯
async function fetchTWSEPrices(codes) {
  const results = {};
  if (!codes || codes.length === 0) return results;
  const tseParams = codes.map(c => `tse_${c}.tw`).join('|');
  const otcParams = codes.map(c => `otc_${c}.tw`).join('|');
  const t = Date.now();
  const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?json=1&delay=0&ex_ch=${tseParams}|${otcParams}&_=${t}`;
  try {
    const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const data = await response.json();
    if (data.msgArray) {
      data.msgArray.forEach(stock => {
        const price = stock.z !== '-' ? stock.z : stock.y;
        if (price && price !== '-') results[stock.c] = parseFloat(Number(price).toFixed(2));
      });
    }
  } catch (e) { console.error('TWSE API Error'); }
  return results;
}

async function fetchYahooPrices(codes) {
  const results = {};
  if (!codes || codes.length === 0) return results;
  
  // ★★★ 修正點：同時產生 .TW 與 .TWO 進行查詢，避免上櫃股票因格式錯誤抓不到價格 ★★★
  const symbols = [];
  codes.forEach(c => {
    const clean = c.trim();
    if (!clean.endsWith('.TW') && !clean.endsWith('.TWO')) {
      symbols.push(`${clean}.TW`);
      symbols.push(`${clean}.TWO`);
    } else {
      symbols.push(clean);
    }
  });

  try {
    const quotes = await yahooFinance.quote(symbols, { return: 'array' }, { validateResult: false });
    quotes.forEach(quote => {
      if (quote && quote.symbol) {
        const pureCode = quote.symbol.split('.')[0];
        const price = quote.regularMarketPrice || quote.postMarketPrice || quote.previousClose;
        if (price) results[pureCode] = parseFloat(Number(price).toFixed(2));
      }
    });
  } catch (err) {
    console.error('Yahoo Finance API Error:', err.message);
  }
  return results;
}

app.post('/api/prices', async (req, res) => {
  try {
    const codes = (req.body.codes || []).map(normalizeCode).filter(Boolean);
    if (!codes.length) return res.json({});
    const priceMap = {};
    const codesToFetch = [];
    codes.forEach(c => {
      const cached = priceCache.get(c);
      if (cached && (Date.now() - cached.ts < CACHE_DURATION)) priceMap[c] = cached.p;
      else codesToFetch.push(c);
    });
    if (codesToFetch.length) {
      const twseResults = await fetchTWSEPrices(codesToFetch);
      Object.assign(priceMap, twseResults);
      const missing = codesToFetch.filter(c => !priceMap[c]);
      if (missing.length > 0) {
        const yahooResults = await fetchYahooPrices(missing);
        Object.assign(priceMap, yahooResults);
      }
      Object.keys(priceMap).forEach(c => priceCache.set(c, { p: priceMap[c], ts: Date.now() }));
    }
    res.json(priceMap);
  } catch (err) { res.status(500).json({}); }
});

// ★★★ AI 分析 API (智慧偵測版) ★★★
let cachedModelName = null; 

async function getBestModel() {
  if (cachedModelName) return cachedModelName;
  
  console.log("🔍 正在向 Google 查詢可用模型列表...");
  try {
    const listUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_API_KEY}`;
    const response = await fetch(listUrl);
    const data = await response.json();
    
    if (data.models) {
      const validModels = data.models.filter(m => 
        m.name.includes('gemini') && 
        m.supportedGenerationMethods && 
        m.supportedGenerationMethods.includes('generateContent')
      );

      if (validModels.length > 0) {
        let best = validModels.find(m => m.name.includes('flash'));
        if (!best) best = validModels.find(m => m.name.includes('pro'));
        if (!best) best = validModels[0];
        
        cachedModelName = best.name.replace('models/', '');
        console.log(`✅ 自動偵測到可用模型: ${cachedModelName}`);
        return cachedModelName;
      }
    }
    console.warn("⚠️ 查無可用模型，將使用預設值 gemini-pro");
  } catch (e) {
    console.error("❌ 查詢模型列表失敗:", e);
  }
  return "gemini-pro";
}

app.post('/api/ai_analyze', async (req, res) => {
  const { prompt } = req.body;
  
  try {
    const modelName = await getBestModel();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${GEMINI_API_KEY}`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`Google API Error (${modelName}): ${response.status}`, errText);
      if (response.status === 404) cachedModelName = null;
      throw new Error(`Google API Error: ${response.status} ${errText}`);
    }

    const data = await response.json();
    if (data.candidates && data.candidates.length > 0) {
      const text = data.candidates[0].content.parts[0].text;
      res.json({ success: true, text: text });
    } else {
      res.json({ success: false, error: 'AI 沒有返回結果' });
    }
  } catch (error) {
    console.error('AI API Error:', error);
    res.status(500).json({ success: false, error: 'AI 服務暫時無法使用', details: error.message });
  }
});

// 一般資料 API
app.get('/api/get_data', async (req, res) => {
  try {
    const holdings = await Holding.find(req.query.userId ? { userId: req.query.userId } : {}).sort({ createdAt: -1 });
    res.json(holdings);
  } catch (e) { res.status(500).json([]); }
});

app.post('/api/save_data', async (req, res) => {
  try {
    const h = new Holding(req.body);
    await h.save();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/update_position', async (req, res) => {
  try {
    const { userId, client, code } = req.body;
    await Holding.findOneAndUpdate({ userId, client, code }, { $set: req.body }, { upsert: true });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/delete_position', async (req, res) => {
  try { await Holding.deleteOne(req.body); res.json({ success: true }); } 
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/update_client_profile', async (req, res) => {
  try {
    const { userId, client, clientProfile } = req.body;
    await Holding.updateMany({ userId, client }, { $set: { clientProfile } });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username === 'admin' && password === 'Qq112233.') {
    res.json({ success: true, token: 'admin_token_' + Date.now() });
  } else {
    res.json({ success: false, message: '帳號或密碼錯誤' });
  }
});

app.get('/admin.html', (req, res) => res.send(getAdminPageHTML()));
app.get('/admin', (req, res) => res.send(getAdminPageHTML()));

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

// ==========================================
// ★ 內嵌的後台 HTML
// ==========================================
function getAdminPageHTML() {
  return `
<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>後台管理系統 - Stock Tracker</title>

  <!-- Bootstrap -->
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">

  <style>
    body {
      background-color: #f3f4f6;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: #111827;
    }

    .login-card {
      max-width: 400px;
      margin: 120px auto;
      padding: 32px 28px;
      background: #ffffff;
      border-radius: 18px;
      box-shadow: 0 16px 40px rgba(15,23,42,0.18);
      border: 1px solid #e5e7eb;
    }
    .login-card h3 {font-weight:800;color:#111827;}
    .login-card .form-label{font-size:13px;color:#6b7280;}
    .login-card .form-control{
      border-radius:999px;
      font-size:14px;
    }
    .login-card .btn-primary{
      border-radius:999px;
      font-weight:700;
    }

    .dashboard { display: none; padding: 18px; }

    .page-header {
      padding: 14px 22px;
      margin-bottom: 14px;
      border-radius: 16px;
      background: #ffffff;
      box-shadow: 0 10px 25px rgba(15,23,42,0.08);
      border: 1px solid #e5e7eb;
    }
    .page-title {
      font-size: 20px;
      font-weight: 800;
      display:flex;
      align-items:center;
      gap:10px;
      color:#111827;
    }
    .page-subtitle {
      font-size: 12px;
      color: #6b7280;
    }
    .pill {
      padding:4px 10px;
      border-radius:999px;
      background:#eff6ff;
      border:1px solid #bfdbfe;
      font-size:11px;
      color:#1d4ed8;
    }
    .header-right .btn {
      border-radius:999px;
      font-size:12px;
      padding:6px 14px;
    }
    .btn-icon{
      display:inline-flex;
      align-items:center;
      gap:6px;
    }

    .stat-card {
      background: #ffffff;
      border-radius: 14px;
      padding: 14px 16px;
      box-shadow: 0 8px 18px rgba(15,23,42,0.05);
      border: 1px solid #e5e7eb;
    }
    .stat-title { font-size:12px; color:#6b7280; }
    .stat-value { font-size:20px; font-weight:800; color:#111827;}

    .text-up { color:#16a34a; }
    .text-down { color:#b91c1c; }

    .tab-pill.nav-pills .nav-link {
      border-radius: 999px;
      padding: 5px 14px;
      font-size: 12px;
      color:#6b7280;
      border:1px solid transparent;
    }
    .tab-pill.nav-pills .nav-link:hover{
      background:#f3f4f6;
    }
    .tab-pill.nav-pills .nav-link.active {
      background: #111827;
      color:#f9fafb;
      border-color:#111827;
    }

    .card-main {
      background: #ffffff;
      border-radius:16px;
      box-shadow: 0 12px 28px rgba(15,23,42,0.06);
      border: 1px solid #e5e7eb;
    }

    .toolbar-row{
      display:flex;
      justify-content:space-between;
      align-items:center;
      margin-bottom:10px;
      gap:10px;
    }
    .toolbar-left{
      display:flex;
      align-items:center;
      gap:8px;
    }
    .toolbar-right{
      display:flex;
      align-items:center;
      gap:8px;
    }
    .mini-label{
      font-size:11px;
      color:#6b7280;
      margin-right:4px;
    }
    .search-input { max-width: 260px; }

    .form-select, .form-control{
      font-size:12px;
    }

    .table-dark {
      background:#111827;
      color:#e5e7eb;
    }
    .table-dark th{
      border-bottom-color:#1f2937!important;
      font-size:11px;
      letter-spacing:0.03em;
    }
    tbody td{
      border-bottom:1px solid #e5e7eb!important;
      font-size:12px;
      color:#374151;
    }
    .table-hover tbody tr:hover{
      background-color:#f9fafb;
    }
    .small-muted{font-size:11px;color:#6b7280;}
  </style>
</head>
<body>

  <!-- 登錄介面 -->
  <div id="loginSection" class="container">
    <div class="login-card">
      <h3 class="text-center mb-4">後台管理登入</h3>

      <div class="mb-3">
        <label class="form-label">帳號</label>
        <input type="text" id="username" placeholder="請輸入帳號" class="form-control">
      </div>

      <div class="mb-3">
        <label class="form-label">密碼</label>
        <input type="password" id="password" placeholder="請輸入密碼" class="form-control">
      </div>

      <button onclick="handleLogin()" class="btn btn-primary w-100 mt-2">登入系統</button>
      <p id="loginError" class="text-danger mt-3 text-center" style="display:none;">帳號或密碼錯誤</p>
    </div>
  </div>

  <!-- 儀表板 -->
  <div id="dashboardSection" class="dashboard container-fluid">
    <div class="page-header d-flex justify-content-between align-items-center flex-wrap gap-3">
      <div>
        <div class="page-title">
          客戶持倉監控面板
          <span class="pill">Admin Console</span>
        </div>
        <div class="page-subtitle">
          以「客戶」為中心，彙總檢視所有持股與風險狀態
        </div>
        <div id="lastFetchTime" class="small-muted mt-1"></div>
      </div>

      <div class="header-right d-flex align-items-center gap-2 flex-wrap">
        <div class="form-check form-switch text-nowrap">
          <input class="form-check-input" type="checkbox" id="autoRefreshSwitch">
          <label class="form-check-label small" for="autoRefreshSwitch">自動刷新 (10 秒)</label>
        </div>
        <button onclick="fetchData()" class="btn btn-success btn-sm btn-icon">
          <span>🔄 立即刷新</span>
        </button>
        <button onclick="logout()" class="btn btn-outline-danger btn-sm btn-icon">
          <span>登出</span>
        </button>
      </div>
    </div>

    <!-- 整體統計 -->
    <div class="row g-3 mb-3">
      <div class="col-6 col-md-3">
        <div class="stat-card">
          <div class="stat-title">客戶總數</div>
          <div class="stat-value" id="statClientCount">-</div>
        </div>
      </div>
      <div class="col-6 col-md-3">
        <div class="stat-card">
          <div class="stat-title">總持倉筆數</div>
          <div class="stat-value" id="statHoldingCount">-</div>
        </div>
      </div>
      <div class="col-6 col-md-3">
        <div class="stat-card">
          <div class="stat-title">總持股數量</div>
          <div class="stat-value" id="statQty">-</div>
        </div>
      </div>
      <div class="col-6 col-md-3">
        <div class="stat-card">
          <div class="stat-title">推薦飆股客戶數</div>
          <div class="stat-value" id="statRecClientCount">-</div>
        </div>
      </div>
    </div>

    <!-- 類型篩選 -->
    <ul class="nav nav-pills mb-2 tab-pill" id="typeTab" role="tablist">
      <li class="nav-item" role="presentation">
        <button class="nav-link active" id="tabAll" data-bs-toggle="pill" type="button" onclick="setFilterType('all')">全部客戶</button>
      </li>
      <li class="nav-item" role="presentation">
        <button class="nav-link" id="tabRec" data-bs-toggle="pill" type="button" onclick="setFilterType('rec')">有推薦飆股</button>
      </li>
      <li class="nav-item" role="presentation">
        <button class="nav-link" id="tabRisk" data-bs-toggle="pill" type="button" onclick="setFilterType('loss')">整體虧損中</button>
      </li>
    </ul>

    <!-- 主內容 -->
    <div class="row">
      <div class="col-lg-9 mb-3">
        <div class="card card-main">
          <div class="card-body">
            <div class="toolbar-row">
              <div class="toolbar-left">
                <span class="mini-label">搜尋客戶 / 股票</span>
                <input type="text" id="searchInput" class="form-control form-control-sm search-input" placeholder="輸入客戶姓名或股票名稱/代碼">
              </div>
              <div class="toolbar-right">
                <span class="mini-label">排序</span>
                <select id="sortSelect" class="form-select form-select-sm" style="min-width: 210px;">
                  <option value="value_desc">按客戶總市值（大 → 小）</option>
                  <option value="value_asc">按客戶總市值（小 → 大）</option>
                  <option value="pnl_desc">按整體盈虧（高 → 低）</option>
                  <option value="pnl_asc">按整體盈虧（低 → 高）</option>
                  <option value="time_desc">按最新提交時間</option>
                </select>
              </div>
            </div>

            <div id="tableView">
              <div class="table-responsive">
                <table class="table table-hover table-striped align-middle mb-0">
                  <thead class="table-dark">
                    <tr>
                      <th style="width:18%;">客戶姓名</th>
                      <th>持有股票概況</th>
                      <th class="text-end" style="width:10%;">股票檔數</th>
                      <th class="text-end" style="width:12%;">總持股數</th>
                      <th class="text-end" style="width:14%;">總市值</th>
                      <th class="text-end" style="width:14%;">整體盈虧</th>
                      <th class="text-end" style="width:10%;">報酬率</th>
                      <th style="width:12%;">狀態</th>
                    </tr>
                  </thead>
                  <tbody id="tableBody"></tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="col-lg-3 mb-3">
        <div class="stat-card mb-3">
          <h6 class="mb-2">⚖️ 目前整體盈虧</h6>
          <div class="d-flex flex-column gap-1">
            <div class="d-flex justify-content-between">
              <span class="stat-title">估算總市值</span>
              <span id="statValue" class="fw-semibold">-</span>
            </div>
            <div class="d-flex justify-content-between">
              <span class="stat-title">估算總盈虧</span>
              <span id="statPnl" class="fw-semibold">-</span>
            </div>
            <div class="d-flex justify-content-between">
              <span class="stat-title">整體報酬率</span>
              <span id="statPnlRate" class="fw-semibold">-</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>

  <script>
    const API_BASE = '/api';
    let allHoldings = [];
    let groupByClient = [];
    let filterType = 'all';
    let searchText = '';
    let sortMode = 'value_desc';
    let autoRefreshTimer = null;

    if (localStorage.getItem('adminToken')) {
      showDashboard();
    }

    async function handleLogin() {
      const username = document.getElementById('username').value.trim();
      const password = document.getElementById('password').value.trim();
      const errorEl = document.getElementById('loginError');

      errorEl.style.display = 'none';
      try {
        const res = await fetch(API_BASE + '/admin/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password })
        });
        const result = await res.json();
        if (result.success) {
          localStorage.setItem('adminToken', result.token);
          showDashboard();
        } else {
          errorEl.textContent = result.message || '帳號或密碼錯誤';
          errorEl.style.display = 'block';
        }
      } catch (e) {
        errorEl.textContent = '登入失敗';
        errorEl.style.display = 'block';
      }
    }

    function showDashboard() {
      document.getElementById('loginSection').style.display = 'none';
      document.getElementById('dashboardSection').style.display = 'block';
      fetchData();
    }

    function logout() {
      localStorage.removeItem('adminToken');
      if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; }
      document.getElementById('dashboardSection').style.display = 'none';
      document.getElementById('loginSection').style.display = 'block';
    }

    function setFilterType(type) {
      filterType = type;
      document.getElementById('tabAll').classList.toggle('active', type === 'all');
      document.getElementById('tabRec').classList.toggle('active', type === 'rec');
      document.getElementById('tabRisk').classList.toggle('active', type === 'loss');
      render();
    }

    document.getElementById('searchInput').addEventListener('input', (e) => {
      searchText = e.target.value.trim().toLowerCase();
      render();
    });

    document.getElementById('sortSelect').addEventListener('change', (e) => {
      sortMode = e.target.value;
      render();
    });

    document.getElementById('autoRefreshSwitch').addEventListener('change', (e) => {
      if (e.target.checked) {
        fetchData();
        autoRefreshTimer = setInterval(fetchData, 10000);
      } else if (autoRefreshTimer) {
        clearInterval(autoRefreshTimer);
        autoRefreshTimer = null;
      }
    });

    async function fetchData() {
      const tbody = document.getElementById('tableBody');
      try {
        const res = await fetch(API_BASE + '/get_data');
        const data = await res.json();
        allHoldings = Array.isArray(data) ? data : [];

        const codes = [...new Set(allHoldings.map(r => r.code).filter(Boolean))];
        if (codes.length > 0) {
          const priceRes = await fetch(API_BASE + '/prices', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ codes })
          });
          const priceMap = await priceRes.json();
          allHoldings = allHoldings.map(row => {
            const price = priceMap[String(row.code || '')];
            return { ...row, currentPrice: typeof price === 'number' ? price : undefined };
          });
        }

        document.getElementById('lastFetchTime').textContent = '最後刷新：' + new Date().toLocaleString('zh-TW');
        buildClientGroups();
        render();
      } catch (e) {
        tbody.innerHTML = '<tr><td colspan="8" class="text-center text-danger">載入失敗</td></tr>';
      }
    }

    function buildClientGroups() {
      const map = {};
      allHoldings.forEach(row => {
        const client = row.client || '未命名客戶';
        const qty = Number(row.quantity) || 0;
        const cost = Number(row.cost) || 0;
        const cur = Number(row.currentPrice ?? row.cost) || 0;
        const value = qty * cur;

        if (!map[client]) {
          map[client] = {
            client, holdings: [], totalQty: 0, totalCost: 0, totalValue: 0,
            hasRecommend: false, latestTime: row.createdAt ? new Date(row.createdAt) : new Date(0)
          };
        }

        map[client].holdings.push(row);
        map[client].totalQty += qty;
        map[client].totalCost += qty * cost;
        map[client].totalValue += value;
        if (row.recommendType === 'yes') map[client].hasRecommend = true;
      });
      groupByClient = Object.values(map);
    }

    function getFilteredAndSortedGroups() {
      let groups = [...groupByClient];
      if (searchText) {
        groups = groups.filter(g => {
          if (g.client.toLowerCase().includes(searchText)) return true;
          return g.holdings.some(h => (h.stockName || '').toLowerCase().includes(searchText) || (h.code || '').toLowerCase().includes(searchText));
        });
      }
      groups = groups.filter(g => {
        const pnl = g.totalValue - g.totalCost;
        if (filterType === 'rec') return g.hasRecommend;
        if (filterType === 'loss') return pnl < 0;
        return true;
      });
      groups.sort((a, b) => {
        const pnlA = a.totalValue - a.totalCost;
        const pnlB = b.totalValue - b.totalCost;
        if (sortMode === 'value_desc') return b.totalValue - a.totalValue;
        if (sortMode === 'value_asc') return a.totalValue - b.totalValue;
        if (sortMode === 'pnl_desc') return pnlB - pnlA;
        if (sortMode === 'pnl_asc') return pnlA - pnlB;
        return 0;
      });
      return groups;
    }

    function render() {
      const groups = getFilteredAndSortedGroups();
      const tbody = document.getElementById('tableBody');
      let totalQty = 0, totalCost = 0, totalValue = 0, recClientCount = 0;

      groupByClient.forEach(g => {
        totalQty += g.totalQty;
        totalCost += g.totalCost;
        totalValue += g.totalValue;
        if (g.hasRecommend) recClientCount++;
      });

      document.getElementById('statClientCount').textContent = groupByClient.length;
      document.getElementById('statHoldingCount').textContent = allHoldings.length;
      document.getElementById('statQty').textContent = totalQty.toLocaleString('zh-TW');
      document.getElementById('statRecClientCount').textContent = recClientCount;
      document.getElementById('statValue').textContent = totalValue.toLocaleString('zh-TW', { maximumFractionDigits: 0 });

      const totalPnl = totalValue - totalCost;
      const pnlEl = document.getElementById('statPnl');
      const rateEl = document.getElementById('statPnlRate');

      if (totalCost > 0) {
        const pnlRate = (totalPnl / totalCost) * 100;
        pnlEl.textContent = (totalPnl >= 0 ? '+' : '') + totalPnl.toFixed(0);
        pnlEl.className = 'fw-semibold ' + (totalPnl >= 0 ? 'text-up' : 'text-down');
        rateEl.textContent = (pnlRate >= 0 ? '+' : '') + pnlRate.toFixed(2) + '%';
        rateEl.className = 'fw-semibold ' + (pnlRate >= 0 ? 'text-up' : 'text-down');
      }

      if (!groups.length) {
        tbody.innerHTML = '<tr><td colspan="8" class="text-center text-muted">目前沒有符合條件的客戶</td></tr>';
        return;
      }

      tbody.innerHTML = groups.map(g => {
        const pnl = g.totalValue - g.totalCost;
        const rate = g.totalCost > 0 ? (pnl / g.totalCost) * 100 : 0;
        const pnlClass = pnl >= 0 ? 'text-up' : 'text-down';
        const rateStr = g.totalCost > 0 ? (rate >= 0 ? '+' : '') + rate.toFixed(2) + '%' : '-';
        const recTag = g.hasRecommend ? '<span class="badge bg-primary">有推薦飆股</span>' : '';
        const summaryText = g.holdings.map(h => \`\${h.stockName}(\${h.code})\`).join(', ');

        return \`
          <tr>
            <td><strong>\${g.client}</strong></td>
            <td><span class="small text-muted">\${summaryText}</span></td>
            <td class="text-end">\${g.holdings.length}</td>
            <td class="text-end">\${g.totalQty.toLocaleString()}</td>
            <td class="text-end">\${g.totalValue.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}</td>
            <td class="text-end \${pnlClass}">\${(pnl >= 0 ? '+' : '') + pnl.toFixed(0)}</td>
            <td class="text-end \${pnlClass}">\${rateStr}</td>
            <td>\${recTag}</td>
          </tr>
        \`;
      }).join('');
    }
  </script>
</body>
</html>
  \`;
}