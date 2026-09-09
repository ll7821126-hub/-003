const express = require('express');
const cors = require('cors');
const axios = require('axios');
const mongoose = require('mongoose');
const crypto = require('crypto');
const { promisify } = require('util');

const app = express();
app.set('trust proxy', 1);

const defaultOrigins = [
  'https://ll7821126-hub.github.io',
  'http://localhost:3000',
  'http://localhost:5500',
  'http://localhost:8080',
  'http://localhost:10000',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5500',
  'http://127.0.0.1:8080',
  'http://127.0.0.1:10000'
];
const allowedOrigins = new Set(
  String(process.env.ALLOWED_ORIGINS || defaultOrigins.join(','))
    .split(',')
    .map(origin => origin.trim().replace(/\/$/, ''))
    .filter(Boolean)
);

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'"
  });
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin.replace(/\/$/, ''))) return callback(null, true);
    return callback(null, false);
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Cache-Control'],
  maxAge: 86400
}));
app.use(express.json({ limit: '20mb' }));

function sendError(res, status, code, message, details) {
  const payload = { success: false, message, error: { code, message } };
  if (details !== undefined) payload.error.details = details;
  return res.status(status).json(payload);
}

const asyncRoute = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

app.use((error, req, res, next) => {
  if (error?.type === 'entity.too.large') return sendError(res, 413, 'PAYLOAD_TOO_LARGE', '請求內容過大');
  if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
    return sendError(res, 400, 'INVALID_JSON', 'JSON 格式錯誤');
  }
  return next(error);
});

const rateLimitBuckets = new Map();
function createRateLimit(name, { windowMs, max, key = req => req.ip }) {
  return (req, res, next) => {
    const now = Date.now();
    const bucketKey = `${name}:${String(key(req) || req.ip || 'unknown').slice(0, 180)}`;
    const current = rateLimitBuckets.get(bucketKey);
    const bucket = !current || current.resetAt <= now ? { count: 0, resetAt: now + windowMs } : current;
    bucket.count += 1;
    rateLimitBuckets.set(bucketKey, bucket);
    res.set('RateLimit-Limit', String(max));
    res.set('RateLimit-Remaining', String(Math.max(0, max - bucket.count)));
    res.set('RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));
    if (bucket.count > max) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
      return sendError(res, 429, 'RATE_LIMITED', '操作過於頻繁，請稍後再試');
    }
    return next();
  };
}
const loginRateLimit = createRateLimit('user-login', { windowMs: 15 * 60 * 1000, max: 12 });
const adminLoginRateLimit = createRateLimit('admin-login', { windowMs: 15 * 60 * 1000, max: 8 });
const adminRateLimit = createRateLimit('admin', { windowMs: 15 * 60 * 1000, max: 120 });
const ocrRateLimit = createRateLimit('ocr', {
  windowMs: 10 * 60 * 1000,
  max: 10,
  key: req => `${req.ip}:${req.auth?.sub || 'anonymous'}`
});
const bucketCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, value] of rateLimitBuckets) if (value.resetAt <= now) rateLimitBuckets.delete(key);
}, 10 * 60 * 1000);
bucketCleanupTimer.unref?.();

// ==================== 連接 MongoDB 雲端資料庫 ====================
const MONGODB_URI = process.env.MONGODB_URI;

if (MONGODB_URI) {
  mongoose.connect(MONGODB_URI)
    .then(() => console.log("✅ 成功連接至 MongoDB 雲端資料庫"))
    .catch(err => console.error("❌ MongoDB 連接失敗:", err.message));
} else {
  console.warn("⚠️ 警告：未設定 MONGODB_URI 環境變數，資料將無法永久保存！");
}

// 定義 User 資料結構 Schema。舊欄位只做相容讀取，登入成功後惰性遷移。
const userSchema = new mongoose.Schema({
  customId: { type: String, required: true, unique: true },
  password: { type: String, default: "", select: false },
  passwordHash: { type: String, default: "", select: false },
  authVersion: { type: Number, default: 0 },
  dataVersion: { type: Number, default: 0 },
  deletedAt: { type: Date, default: null },
  deletedBy: { type: String, default: "" },
  deletedClients: { type: Array, default: [] },
  holdings: { type: Array, default: [] },
  profiles: { type: Object, default: {} },
  transactions: { type: Array, default: [] }
}, { timestamps: true });

const User = mongoose.model('User', userSchema);

const auditLogSchema = new mongoose.Schema({
  actorType: { type: String, enum: ['user', 'admin', 'system'], required: true },
  actorId: { type: String, default: '' },
  action: { type: String, required: true },
  success: { type: Boolean, default: true },
  targetUserId: { type: String, default: '' },
  targetClient: { type: String, default: '' },
  ip: { type: String, default: '' },
  userAgent: { type: String, default: '' },
  metadata: { type: Object, default: {} }
}, { timestamps: true, versionKey: false });
const AuditLog = mongoose.model('AuditLog', auditLogSchema);

const backupSchema = new mongoose.Schema({
  _id: { type: String },
  userId: { type: String, required: true },
  day: { type: String, required: true },
  reason: { type: String, default: 'daily_before_write' },
  dataVersion: { type: Number, default: 0 },
  holdings: { type: Array, default: [] },
  profiles: { type: Object, default: {} },
  transactions: { type: Array, default: [] },
  deletedClients: { type: Array, default: [] },
  createdBy: { type: String, default: 'system' }
}, { timestamps: true, versionKey: false });
const Backup = mongoose.model('Backup', backupSchema);

