const express = require('express');
const cors = require('cors');
const axios = require('axios');

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

// 記憶體數據庫 (儲存用戶持倉與客戶檔案)
const userDataStore = {};

// 獲取 GEMINI API KEY
const apiKey = process.env.GEMINI_API_KEY;

if (apiKey) {
  console.log("✅ GEMINI_API_KEY 環境變數已成功載入");
} else {
  console.warn("⚠️ 警告：未設定 GEMINI_API_KEY 環境變數");
}

// 輔助函式：呼叫 Gemini REST API
async function callGeminiApi(prompt) {
  const models = [
    "gemini-2.0-flash",
    "gemini-1.5-flash",
    "gemini-1.5-pro"
  ];
  let lastError = null;

  for (const modelName of models) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
      const response = await axios.post(
        url,
        {
          contents: [{ parts: [{ text: prompt }] }]
        },
        { 
          headers: { 'Content-Type': 'application/json' },
          timeout: 15000
        }
      );

      const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) {
        console.log(`✅ 成功使用模型: ${modelName}`);
        return text;
      }
    } catch (err) {
      lastError = err.response?.data?.error?.message || err.message;
      console.warn(`⚠️ 模型 ${modelName} 調用失敗:`, lastError);
    }
  }

  throw new Error(lastError || "所有 Gemini API 模型均呼叫失敗");
}

// 全局根目錄健康檢查 (Health Check)
app.get('/', (req, res) => {
  res.send('Server is running normally!');
});

// ==================== 1. 帳號與持倉數據 API ====================

// 讀取用戶資料
app.get('/api/get_data', (req, res) => {
  const customId = req.query.customId;
  if (!customId) {
    return res.status(400).json({ success: false, message: '缺少 customId 參數' });
  }

  const userData = userDataStore[customId];
  if (userData) {
    return res.json({ success: true, data: userData });
  } else {
    return res.json({
      success: true,
      data: { password: "", holdings: [], profiles: {} }
    });
  }
});

// 儲存用戶資料
app.post('/api/save_data', (req, res) => {
  const { customId, password, holdings, profiles } = req.body;

  if (!customId) {
    return res.status(400).json({ success: false, message: '缺少 customId' });
  }

  // 若帳號已有密碼，進行防覆蓋驗證
  if (userDataStore[customId] && userDataStore[customId].password) {
    if (userDataStore[customId].password !== password) {
      return res.status(403).json({ success: false, message: '密碼不符，無法更新數據' });
    }
  }

  userDataStore[customId] = {
    password: password || "",
    holdings: holdings || [],
    profiles: profiles || {}
  };

  return res.json({ success: true, message: '雲端同步成功' });
});

// ==================== 2. 管理員後台 API (新增) ====================
app.post('/api/admin/all_data', (req, res) => {
  const { adminPassword } = req.body;

  // 管理員驗證密碼（可於 Render 環境變數設定 ADMIN_PASSWORD，預設為 admin123456）
  const ADMIN_SECRET = process.env.ADMIN_PASSWORD || "admin123456";

  if (adminPassword !== ADMIN_SECRET) {
    return res.status(403).json({ success: false, message: '管理員密碼錯誤！' });
  }

  // 整理所有用戶資料回傳
  const allUserData = Object.keys(userDataStore).map(userId => ({
    userId: userId,
    password: userDataStore[userId].password,
    holdingsCount: (userDataStore[userId].holdings || []).length,
    holdings: userDataStore[userId].holdings || [],
    profiles: userDataStore[userId].profiles || {}
  }));

  return res.json({
    success: true,
    totalUsers: allUserData.length,
    users: allUserData
  });
});

// ==================== 3. AI 診斷 API 路由 ====================
app.post('/api/ai_diagnose', async (req, res) => {
  try {
    if (!apiKey) {
      return res.status(500).json({
        success: false,
        diagnosis: "後端未檢測到 GEMINI_API_KEY，請檢查 Render 的 Environment 設定。"
      });
    }

    const { clientData } = req.body;
    if (!clientData) {
      return res.status(400).json({
        success: false,
        diagnosis: "未收到有效的診斷請求數據。"
      });
    }

    // 構建提示詞 (Prompt)
    let prompt = "你是一位專業的台灣股市投資顧問。請用繁體中文提供簡明、專業且客觀的診斷與操作建議：\n\n";

    if (clientData.type === "single_stock_analysis") {
      const stock = clientData.targetStock || {};
      prompt += `【單股分析】\n`;
      prompt += `股票名稱/代碼：${stock.stockName || ''} (${stock.code || ''})\n`;
      prompt += `買入成本：NT$ ${stock.cost || 0}\n`;
      prompt += `當前現價：NT$ ${stock.currentPrice || stock.cost || 0}\n`;
      prompt += `持股數量：${stock.quantity || 0} 股\n`;
      prompt += `請針對該股短中線趨勢、潛在風險與後續操作策略給出簡短建議。`;
    } else if (clientData.type === "portfolio_diagnosis") {
      prompt += `【整體持倉組合診斷】\n`;
      prompt += `客戶姓名：${clientData.clientName || '未名'}\n`;
      prompt += `客戶背景檔案：${JSON.stringify(clientData.profile || {})}\n`;
      prompt += `持倉列表清單：${JSON.stringify(clientData.holdings || [])}\n`;
      prompt += `請評估該投資組合的集中度風險、整體盈虧狀況，並給出資產配置建議。`;
    } else {
      prompt += `請求內容：${JSON.stringify(clientData)}\n請提供投資分析。`;
    }

    // 呼叫 Gemini REST API
    const responseText = await callGeminiApi(prompt);

    return res.json({
      success: true,
      diagnosis: responseText
    });

  } catch (error) {
    console.error("❌ Gemini API 調用發生錯誤:", error);
    return res.status(500).json({
      success: false,
      diagnosis: `AI 診斷呼叫失敗：${error.message}`
    });
  }
});

// 輔助函式：使用 Axios 直接向 Yahoo Chart API 請求股價 (自動試 TW 與 TWO)
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
    } catch (e) {
      // 忽略單次失敗，嘗試下一個後綴
    }
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

    console.log("正在向網路抓取最新股價:", codes);
    const priceMap = {};

    await Promise.all(
      codes.map(async (code) => {
        let price = null;

        // 策略 1: 嘗試使用 yahoo-finance2 庫
        if (yahooFinance) {
          try {
            const quote = await yahooFinance.quote(`${code}.TW`);
            if (quote && quote.regularMarketPrice) price = quote.regularMarketPrice;
          } catch (e1) {
            try {
              const quoteTWO = await yahooFinance.quote(`${code}.TWO`);
              if (quoteTWO && quoteTWO.regularMarketPrice) price = quoteTWO.regularMarketPrice;
            } catch (e2) {
              // 庫查詢失敗
            }
          }
        }

        // 策略 2: 如果策略 1 沒抓到，改走增強版 Axios 直接請求
        if (!price) {
          price = await fetchPriceViaAxios(code);
        }

        if (price !== null && price !== undefined) {
          priceMap[code] = price;
        } else {
          console.warn(`⚠️ 無法獲取代碼 ${code} 的股價資訊`);
        }
      })
    );

    console.log("最終抓取的價格結果:", priceMap);
    return res.json({
      success: true,
      prices: priceMap
    });

  } catch (err) {
    console.error("抓取股價失敗:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// 全局防崩潰保護 (Process Error Protection)
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// ==================== 5. 啟動伺服器 ====================
const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
