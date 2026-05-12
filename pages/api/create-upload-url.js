// Next.js API route — создает (или находит) папку ФИО и открывает
// резюмируемую сессию загрузки в Google Drive, возвращает uploadUrl и accessToken.
import { OAuth2Client } from "google-auth-library";

export const config = {
  api: { bodyParser: true },
};

const SCOPES = ["https://www.googleapis.com/auth/drive"];
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";

const ALLOWED_SUBJECTS = new Set([
  "Микробиология",
  "Анатомия",
  "Русский Язык",
  "Химия",
  "Биология",
]);

// Правила загрузки (серверная валидация)
const UPLOAD_RULES = {
  "2025-07-14": { subjects: ["Микробиология", "Биология"] },
  "2025-07-16": { subjects: ["Анатомия", "Химия"] },
  "2025-07-18": { subjects: ["Русский Язык"] },
  "2025-07-21": { subjects: ["Микробиология", "Биология"] },
  "2025-07-22": { subjects: ["Анатомия", "Химия"] },
  "2025-07-23": { subjects: ["Русский Язык"] },
  "2025-08-13": { subjects: ["Микробиология", "Биология"] },
  "2025-08-15": { subjects: ["Анатомия", "Химия"] },
  "2025-08-18": { subjects: ["Русский Язык"] },
};
const DEADLINE_HOUR = 18;
const MSK_OFFSET_MS = 3 * 60 * 60 * 1000; // UTC+3

// Rate limiting (простая in-memory реализация)
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 минута
const RATE_LIMIT_MAX_REQUESTS = 5; // максимум 5 запросов в минуту

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(ip, { windowStart: now, count: 1 });
    return true;
  }
  
  if (entry.count >= RATE_LIMIT_MAX_REQUESTS) {
    return false;
  }
  
  entry.count++;
  return true;
}

function getMskDate() {
  const now = new Date();
  const mskTime = new Date(now.getTime() + MSK_OFFSET_MS + now.getTimezoneOffset() * 60 * 1000);
  const year = mskTime.getFullYear();
  const month = String(mskTime.getMonth() + 1).padStart(2, "0");
  const day = String(mskTime.getDate()).padStart(2, "0");
  const hour = mskTime.getHours();
  return { date: `${year}-${month}-${day}`, hour };
}