const scryptAsync = promisify(crypto.scrypt);
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const USER_TOKEN_TTL_SECONDS = 12 * 60 * 60;
const ADMIN_TOKEN_TTL_SECONDS = 4 * 60 * 60;
const isProduction = process.env.NODE_ENV === 'production' || process.env.RENDER === 'true' || Boolean(process.env.RENDER_SERVICE_ID);
const configuredAuthSecret = String(process.env.AUTH_SECRET || '');
if (isProduction && configuredAuthSecret.length < 32) {
  throw new Error('正式環境必須設定至少 32 字元的 AUTH_SECRET');
}
const authSecret = configuredAuthSecret || crypto.randomBytes(48).toString('base64url');
if (!configuredAuthSecret) console.warn('⚠️ 未設定 AUTH_SECRET；目前使用只適合本機開發的臨時金鑰，重啟後登入憑證會失效');

function base64urlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function signToken({ sub, role, authVersion = 0, ttlSeconds }) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64urlJson({ alg: 'HS256', typ: 'JWT' });
  const tokenVersion = typeof authVersion === 'string' ? authVersion : (Number(authVersion) || 0);
  const payload = base64urlJson({ v: 1, sub, role, av: tokenVersion, iat: now, exp: now + ttlSeconds });
  const body = `${header}.${payload}`;
  const signature = crypto.createHmac('sha256', authSecret).update(body).digest('base64url');
  return `${body}.${signature}`;
}

function timingSafeTextEqual(left, right) {
  const a = crypto.createHash('sha256').update(String(left)).digest();
  const b = crypto.createHash('sha256').update(String(right)).digest();
  return crypto.timingSafeEqual(a, b);
}

function verifyToken(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    const body = `${parts[0]}.${parts[1]}`;
    const expected = crypto.createHmac('sha256', authSecret).update(body).digest('base64url');
    if (!timingSafeTextEqual(parts[2], expected)) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const now = Math.floor(Date.now() / 1000);
    if (payload?.v !== 1 || !payload.sub || !payload.role || !Number.isFinite(payload.exp) || payload.exp <= now) return null;
    return payload;
  } catch (_) {
    return null;
  }
}

function bearerToken(req) {
  const match = String(req.get('Authorization') || '').match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = await scryptAsync(String(password), salt, 64, SCRYPT_PARAMS);
  return `scrypt$${SCRYPT_PARAMS.N}$${SCRYPT_PARAMS.r}$${SCRYPT_PARAMS.p}$${salt.toString('base64url')}$${Buffer.from(derived).toString('base64url')}`;
}

async function verifyPassword(password, encoded) {
  try {
    const [algorithm, n, r, p, saltText, hashText] = String(encoded || '').split('$');
    if (algorithm !== 'scrypt' || !saltText || !hashText) return false;
    const expected = Buffer.from(hashText, 'base64url');
    const derived = Buffer.from(await scryptAsync(String(password), Buffer.from(saltText, 'base64url'), expected.length, {
      N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT_PARAMS.maxmem
    }));
    return expected.length === derived.length && crypto.timingSafeEqual(expected, derived);
  } catch (_) {
    return false;
  }
}

function validPasswordInput(value, { requireStrong = false } = {}) {
  const password = String(value || '');
  const bytes = Buffer.byteLength(password, 'utf8');
  return bytes <= 256 && bytes >= (requireStrong ? 8 : 1);
}

function adminCredentialVersion() {
  const configured = String(process.env.ADMIN_PASSWORD_HASH || process.env.ADMIN_PASSWORD || '');
  return configured ? crypto.createHash('sha256').update(configured).digest('hex').slice(0, 16) : '';
}

async function verifyAdminPassword(password) {
  const encoded = String(process.env.ADMIN_PASSWORD_HASH || '');
  if (encoded) return verifyPassword(password, encoded);
  const legacy = String(process.env.ADMIN_PASSWORD || '');
  return Boolean(legacy) && timingSafeTextEqual(password, legacy);
}

async function writeAudit(req, entry) {
  try {
    await AuditLog.create({
      actorType: entry.actorType || req?.auth?.role || 'system',
      actorId: entry.actorId || req?.auth?.sub || '',
      action: entry.action,
      success: entry.success !== false,
      targetUserId: entry.targetUserId || '',
      targetClient: entry.targetClient || '',
      ip: String(req?.ip || '').slice(0, 120),
      userAgent: String(req?.get?.('User-Agent') || '').slice(0, 300),
      metadata: entry.metadata || {}
    });
  } catch (error) {
    console.warn(`[Audit] ${entry.action || 'unknown'} 寫入失敗：${error.message}`);
  }
}

function safeUserData(user) {
  return {
    customId: user.customId,
    holdings: Array.isArray(user.holdings) ? user.holdings : [],
    profiles: user.profiles && typeof user.profiles === 'object' ? user.profiles : {},
    transactions: Array.isArray(user.transactions) ? user.transactions : [],
    version: Number.isInteger(user.dataVersion) ? user.dataVersion : 0,
    updatedAt: user.updatedAt || null
  };
}

async function createBackupSnapshot(user, { reason = 'daily_before_write', createdBy = 'system', daily = true } = {}) {
  const day = new Date().toISOString().slice(0, 10);
  const idSeed = daily ? `${user.customId}:${day}` : `${user.customId}:${Date.now()}:${crypto.randomUUID()}`;
  const backupId = crypto.createHash('sha256').update(idSeed).digest('hex');
  const snapshot = {
    _id: backupId,
    userId: user.customId,
    day,
    reason,
    dataVersion: Number.isInteger(user.dataVersion) ? user.dataVersion : 0,
    holdings: Array.isArray(user.holdings) ? user.holdings : [],
    profiles: user.profiles && typeof user.profiles === 'object' ? user.profiles : {},
    transactions: Array.isArray(user.transactions) ? user.transactions : [],
    deletedClients: Array.isArray(user.deletedClients) ? user.deletedClients : [],
    createdBy
  };
  if (daily) return Backup.findOneAndUpdate({ _id: backupId }, { $setOnInsert: snapshot }, { upsert: true, new: true, setDefaultsOnInsert: true });
  return Backup.create(snapshot);
}

