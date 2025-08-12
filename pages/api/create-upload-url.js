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

    return res.status(200).json({
      uploadUrl,
      accessToken: token,
      fioFolderId,
      finalName, // можно вернуть для логов/подтверждения на клиенте
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
}

