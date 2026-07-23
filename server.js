const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// 修正 yahoo-finance2 引入方式
const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance();

const app = express();

// 啟用 CORS 與 JSON 解析 middleware
app.use(cors());
app.use(express.json());

// 初始化 Gemini AI Client
const apiKey = process.env.GEMINI_API_KEY;
let genAI = null;

if (apiKey) {
  genAI = new GoogleGenerativeAI(apiKey);
  console.log("✅ GEMINI_API_KEY 環境變數已成功載入");
} else {
  console.warn("⚠️ 警告：未設定 GEMINI_API_KEY 環境變數");
}

// ==================== 1. AI 診斷 API 路由 ====================
app.post('/api/ai_diagnose', async (req, res) => {
  try {
    if (!genAI) {
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

    // 使用 gemini-2.0-flash 模型
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    const result = await model.generateContent(prompt);
    const responseText = result.response.text();

    return res.json({
      success: true,
      diagnosis: responseText
    });

  } catch (error) {
    console.error("❌ Gemini API 調用發生錯誤:", error);
    return res.status(500).json({
      success: false,
      diagnosis: `AI 診斷呼叫失敗，原因：${error.message}`
    });
  }
});

// ==================== 2. 股價抓取 API 路由 ====================
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
        try {
          const symbolTW = `${code}.TW`;
          const quote = await yahooFinance.quote(symbolTW);
          if (quote && quote.regularMarketPrice) {
            priceMap[code] = quote.regularMarketPrice;
          }
        } catch (e) {
          try {
            const symbolTWO = `${code}.TWO`;
            const quoteTWO = await yahooFinance.quote(symbolTWO);
            if (quoteTWO && quoteTWO.regularMarketPrice) {
              priceMap[code] = quoteTWO.regularMarketPrice;
            }
          } catch (err) {
            console.warn(`無法獲取代碼 ${code} 的股價資訊`);
          }
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

// ==================== 3. 啟動伺服器 ====================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