async function ensureDailyBackup(user, req, reason = 'daily_before_write') {
  try {
    await createBackupSnapshot(user, { reason, createdBy: req?.auth?.sub || 'system', daily: true });
    return true;
  } catch (error) {
    console.warn(`[Backup] 帳號 ${user?.customId || 'unknown'} 備份失敗但不阻斷寫入：${error.message}`);
    await writeAudit(req, {
      actorType: req?.auth?.role || 'system',
      action: 'backup_failed',
      success: false,
      targetUserId: user?.customId || '',
      metadata: { reason, error: String(error.message || '').slice(0, 240) }
    });
    return false;
  }
}

async function requireUser(req, res, next) {
  const payload = verifyToken(bearerToken(req));
  if (!payload || payload.role !== 'user') return sendError(res, 401, 'AUTH_REQUIRED', '請先登入有效帳號');
  try {
    const user = await User.findOne({ customId: payload.sub, deletedAt: null }).select('+password +passwordHash');
    if (!user || (Number(user.authVersion) || 0) !== (Number(payload.av) || 0)) {
      return sendError(res, 401, 'TOKEN_INVALIDATED', '登入憑證已失效，請重新登入');
    }
    req.auth = payload;
    req.authUser = user;
    return next();
  } catch (error) {
    return sendError(res, 503, 'AUTH_UNAVAILABLE', '帳號驗證服務暫時無法使用');
  }
}

function requireAdmin(req, res, next) {
  const payload = verifyToken(bearerToken(req));
  const credentialVersion = adminCredentialVersion();
  if (!payload || payload.role !== 'admin' || !credentialVersion || payload.av !== credentialVersion) {
    return sendError(res, 401, 'ADMIN_AUTH_REQUIRED', '管理員登入憑證無效或已過期');
  }
  req.auth = payload;
  return next();
}

// 獲取 GEMINI API KEY
const apiKey = process.env.GEMINI_API_KEY;