function validateUploadSchedule(subject) {
  const { date, hour } = getMskDate();
  const rule = UPLOAD_RULES[date];
  
  if (!rule) {
    return { allowed: false, reason: "Загрузка недоступна в эту дату" };
  }
  
  if (hour >= DEADLINE_HOUR) {
    return { allowed: false, reason: "Время загрузки истекло (до 18:00 МСК)" };
  }
  
  if (!rule.subjects.includes(subject)) {
    return { allowed: false, reason: `Предмет "${subject}" недоступен для загрузки сегодня` };
  }
  
  return { allowed: true };
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function sanitizeFio(raw) {
  const onlyLettersAndSpaces = raw.replace(/[^\p{L}\s]+/gu, "");
  return onlyLettersAndSpaces.trim().replace(/\s{2,}/g, " ");
}

function escapeForDriveQuery(str) {
  return str.replace(/'/g, "\\'");
}

function sanitizeForFilenamePart(s) {
  // убираем запрещенные в именах символы и приводим пробелы к одному пробелу
  return s.replace(/[\\/:*?"<>|]+/g, "").replace(/\s{2,}/g, " ").trim();
}

function formatDateLabel(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

async function getAuthClient() {
  const clientId = requireEnv("GOOGLE_CLIENT_ID");
  const clientSecret = requireEnv("GOOGLE_CLIENT_SECRET");
  const refreshToken = requireEnv("GOOGLE_REFRESH_TOKEN");

  const client = new OAuth2Client(clientId, clientSecret);
  client.setCredentials({ refresh_token: refreshToken });

  const { token: accessToken } = await client.getAccessToken();
  if (!accessToken) throw new Error("Failed to retrieve access token.");

  client.setCredentials({ ...client.credentials, access_token: accessToken });
  return client;
}

async function findOrCreateFioFolder({ token, parentId, fio }) {
  const query = [
    `name='${escapeForDriveQuery(fio)}'`,
    `mimeType='application/vnd.google-apps.folder'`,
    `'${parentId}' in parents`,
    "trashed=false",
  ].join(" and ");

  const searchUrl = `${DRIVE_API}/files?q=${encodeURIComponent(query)}&fields=files(id,name)&supportsAllDrives=true`;
  const searchRes = await fetch(searchUrl, { headers: { Authorization: `Bearer ${token}` } });

  if (!searchRes.ok) {
    const text = await searchRes.text();
    throw new Error(`Drive search error: ${searchRes.status} ${text}`);
  }

  const data = await searchRes.json();
  if (data.files && data.files.length > 0) {
    return data.files[0].id;
  }

  const createRes = await fetch(`${DRIVE_API}/files?supportsAllDrives=true`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=UTF-8",
    },
    body: JSON.stringify({
      name: fio,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId],
    }),
  });

  if (!createRes.ok) {
    const text = await createRes.text();
    throw new Error(`Create folder error: ${createRes.status} ${text}`);
  }

  const created = await createRes.json();
  return created.id;
}

async function openResumableSession({ token, folderId, finalName, mimeType, size, appProps }) {
  const url = `${DRIVE_UPLOAD_API}/files?uploadType=resumable&supportsAllDrives=true`;
  const initRes = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": mimeType || "application/octet-stream",
      "X-Upload-Content-Length": String(size || 0),
    },
    body: JSON.stringify({
      name: finalName,            // <-- задаем итоговое имя файла
      parents: [folderId],
      appProperties: appProps,    // метаданные (удобно для будущего поиска/фильтрации)
    }),
  });

  if (!initRes.ok) {
    const text = await initRes.text();
    throw new Error(`Open resumable session error: ${initRes.status} ${text}`);
  }

  const uploadUrl = initRes.headers.get("location");
  if (!uploadUrl) throw new Error("No 'Location' header returned by Drive");

  return uploadUrl;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    // Rate limiting
    const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || 
               req.headers["x-real-ip"] || 
               req.socket?.remoteAddress || 
               "unknown";
    
    if (!checkRateLimit(ip)) {
      return res.status(429).json({ 
        error: "Слишком много запросов. Пожалуйста, подождите минуту." 
      });
    }

    // Проверка Origin/Referer для защиты от CSRF
    const origin = req.headers.origin;
    const referer = req.headers.referer;
    const host = req.headers.host;
    
    // В production проверяем, что запрос пришел с нашего домена
    if (process.env.NODE_ENV === "production") {
      const allowedOrigins = [
        `https://${host}`,
        process.env.ALLOWED_ORIGIN, // опционально можно задать в env
      ].filter(Boolean);
      
      const requestOrigin = origin || (referer ? new URL(referer).origin : null);
      
      if (!requestOrigin || !allowedOrigins.some(o => requestOrigin.startsWith(o.replace(/\/$/, "")))) {
        return res.status(403).json({ error: "Forbidden" });
      }
    }

    const {
      fio,
      city, // 'samara' | 'saratov'
      subject, // новый обязательный параметр
      fileName,
      mimeType,
      size,
    } = req.body || {};

    if (
      typeof fio !== "string" ||
      typeof city !== "string" ||
      typeof subject !== "string" ||
      typeof fileName !== "string" ||
      (mimeType && typeof mimeType !== "string") ||
      (size && typeof size !== "number")
    ) {
      return res.status(400).json({ error: "Invalid payload" });
    }

    // ФИО: только буквы и пробелы
    const fioSanitized = sanitizeFio(fio);
    const fioValid = /^[\p{L}\s]+$/u.test(fioSanitized) && fioSanitized.length >= 3;
    if (!fioValid) {
      return res.status(400).json({ error: "ФИО должно содержать только буквы и пробелы" });
    }

    // Проверка предмета
    const subjectTrimmed = subject.trim();
    if (!ALLOWED_SUBJECTS.has(subjectTrimmed)) {
      return res.status(400).json({ error: "Неверно указан предмет" });
    }

    // Серверная проверка расписания загрузки
    const scheduleCheck = validateUploadSchedule(subjectTrimmed);
    if (!scheduleCheck.allowed) {
      return res.status(403).json({ error: scheduleCheck.reason });
    }

    // Город -> ID папки
    const cityMap = {
      samara: requireEnv("GOOGLE_DRIVE_SAMARA_ID"),
      saratov: requireEnv("GOOGLE_DRIVE_SARATOV_ID"),
      moscow: requireEnv("GOOGLE_DRIVE_MOSCOW_ID"),
      spb: requireEnv("GOOGLE_DRIVE_SPB_ID"),
    };
    const parentId = cityMap[city.toLowerCase()];
    if (!parentId) {
      return res.status(400).json({ error: "Неизвестный город" });
    }

    // Минимальная проверка файла
    if (!mimeType || !mimeType.startsWith("video/")) {
      return res.status(400).json({ error: "Разрешены только видеофайлы" });
    }

    const auth = await getAuthClient();
    const { token } = await auth.getAccessToken();

    // Находим/создаем папку ФИО в выбранном городе
    const fioFolderId = await findOrCreateFioFolder({
      token,
      parentId,
      fio: fioSanitized,
    });

    // Формируем итоговое имя: ФИО_Предмет_дата_загрузки.ext
    const ext = fileName && fileName.includes(".")
      ? fileName.slice(fileName.lastIndexOf("."))
      : "";
    const subjectForName = sanitizeForFilenamePart(subjectTrimmed).replace(/\s+/g, "_");
    const finalName = `${sanitizeForFilenamePart(fioSanitized)}_${subjectForName}_${formatDateLabel()}${ext}`;

    // Метаданные для удобства поиска в будущем
    const appProps = {
      fio: fioSanitized,
      subject: subjectTrimmed,
      city: city.toLowerCase(),
      uploadedAt: new Date().toISOString(),
      source: "nextjs-uploader",
    };

    // Открываем сессию резюмируемой загрузки
    const uploadUrl = await openResumableSession({
      token,
      folderId: fioFolderId,
      finalName,
      mimeType,
      size,
      appProps,
    });

    // БЕЗОПАСНОСТЬ: НЕ возвращаем accessToken клиенту напрямую
    // Вместо этого возвращаем только uploadUrl (который уже содержит временную авторизацию)
    // Google resumable upload URL уже включает upload_id и не требует отдельного токена
    return res.status(200).json({
      uploadUrl,
      fioFolderId,
      finalName, // можно вернуть для логов/подтверждения на клиенте
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
}

