// 輔助函式：呼叫官方標準 Gemini API 模型
async function callGeminiApi(prompt) {
  // 使用最標準且穩定的模型清單
  const models = [
    "gemini-2.0-flash",
    "gemini-1.5-flash",
    "gemini-1.5-pro"
  ];
  let lastError = null;

  for (const modelName of models) {
    try {
      // 官方標準 Endpoint
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
      
      const response = await axios.post(
        url,
        {
          contents: [
            {
              parts: [{ text: prompt }]
            }
          ]
        },
        { 
          headers: { 'Content-Type': 'application/json' },
          timeout: 10000 // 設定 10 秒超時保護
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