// 輔助函式：呼叫 Gemini REST API
async function callGeminiApi(prompt) {
  const models = [...new Set([
    process.env.GEMINI_TEXT_MODEL,
    "gemini-3.8-flash",
    "gemini-3.7-flash",
    "gemini-3.6-flash",
    "gemini-3.5-flash-lite",
    process.env.GEMINI_MODEL,
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
app.get('/api/health', (req, res) => res.json({
  success: true,
  service: 'portfolio-os-api',
  database: mongoose.connection.readyState === 1 ? 'connected' : 'unavailable',
  authConfigured: Boolean(configuredAuthSecret),
  adminConfigured: Boolean(adminCredentialVersion()),
  time: new Date().toISOString()
}));

// ==================== 全台股清單與搜尋 API ====================
let allTaiwanStocks = [];
let taiwanMarketByCode = new Map();

// 伺服器啟動時抓取全台股清單（上市 + 上櫃）
async function loadAllTaiwanStocks() {
  try {
    const twseRes = await axios.get('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL', { timeout: 8000 });
    const twseList = (twseRes.data || []).map(item => ({
      code: String(item.Code).trim(),
      name: String(item.Name).trim(),
      market: 'tse'
    }));

    const tpexRes = await axios.get('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes', { timeout: 8000 });
    const tpexList = (tpexRes.data || []).map(item => ({
      code: String(item.SecuritiesCompanyCode || item.Code).trim(),
      name: String(item.CompanyName || item.Name).trim(),
      market: 'otc'
    }));

    const completeList = [...twseList, ...tpexList].filter(s => s.code && s.name);
    taiwanMarketByCode = new Map(completeList.map(stock => [stock.code, stock.market]));
    allTaiwanStocks = completeList;
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

function validAccountId(value) {
  const id = String(value || '').trim();
  return id.length >= 1 && id.length <= 80 && !/[\u0000-\u001f\u007f]/.test(id);
}

function validateBusinessPayload(body) {
  const holdings = body?.holdings;
  const profiles = body?.profiles;
  const transactions = body?.transactions;
  if (!Array.isArray(holdings) || !profiles || typeof profiles !== 'object' || Array.isArray(profiles) || !Array.isArray(transactions)) {
    return { error: '持倉、客戶檔案或交易紀錄格式不正確' };
  }
  if (holdings.length > 5000 || transactions.length > 20000 || Object.keys(profiles).length > 3000) {
    return { error: '資料筆數超過安全上限，請聯絡管理員協助匯入' };
  }
  const bytes = Buffer.byteLength(JSON.stringify({ holdings, profiles, transactions }), 'utf8');
  if (bytes > 16 * 1024 * 1024) return { error: '資料內容過大，請分批整理後再同步' };
  return { holdings, profiles, transactions };
}

function clientSnapshot(user, clientName) {
  const profiles = user.profiles && typeof user.profiles === 'object' ? user.profiles : {};
  return {
    trashId: crypto.randomUUID(),
    userId: user.customId,
    clientName,
    deletedAt: new Date(),
    profile: Object.prototype.hasOwnProperty.call(profiles, clientName) ? profiles[clientName] : null,
    holdings: (user.holdings || []).filter(item => String(item?.client || '未命名客戶') === clientName),
    transactions: (user.transactions || []).filter(item => String(item?.client || '') === clientName)
  };
}

app.post('/api/auth/login', loginRateLimit, async (req, res) => {
  const customId = String(req.body?.customId || '').trim();
  const password = String(req.body?.password || '');
  if (!validAccountId(customId) || !validPasswordInput(password)) {
    return sendError(res, 400, 'INVALID_CREDENTIAL_INPUT', '請輸入有效帳號與密碼');
  }
  try {
    let user = await User.findOne({ customId }).select('+password +passwordHash');
    let created = false;
    let migrated = false;
    if (!user) {
      user = new User({ customId, passwordHash: await hashPassword(password), password: '' });
      await user.save();
      created = true;
    } else {
      if (user.deletedAt) return sendError(res, 403, 'ACCOUNT_IN_TRASH', '此帳號已停用，請聯絡管理員恢復');
      let accepted = false;
      if (user.passwordHash) accepted = await verifyPassword(password, user.passwordHash);
      else if (user.password) accepted = timingSafeTextEqual(password, user.password);
      else accepted = true;
      if (!accepted) {
        await writeAudit(req, { actorType: 'user', actorId: customId, action: 'login_failed', success: false, targetUserId: customId });
        return sendError(res, 401, 'INVALID_CREDENTIALS', '帳號或密碼錯誤');
      }
      if (!user.passwordHash) {
        user.passwordHash = await hashPassword(password);
        user.password = '';
        migrated = true;
        await user.save();
      }
    }
    const token = signToken({ sub: user.customId, role: 'user', authVersion: user.authVersion, ttlSeconds: USER_TOKEN_TTL_SECONDS });
    await writeAudit(req, { actorType: 'user', actorId: customId, action: created ? 'account_created' : (migrated ? 'login_and_password_migrated' : 'login'), targetUserId: customId });
    res.set('Cache-Control', 'no-store');
    return res.json({ success: true, token, expiresIn: USER_TOKEN_TTL_SECONDS, created, migrated, data: safeUserData(user) });
  } catch (error) {
    if (error?.code === 11000) return sendError(res, 409, 'ACCOUNT_RACE', '帳號剛建立完成，請重新登入');
    console.error('帳號登入失敗:', error.message);
    return sendError(res, 500, 'LOGIN_FAILED', '登入服務暫時無法使用');
  }
});

app.get('/api/get_data', requireUser, (req, res) => {
  res.set('Cache-Control', 'no-store');
  return res.json({ success: true, data: safeUserData(req.authUser) });
});

app.post('/api/save_data', requireUser, async (req, res) => {
  const validated = validateBusinessPayload(req.body);
  if (validated.error) return sendError(res, 400, 'INVALID_DATA', validated.error);
  const expectedVersion = Number(req.body?.expectedVersion);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
    return sendError(res, 400, 'VERSION_REQUIRED', '缺少有效的資料版本，請重新載入後再儲存');
  }
  try {
    const current = req.authUser;
    const currentVersion = Number(current.dataVersion) || 0;
    if (currentVersion !== expectedVersion) {
      return res.status(409).json({ success: false, message: '雲端資料已由其他視窗更新', error: { code: 'VERSION_CONFLICT', message: '雲端資料已由其他視窗更新' }, currentVersion });
    }
    await ensureDailyBackup(current, req);
    const versionFilter = expectedVersion === 0
      ? { $or: [{ dataVersion: 0 }, { dataVersion: { $exists: false } }] }
      : { dataVersion: expectedVersion };
    const updated = await User.findOneAndUpdate(
      { _id: current._id, deletedAt: null, ...versionFilter },
      { $set: { holdings: validated.holdings, profiles: validated.profiles, transactions: validated.transactions }, $inc: { dataVersion: 1 } },
      { new: true, runValidators: true }
    );
    if (!updated) {
      const latest = await User.findById(current._id).select('dataVersion').lean();
      return res.status(409).json({ success: false, message: '雲端資料已由其他視窗更新', error: { code: 'VERSION_CONFLICT', message: '雲端資料已由其他視窗更新' }, currentVersion: Number(latest?.dataVersion) || 0 });
    }
    await writeAudit(req, { action: 'data_saved', targetUserId: updated.customId, metadata: { version: updated.dataVersion, holdings: updated.holdings.length, clients: Object.keys(updated.profiles || {}).length, transactions: updated.transactions.length } });
    return res.json({ success: true, message: '雲端同步成功', version: updated.dataVersion, updatedAt: updated.updatedAt });
  } catch (error) {
    console.error('資料同步失敗:', error.message);
    return sendError(res, 500, 'SAVE_FAILED', '雲端同步失敗，您的本機資料仍保留');
  }
});

// 只同步最新行情，不變更 dataVersion，避免五秒行情寫入造成資料版本衝突。
app.post('/api/save_prices', requireUser, async (req, res) => {
  const rawUpdates = Array.isArray(req.body?.updates) ? req.body.updates : [];
  const updates = rawUpdates.map(item => ({
    code: String(item?.code || '').trim(),
    currentPrice: Number(item?.currentPrice),
    lastPriceAt: String(item?.lastPriceAt || new Date().toISOString()).slice(0, 40)
  })).filter(item => /^\d{4,6}$/.test(item.code) && Number.isFinite(item.currentPrice) && item.currentPrice > 0).slice(0, 200);
  if (!updates.length) return res.json({ success: true, updated: 0 });
  try {
    const operations = updates.map(item => ({
      updateOne: {
        filter: { _id: req.authUser._id, deletedAt: null },
        update: { $set: { 'holdings.$[holding].currentPrice': item.currentPrice, 'holdings.$[holding].lastPriceAt': item.lastPriceAt } },
        arrayFilters: [{ 'holding.code': { $in: [item.code, Number(item.code)] } }]
      }
    }));
    const result = await User.collection.bulkWrite(operations, { ordered: false });
    return res.json({ success: true, updated: result.modifiedCount || 0 });
  } catch (error) {
    console.error('行情雲端同步失敗:', error.message);
    return sendError(res, 500, 'PRICE_SYNC_FAILED', '行情同步暫時失敗');
  }
});

app.post('/api/auth/change_password', requireUser, loginRateLimit, asyncRoute(async (req, res) => {
  const currentPassword = String(req.body?.currentPassword || '');
  const newPassword = String(req.body?.newPassword || '');
  if (!validPasswordInput(newPassword, { requireStrong: true })) return sendError(res, 400, 'WEAK_PASSWORD', '新密碼至少需要 8 個字元，且不可超過 256 bytes');
  const user = req.authUser;
  const correct = user.passwordHash ? await verifyPassword(currentPassword, user.passwordHash) : (user.password ? timingSafeTextEqual(currentPassword, user.password) : false);
  if (!correct) return sendError(res, 401, 'INVALID_CURRENT_PASSWORD', '目前密碼不正確');
  user.passwordHash = await hashPassword(newPassword);
  user.password = '';
  user.authVersion = (Number(user.authVersion) || 0) + 1;
  await user.save();
  const token = signToken({ sub: user.customId, role: 'user', authVersion: user.authVersion, ttlSeconds: USER_TOKEN_TTL_SECONDS });
  await writeAudit(req, { action: 'password_changed', targetUserId: user.customId });
  return res.json({ success: true, token, expiresIn: USER_TOKEN_TTL_SECONDS, message: '密碼已更新' });
}));

// ==================== 2. 管理員後台 API (MongoDB 版) ====================

app.post('/api/admin/login', adminLoginRateLimit, asyncRoute(async (req, res) => {
  if (!adminCredentialVersion()) return sendError(res, 503, 'ADMIN_NOT_CONFIGURED', '後端尚未設定管理員密碼');
  const accepted = await verifyAdminPassword(String(req.body?.password || ''));
  if (!accepted) {
    await writeAudit(req, { actorType: 'admin', actorId: 'admin', action: 'admin_login_failed', success: false });
    return sendError(res, 401, 'INVALID_ADMIN_CREDENTIALS', '管理員密碼錯誤');
  }
  const token = signToken({ sub: 'admin', role: 'admin', authVersion: adminCredentialVersion(), ttlSeconds: ADMIN_TOKEN_TTL_SECONDS });
  await writeAudit(req, { actorType: 'admin', actorId: 'admin', action: 'admin_login' });
  res.set('Cache-Control', 'no-store');
  return res.json({ success: true, token, expiresIn: ADMIN_TOKEN_TTL_SECONDS });
}));

app.post('/api/admin/all_data', requireAdmin, adminRateLimit, async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    const allUsers = await User.find({ deletedAt: null }).select('+password +passwordHash').lean();
    const users = allUsers.map(user => ({
      userId: user.customId,
      passwordState: user.passwordHash ? 'hashed' : (user.password ? 'legacy' : 'unset'),
      holdingsCount: (user.holdings || []).length,
      holdings: user.holdings || [],
      profiles: user.profiles || {},
      transactions: user.transactions || [],
      version: Number(user.dataVersion) || 0,
      updatedAt: user.updatedAt || null
    }));
    return res.json({ success: true, totalUsers: users.length, syncedAt: new Date().toISOString(), users });
  } catch (error) {
    return sendError(res, 500, 'ADMIN_READ_FAILED', '管理資料讀取失敗');
  }
});

app.post('/api/admin/reset_password', requireAdmin, adminRateLimit, asyncRoute(async (req, res) => {
  const userId = String(req.body?.userId || '').trim();
  const supplied = req.body?.newPassword === undefined ? '' : String(req.body.newPassword);
  if (!validAccountId(userId)) return sendError(res, 400, 'USER_REQUIRED', '缺少有效帳號');
  const generated = !supplied;
  const newPassword = generated ? `Tw-${crypto.randomBytes(9).toString('base64url')}` : supplied;
  if (!validPasswordInput(newPassword, { requireStrong: true })) return sendError(res, 400, 'WEAK_PASSWORD', '新密碼至少需要 8 個字元');
  const user = await User.findOne({ customId: userId, deletedAt: null }).select('+password +passwordHash');
  if (!user) return sendError(res, 404, 'USER_NOT_FOUND', '找不到使用中的帳號');
  user.passwordHash = await hashPassword(newPassword);
  user.password = '';
  user.authVersion = (Number(user.authVersion) || 0) + 1;
  await user.save();
  await writeAudit(req, { action: 'admin_password_reset', targetUserId: userId, metadata: { generatedTemporaryPassword: generated } });
  return res.json({ success: true, message: '密碼已安全重設', ...(generated ? { temporaryPassword: newPassword } : {}) });
}));

app.post('/api/admin/delete_client', requireAdmin, adminRateLimit, asyncRoute(async (req, res) => {
  const userId = String(req.body?.userId || '').trim();
  const clientName = String(req.body?.clientName || '').trim();
  if (!validAccountId(userId) || !clientName) return sendError(res, 400, 'CLIENT_REQUIRED', '缺少帳號或客戶姓名');
  const user = await User.findOne({ customId: userId, deletedAt: null });
  if (!user) return sendError(res, 404, 'USER_NOT_FOUND', '找不到所屬帳號');
  const snapshot = clientSnapshot(user, clientName);
  if (!snapshot.profile && !snapshot.holdings.length && !snapshot.transactions.length) return sendError(res, 404, 'CLIENT_NOT_FOUND', '找不到該客戶資料');
  await ensureDailyBackup(user, req, 'before_client_delete');
  user.deletedClients = [...(user.deletedClients || []), snapshot];
  user.holdings = (user.holdings || []).filter(item => String(item?.client || '未命名客戶') !== clientName);
  user.transactions = (user.transactions || []).filter(item => String(item?.client || '') !== clientName);
  const profiles = { ...(user.profiles || {}) };
  delete profiles[clientName];
  user.profiles = profiles;
  user.dataVersion = (Number(user.dataVersion) || 0) + 1;
  user.markModified('profiles');
  user.markModified('deletedClients');
  await user.save();
  await writeAudit(req, { action: 'client_moved_to_trash', targetUserId: userId, targetClient: clientName, metadata: { trashId: snapshot.trashId, holdings: snapshot.holdings.length, transactions: snapshot.transactions.length } });
  return res.json({ success: true, message: `客戶 ${clientName} 已移至回收站`, trashId: snapshot.trashId });
}));

app.post('/api/admin/delete_user', requireAdmin, adminRateLimit, asyncRoute(async (req, res) => {
  const userId = String(req.body?.userId || '').trim();
  if (!validAccountId(userId)) return sendError(res, 400, 'USER_REQUIRED', '缺少有效帳號');
  const user = await User.findOne({ customId: userId, deletedAt: null });
  if (!user) return sendError(res, 404, 'USER_NOT_FOUND', '找不到使用中的帳號');
  await ensureDailyBackup(user, req, 'before_user_delete');
  user.deletedAt = new Date();
  user.deletedBy = req.auth.sub;
  user.authVersion = (Number(user.authVersion) || 0) + 1;
  await user.save();
  await writeAudit(req, { action: 'user_moved_to_trash', targetUserId: userId });
  return res.json({ success: true, message: `帳號 ${userId} 已移至回收站` });
}));

app.get('/api/admin/trash', requireAdmin, adminRateLimit, asyncRoute(async (req, res) => {
  const allUsers = await User.find({}).select('customId deletedAt holdings profiles transactions deletedClients updatedAt').lean();
  const deletedUsers = allUsers.filter(user => user.deletedAt).map(user => ({
    userId: user.customId,
    deletedAt: user.deletedAt,
    clientCount: Object.keys(user.profiles || {}).length,
    holdingsCount: (user.holdings || []).length,
    transactionsCount: (user.transactions || []).length
  }));
  const deletedClients = allUsers.flatMap(user => (user.deletedClients || []).map(item => ({ ...item, userId: user.customId })));
  return res.json({ success: true, deletedUsers, deletedClients });
}));

app.post('/api/admin/restore_user', requireAdmin, adminRateLimit, asyncRoute(async (req, res) => {
  const userId = String(req.body?.userId || '').trim();
  const user = await User.findOne({ customId: userId, deletedAt: { $ne: null } });
  if (!user) return sendError(res, 404, 'TRASH_USER_NOT_FOUND', '回收站中找不到該帳號');
  user.deletedAt = null;
  user.deletedBy = '';
  await user.save();
  await writeAudit(req, { action: 'user_restored', targetUserId: userId });
  return res.json({ success: true, message: `帳號 ${userId} 已恢復` });
}));

app.post('/api/admin/restore_client', requireAdmin, adminRateLimit, asyncRoute(async (req, res) => {
  const userId = String(req.body?.userId || '').trim();
  const trashId = String(req.body?.trashId || '').trim();
  const user = await User.findOne({ customId: userId });
  if (!user) return sendError(res, 404, 'USER_NOT_FOUND', '找不到所屬帳號');
  const index = (user.deletedClients || []).findIndex(item => String(item?.trashId || item?._id || '') === trashId);
  if (index < 0) return sendError(res, 404, 'TRASH_CLIENT_NOT_FOUND', '回收站中找不到該客戶');
  const snapshot = user.deletedClients[index];
  const name = String(snapshot.clientName || '未命名客戶');
  const exists = Object.prototype.hasOwnProperty.call(user.profiles || {}, name) || (user.holdings || []).some(item => String(item?.client || '未命名客戶') === name);
  if (exists) return sendError(res, 409, 'CLIENT_NAME_CONFLICT', '目前已有同名客戶，請先重新命名或處理現有資料');
  await ensureDailyBackup(user, req, 'before_client_restore');
  user.profiles = { ...(user.profiles || {}), ...(snapshot.profile ? { [name]: snapshot.profile } : {}) };
  user.holdings = [...(user.holdings || []), ...(snapshot.holdings || [])];
  user.transactions = [...(user.transactions || []), ...(snapshot.transactions || [])];
  user.deletedClients.splice(index, 1);
  user.dataVersion = (Number(user.dataVersion) || 0) + 1;
  user.markModified('profiles');
  user.markModified('deletedClients');
  await user.save();
  await writeAudit(req, { action: 'client_restored', targetUserId: userId, targetClient: name, metadata: { trashId } });
  return res.json({ success: true, message: `客戶 ${name} 已恢復` });
}));

app.post('/api/admin/purge_user', requireAdmin, adminRateLimit, asyncRoute(async (req, res) => {
  const userId = String(req.body?.userId || '').trim();
  if (req.body?.confirm !== true) return sendError(res, 400, 'CONFIRM_REQUIRED', '永久刪除需要明確確認');
  const deleted = await User.findOneAndDelete({ customId: userId, deletedAt: { $ne: null } });
  if (!deleted) return sendError(res, 404, 'TRASH_USER_NOT_FOUND', '回收站中找不到該帳號');
  await Backup.deleteMany({ userId });
  await writeAudit(req, { action: 'user_permanently_deleted', targetUserId: userId });
  return res.json({ success: true, message: `帳號 ${userId} 已永久刪除` });
}));

app.post('/api/admin/purge_client', requireAdmin, adminRateLimit, asyncRoute(async (req, res) => {
  const userId = String(req.body?.userId || '').trim();
  const trashId = String(req.body?.trashId || '').trim();
  if (req.body?.confirm !== true) return sendError(res, 400, 'CONFIRM_REQUIRED', '永久刪除需要明確確認');
  const user = await User.findOne({ customId: userId });
  if (!user) return sendError(res, 404, 'USER_NOT_FOUND', '找不到所屬帳號');
  const index = (user.deletedClients || []).findIndex(item => String(item?.trashId || item?._id || '') === trashId);
  if (index < 0) return sendError(res, 404, 'TRASH_CLIENT_NOT_FOUND', '回收站中找不到該客戶');
  const [removed] = user.deletedClients.splice(index, 1);
  user.markModified('deletedClients');
  await user.save();
  await writeAudit(req, { action: 'client_permanently_deleted', targetUserId: userId, targetClient: removed?.clientName || '', metadata: { trashId } });
  return res.json({ success: true, message: '客戶回收資料已永久刪除' });
}));

app.get('/api/admin/audit', requireAdmin, adminRateLimit, asyncRoute(async (req, res) => {
  const logs = await AuditLog.find({}).sort({ createdAt: -1 }).limit(300).lean();
  return res.json({ success: true, logs: logs.map(log => ({
    createdAt: log.createdAt,
    action: log.action,
    target: [log.targetUserId, log.targetClient].filter(Boolean).join(' / '),
    actor: log.actorType === 'admin' ? '管理員' : log.actorId,
    success: log.success,
    metadata: log.metadata
  })) });
}));

app.post('/api/admin/backups', requireAdmin, adminRateLimit, asyncRoute(async (req, res) => {
  const userId = String(req.body?.userId || '').trim();
  if (!validAccountId(userId)) return sendError(res, 400, 'USER_REQUIRED', '缺少有效帳號');
  const backups = await Backup.find({ userId }).sort({ createdAt: -1 }).limit(100).lean();
  return res.json({ success: true, backups: backups.map(item => ({
    _id: item._id,
    reason: item.reason,
    createdAt: item.createdAt,
    dataVersion: item.dataVersion,
    holdingCount: (item.holdings || []).length,
    clientCount: Object.keys(item.profiles || {}).length,
    transactionCount: (item.transactions || []).length
  })) });
}));

app.post('/api/admin/restore_backup', requireAdmin, adminRateLimit, asyncRoute(async (req, res) => {
  const userId = String(req.body?.userId || '').trim();
  const backupId = String(req.body?.backupId || '').trim();
  const [user, backup] = await Promise.all([User.findOne({ customId: userId, deletedAt: null }), Backup.findOne({ _id: backupId, userId }).lean()]);
  if (!user) return sendError(res, 404, 'USER_NOT_FOUND', '找不到使用中的帳號');
  if (!backup) return sendError(res, 404, 'BACKUP_NOT_FOUND', '找不到指定備份');
  await createBackupSnapshot(user, { reason: 'before_backup_restore', createdBy: req.auth.sub, daily: false });
  user.holdings = backup.holdings || [];
  user.profiles = backup.profiles || {};
  user.transactions = backup.transactions || [];
  user.deletedClients = backup.deletedClients || [];
  user.dataVersion = (Number(user.dataVersion) || 0) + 1;
  user.markModified('profiles');
  user.markModified('deletedClients');
  await user.save();
  await writeAudit(req, { action: 'backup_restored', targetUserId: userId, metadata: { backupId, version: user.dataVersion } });
  return res.json({ success: true, message: '備份已恢復', version: user.dataVersion });
}));

// ==================== 3. AI 診斷 API 路由 ====================
app.post('/api/ai_diagnose', requireUser, async (req, res) => {
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
    'gemini-3.8-flash',
    'gemini-3.7-flash',
    'gemini-3.6-flash',
    'gemini-3.5-flash-lite',
    process.env.GEMINI_MODEL,
    'gemini-flash-latest'
  ].filter(Boolean))];
  const prompt = `你是台灣券商持倉截圖資料擷取助手。請閱讀接下來的 ${images.length} 張圖片，辨識所有台股、ETF 或上櫃股票持倉列，並輸出符合指定 schema 的 JSON。

規則：
1. 一張圖片可能有多檔股票，多張圖片可能是同一客戶「${clientName || '未指定'}」的連續頁面。
2. 只擷取實際持倉明細，不要把現金、總資產、損益合計或廣告文字當成股票。
3. code 是證券代碼；stockName 使用繁體中文。看不清楚時不要猜測，保留空字串並在 warnings 說明。
4. 請保留畫面原始數量單位。quantityUnit 只能是「股」或「張」；畫面是張時，lots 填原始張數，quantity 填 lots × 1000；畫面是股時 quantity 填原始股數，lots 填 quantity ÷ 1000。不要自行混淆股與張。
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
            lots: { type: 'number' },
            quantityUnit: { type: 'string', enum: ['股', '張'] },
            cost: { type: 'number' },
            currentPrice: { type: 'number' },
            stopLoss: { type: 'number' },
            takeProfit: { type: 'number' },
            confidence: { type: 'number' },
            sourceImage: { type: 'integer' },
            note: { type: 'string' }
          },
          required: ['stockName', 'code', 'quantity', 'lots', 'quantityUnit', 'cost', 'currentPrice', 'stopLoss', 'takeProfit', 'confidence', 'sourceImage', 'note']
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

app.post('/api/ocr_holdings', requireUser, ocrRateLimit, async (req, res) => {
  try {
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
      const rawUnit = String(item?.quantityUnit || '').trim() === '張' ? '張' : '股';
      const rawLots = Math.max(0, cleanNumber(item?.lots) || 0);
      const rawQuantity = Math.max(0, cleanNumber(item?.quantity) || 0);
      const quantity = rawUnit === '張'
        ? Math.round((rawLots || rawQuantity) * 1000)
        : Math.round(rawQuantity || rawLots * 1000);
      const lots = rawUnit === '張' ? (rawLots || rawQuantity) : quantity / 1000;
      const normalized = {
        id: `ocr-${Date.now()}-${index}`,
        stockName,
        code,
        quantity,
        lots,
        quantityUnit: rawUnit,
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
async function fetchPriceViaAxios(code, marketHint = '') {
  const suffixes = marketHint === 'tse' ? ['.TW'] : marketHint === 'otc' ? ['.TWO'] : ['.TW', '.TWO'];
  for (const suffix of suffixes) {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${code}${suffix}`;
      const resp = await axios.get(url, { 
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        timeout: 2200
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

function parseMarketPriceLevels(value) {
  return String(value ?? '')
    .split('_')
    .map(level => parseMarketPrice(level))
    .filter(level => level !== null);
}

const PRICE_CACHE_TTL_MS = 4000;
const PRICE_STALE_MAX_AGE_MS = 60000;
const priceQuoteCache = new Map();
const officialBatchRequests = new Map();

async function fetchOfficialTaiwanPricesUncached(codes) {
  const prices = {};
  const quotes = {};
  const chunks = [];
  for (let index = 0; index < codes.length; index += 35) chunks.push(codes.slice(index, index + 35));

  for (const chunk of chunks) {
    const channels = chunk.flatMap(code => {
      const market = taiwanMarketByCode.get(code);
      return market ? [`${market}_${code}.tw`] : [`tse_${code}.tw`, `otc_${code}.tw`];
    }).join('|');
    const response = await axios.get('https://mis.twse.com.tw/stock/api/getStockInfo.jsp', {
      params: { ex_ch: channels, json: 1, delay: 0 },
      timeout: 6000,
      headers: {
        'Accept': 'application/json,text/plain,*/*',
        'Referer': 'https://mis.twse.com.tw/stock/index.jsp',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) PortfolioOS/4.6'
      }
    });
    for (const item of response.data?.msgArray || []) {
      const code = String(item?.c || '').trim();
      if (!code || !chunk.includes(code) || prices[code] !== undefined) continue;
      const bidLevels = parseMarketPriceLevels(item.b);
      const askLevels = parseMarketPriceLevels(item.a);
      const bestBid = bidLevels[0] ?? null;
      const bestAsk = askLevels[0] ?? null;
      const candidates = [
        { price: parseMarketPrice(item.z), priceType: 'last' },
        { price: parseMarketPrice(item.pz), priceType: 'lastKnown' },
        // MIS 的 z 只在最新揭示事件为成交时才有值；盘口更新时经常是 "-"。
        // 此时最佳买价比昨收更接近当下可成交价值，也避免盘中行情跳回前一日。
        { price: bestBid, priceType: 'bestBid' },
        { price: bestAsk, priceType: 'bestAsk' },
        { price: parseMarketPrice(item.y), priceType: 'previousClose' }
      ];
      const selected = candidates.find(candidate => candidate.price !== null);
      const price = selected?.price ?? null;
      if (price === null) continue;
      prices[code] = price;
      quotes[code] = {
        price,
        priceType: selected.priceType,
        source: item.ex === 'otc' ? 'TPEX' : 'TWSE',
        market: item.ex || '',
        date: String(item.d || ''),
        time: String(item.t || ''),
        name: String(item.n || item.nf || '').trim(),
        bestBid,
        bestAsk
      };
    }
  }
  return { prices, quotes };
}

async function fetchOfficialTaiwanPrices(codes) {
  const key = [...codes].sort().join(',');
  if (officialBatchRequests.has(key)) return officialBatchRequests.get(key);
  const request = fetchOfficialTaiwanPricesUncached(codes).finally(() => officialBatchRequests.delete(key));
  officialBatchRequests.set(key, request);
  return request;
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

    const now = Date.now();
    const priceMap = {};
    const quoteMap = {};
    let cacheHits = 0;
    codes.forEach(code => {
      const cached = priceQuoteCache.get(code);
      if (!cached || now - cached.cachedAt >= PRICE_CACHE_TTL_MS) return;
      priceMap[code] = cached.quote.price;
      quoteMap[code] = { ...cached.quote, cached: true, cacheAgeMs: now - cached.cachedAt };
      cacheHits += 1;
    });

    const uncachedCodes = codes.filter(code => priceMap[code] === undefined);
    if (uncachedCodes.length) {
      try {
        const official = await fetchOfficialTaiwanPrices(uncachedCodes);
        Object.entries(official.quotes).forEach(([code, quote]) => {
          priceMap[code] = quote.price;
          quoteMap[code] = { ...quote, cached: false, cacheAgeMs: 0 };
          priceQuoteCache.set(code, { quote, cachedAt: Date.now() });
        });
      } catch (error) {
        console.warn(`[Prices ${requestId}] 官方行情暫時不可用，改用備用來源：${error.message}`);
      }
    }

    let missingCodes = codes.filter(code => priceMap[code] === undefined);
    missingCodes.forEach(code => {
      const cached = priceQuoteCache.get(code);
      const age = cached ? Date.now() - cached.cachedAt : Infinity;
      if (!cached || age > PRICE_STALE_MAX_AGE_MS) return;
      priceMap[code] = cached.quote.price;
      quoteMap[code] = { ...cached.quote, cached: true, stale: true, cacheAgeMs: age };
    });

    missingCodes = codes.filter(code => priceMap[code] === undefined);
    await Promise.all(missingCodes.map(async code => {
      const market = taiwanMarketByCode.get(code) || '';
      const price = await fetchPriceViaAxios(code, market);
      if (price !== null && price !== undefined) {
        priceMap[code] = price;
        quoteMap[code] = { price, priceType: 'fallback', source: 'Yahoo 備用', market, date: '', time: '', cached: false, cacheAgeMs: 0 };
      }
    }));

    const failedCodes = codes.filter(code => priceMap[code] === undefined);
    const officialCount = Object.values(quoteMap).filter(quote => quote.source === 'TWSE' || quote.source === 'TPEX').length;
    console.log(`[Prices ${requestId}] 完成：更新 ${Object.keys(priceMap).length}/${codes.length} 檔，官方 ${officialCount} 檔，快取 ${cacheHits} 檔，失敗 ${failedCodes.length} 檔，耗時 ${Date.now() - startedAt}ms${failedCodes.length ? `；失敗代碼 ${failedCodes.join(',')}` : ''}`);

    return res.json({ success: true, prices: priceMap, quotes: quoteMap, failedCodes, updatedAt: new Date().toISOString(), requestId, cacheTtlMs: PRICE_CACHE_TTL_MS });
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

app.post('/api/market_events', requireUser, async (req, res) => {
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

app.use((req, res) => sendError(res, 404, 'NOT_FOUND', '找不到此服務路徑'));
app.use((error, req, res, next) => {
  console.error(`[API] ${req.method} ${req.path} 未預期錯誤：`, error?.message || error);
  if (res.headersSent) return next(error);
  return sendError(res, 500, 'INTERNAL_ERROR', '服務暫時發生錯誤，請稍後再試');
});

process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));
process.on('unhandledRejection', (reason) => console.error('Unhandled Rejection:', reason));

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));

