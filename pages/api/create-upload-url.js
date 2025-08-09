// Next.js API route — создает (или находит) папку ФИО и открывает
// резюмируемую сессию загрузки в Google Drive, возвращает uploadUrl и accessToken.
// ВАЖНО: runtime = nodejs (не edge), чтобы работала google-auth-library.
import { OAuth2Client } from "google-auth-library";
export const config = {
  api: {
    bodyParser: true,
  },
};

import { JWT } from "google-auth-library";

const SCOPES = ["https://www.googleapis.com/auth/drive"]; // полный доступ для сервисного аккаунта
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function sanitizeFio(raw) {
  // Разрешаем только буквы (латиница/кириллица) и пробелы. Убираем двойные пробелы и крайние.
  const onlyLettersAndSpaces = raw.replace(/[^\p{L}\s]+/gu, "");
  return onlyLettersAndSpaces.trim().replace(/\s{2,}/g, " ");
}

function escapeForDriveQuery(str) {
  // Экранируем одинарные кавычки для q выражений
  return str.replace(/'/g, "\\'");
}

async function getAuthClient() {
  const clientId = requireEnv("GOOGLE_CLIENT_ID");
  const clientSecret = requireEnv("GOOGLE_CLIENT_SECRET");
  const refreshToken = requireEnv("GOOGLE_REFRESH_TOKEN");
  const client = new OAuth2Client(clientId, clientSecret);
  
  client.setCredentials({
    refresh_token: refreshToken,
  });
  // Проверим, что токен живой, и получим свежий access_token
  const { token: accessToken } = await client.getAccessToken();
  if (!accessToken) {
    throw new Error("Failed to retrieve access token.");
  }
  // Устанавливаем учетные данные с новым accessToken, чтобы последующие вызовы работали
  client.setCredentials({
    ...client.credentials,
    access_token: accessToken,
  });
  return client;
}



async function findOrCreateFioFolder({ token, parentId, fio }) {
  // Ищем папку с точным именем среди parentId
  const query = [
    `name='${escapeForDriveQuery(fio)}'`,
    `mimeType='application/vnd.google-apps.folder'`,
    `'${parentId}' in parents`,
    "trashed=false",
  ].join(" and ");

  const searchUrl = `${DRIVE_API}/files?q=${encodeURIComponent(
    query
  )}&fields=files(id,name)&supportsAllDrives=true`;

  const searchRes = await fetch(searchUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!searchRes.ok) {
    const text = await searchRes.text();
    throw new Error(`Drive search error: ${searchRes.status} ${text}`);
  }

  const data = await searchRes.json();
  if (data.files && data.files.length > 0) {
    return data.files[0].id; // берем первую папку с таким именем
  }

  // Создаем папку
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

async function openResumableSession({ token, folderId, fileName, mimeType, size }) {
  // резюмируемая сессии (uploadType=resumable)
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
      name: fileName,
      parents: [folderId],
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
      fileName,
      mimeType,
      size,
    } = req.body || {};

    if (
      typeof fio !== "string" ||
      typeof city !== "string" ||
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

    // Город -> ID папки
    const cityMap = {
      samara: requireEnv("GOOGLE_DRIVE_SAMARA_ID"),
      saratov: requireEnv("GOOGLE_DRIVE_SARATOV_ID"),
    };
    const parentId = cityMap[city.toLowerCase()];
    if (!parentId) {
      return res.status(400).json({ error: "Неизвестный город" });
    }

    // Проверяем тип файла на стороне сервера (минимально)
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

    // Открываем сессию resume загрузки в эту папку
    const uploadUrl = await openResumableSession({
      token,
      folderId: fioFolderId,
      fileName,
      mimeType,
      size,
    });

    // Возвращаем URL и временный токен (для Authorization во время загрузки)
    return res.status(200).json({
      uploadUrl,
      accessToken: token,
      fioFolderId,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: String(e?.message || e) });
  }

}

