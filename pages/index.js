import { useMemo, useState } from "react";


const SUBJECTS = [
  "Микробиология",
  "Анатомия",
  "Русский Язык",
  "Химия",
  "Биология",
];

export default function Home() {
  const [fio, setFio] = useState("");
  const [city, setCity] = useState("samara");
  const [subject, setSubject] = useState("");
  const [file, setFile] = useState(null);
  const [status, setStatus] = useState("");
  const [progress, setProgress] = useState(0);
  const [isUploading, setIsUploading] = useState(false);

  const fioRegex = /^[A-Za-zА-Яа-яЁё\s]+$/u; // только буквы и пробелы

  function onFileChange(e) {
    const f = e.target.files?.[0] || null;
    if (f && !f.type.startsWith("video/")) {
      alert("Разрешены только видеофайлы");
      e.target.value = "";
      setFile(null);
      return;
    }
    setFile(f || null);
  }

  // Локальный превью итогового имени файла (для пользователя)
  const finalNamePreview = useMemo(() => {
    if (!file || !fio.trim() || !subject) return "";
    const ext = file.name.includes(".")
      ? file.name.slice(file.name.lastIndexOf("."))
      : "";
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const label = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
    const subjectForName = subject.replace(/\s+/g, "_");
    return `${fio.trim()}_${subjectForName}_${label}${ext}`;
  }, [fio, subject, file]);

  async function createSession() {
    const body = {
      fio: fio.trim(),
      city,
      subject, // новый обязательный параметр
      fileName: file.name,
      mimeType: file.type || "application/octet-stream",
      size: file.size,
    };

    const res = await fetch("/api/create-upload-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Server error: ${res.status}`);
    }

    return res.json();
  }

  function uploadWithXHR(uploadUrl, accessToken, file) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", uploadUrl, true);
      xhr.setRequestHeader("Authorization", `Bearer ${accessToken}`);
      // Не ставим Content-Type вручную — пусть браузер решит. Если будет проблема — раскомментить строку ниже:
      // xhr.setRequestHeader("Content-Type", file.type);

      xhr.upload.addEventListener("progress", (evt) => {
        if (evt.lengthComputable) {
          const pct = Math.round((evt.loaded / evt.total) * 100);
          setProgress(pct);
        }
      });

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(xhr.responseText ? JSON.parse(xhr.responseText) : { status: "Uploaded" });
        } else {
          reject(new Error(`Upload failed with status: ${xhr.status} ${xhr.responseText}`));
        }
      };

      xhr.onerror = () => {
        // Иногда Google после успешной загрузки триггерит onerror из-за CORS на финальном ответе
        if (xhr.status === 200 || xhr.status === 0) {
          resolve({ status: "Uploaded (inferred from onerror)" });
        } else {
          reject(new Error(`Network error during upload. Status: ${xhr.status}`));
        }
      };

      xhr.send(file);
    });
  }

  async function onSubmit(e) {
    e.preventDefault();
    setStatus("");
    setProgress(0);

    if (!fioRegex.test(fio.trim())) {
      setStatus("Ошибка: ФИО должно содержать только буквы и пробелы");
      return;
    }
    if (!subject) {
      setStatus("Ошибка: выберите предмет");
      return;
    }
    if (!file) {
      setStatus("Выберите видеофайл");
      return;
    }
    setIsUploading(true);

    try {
      setStatus("Создаем папку и сессию загрузки...");
      const { uploadUrl, accessToken } = await createSession();

      setStatus("Загружаем видео в Google Drive...");
      await uploadWithXHR(uploadUrl, accessToken, file);

      setStatus("Готово! Видео загружено.");
    } catch (err) {
      console.error(err);
      setStatus(`Ошибка: ${err.message || err}`);
    } finally {
      setIsUploading(false);
    }
  }

  return (
    <div className="page">
      <div className="card">
        <h1>Загрузка видео</h1>
        <form onSubmit={onSubmit} className="form">
          <div className="field">
            <label>ФИО <span className="req">*</span></label>
            <input
              type="text"
              value={fio}
              onChange={(e) => setFio(e.target.value)}
              placeholder="Иванов Иван Иванович"
              required
              pattern="[A-Za-zА-Яа-яЁё\s]+"
              title="Только буквы и пробелы"
            />
          </div>

          <div className="grid">
            <div className="field">
              <label>Город</label>
              <select
                value={city}
                onChange={(e) => setCity(e.target.value)}
                required
              >
                <option value="samara">Самара</option>
                <option value="saratov">Саратов</option>
                {/* --- новые города --- */}
                <option value="moscow">Москва</option>
                <option value="spb">Санкт-Петербург</option>
                 {/* --- новые города --- */}
              </select>
            </div>

            <div className="field">
              <label>Предмет <span className="req">*</span></label>
              <select
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                required
              >
                <option value="" disabled>Выберите предмет</option>
                {SUBJECTS.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="field">
            <label>Видео <span className="req">*</span></label>
            <input
              type="file"
              accept="video/*"
              onChange={onFileChange}
            />
            {file && (
              <small className="muted">
                К загрузке: {file.name} ({Math.round(file.size / (1024 * 1024))} МБ)
              </small>
            )}
          </div>

          {finalNamePreview && (
            <div className="preview">
              <div className="preview-title">Имя файла на диске:</div>
              <div className="preview-name">{finalNamePreview}</div>
            </div>
          )}

          <button type="submit" className="btn" disabled={isUploading || !file || !subject}>
            {isUploading ? "Загружаем..." : "Загрузить видео"}
          </button>
        </form>

        {status && <p className="status">{status}</p>}

        {isUploading && (
          <div className="progress">
            <div className="bar">
              <div className="fill" style={{ width: `${progress}%` }} />
            </div>
            <small>{progress}%</small>
          </div>
        )}

        <details className="notes">
          <summary>Примечания</summary>
          <ul>
            <li>Если папка с ФИО уже существует — файл будет загружен в неё.</li>
          </ul>
        </details>
      </div>

      <style jsx>{`
        .page {
          min-height: 100vh;
          background: radial-gradient(1200px 600px at 10% -10%, #eef6ff 20%, transparent 60%),
                      radial-gradient(1200px 600px at 110% 110%, #f6f0ff 20%, transparent 60%),
                      linear-gradient(180deg, #f8fafc, #f3f4f6);
          padding: 40px 16px;
          display: flex;
          align-items: center;
          justify-content: center;
          font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, "Helvetica Neue", Arial, "Noto Sans", "Apple Color Emoji", "Segoe UI Emoji";
        }
        .card {
          width: 100%;
          max-width: 720px;
          background: #fff;
          border-radius: 16px;
          box-shadow: 0 10px 30px rgba(15, 23, 42, 0.08);
          padding: 28px;
          border: 1px solid rgba(2, 6, 23, 0.06);
        }
        h1 {
          margin: 0 0 16px;
          font-size: 22px;
          letter-spacing: -0.2px;
          color: #0f172a;
        }
        .form { margin-top: 8px; }
        .field { margin-bottom: 16px; }
        label {
          display: block;
          font-size: 14px;
          color: #0f172a;
          margin-bottom: 6px;
          font-weight: 600;
        }
        .req { color: #ef4444; }
        input[type="text"], select, input[type="file"] {
          width: 100%;
          padding: 10px 12px;
          border-radius: 10px;
          border: 1px solid #e5e7eb;
          background: #fff;
          outline: none;
          transition: box-shadow .15s, border-color .15s, background .15s;
          font-size: 14px;
        }
        input[type="text"]:focus, select:focus, input[type="file"]:focus {
          border-color: #3b82f6;
          box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.15);
        }
        .muted { color: #6b7280; }
        .grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 12px;
        }
        @media (max-width: 620px) {
          .grid { grid-template-columns: 1fr; }
        }
        .preview {
          background: #f8fafc;
          border: 1px dashed #cbd5e1;
          padding: 10px 12px;
          border-radius: 10px;
          margin: 8px 0 4px;
        }
        .preview-title {
          font-size: 12px;
          color: #64748b;
          margin-bottom: 4px;
        }
        .preview-name {
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
          font-size: 13px;
          color: #0f172a;
          word-break: break-all;
        }
        .btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          padding: 10px 16px;
          border-radius: 10px;
          background: linear-gradient(180deg, #3b82f6, #2563eb);
          color: #fff;
          border: none;
          font-weight: 600;
          cursor: pointer;
          transition: filter .15s, transform .02s;
        }
        .btn:disabled {
          opacity: 0.6;
          cursor: not-allowed;
          filter: grayscale(0.2);
        }
        .btn:active { transform: translateY(1px); }
        .status {
          margin-top: 16px;
          padding: 10px 12px;
          background: #f1f5f9;
          border: 1px solid #e2e8f0;
          border-radius: 10px;
          color: #0f172a;
        }
        .progress {
          margin-top: 10px;
        }
        .bar {
          height: 10px;
          background: #e5e7eb;
          border-radius: 999px;
          overflow: hidden;
        }
        .fill {
          height: 10px;
          background: linear-gradient(90deg, #22c55e, #16a34a);
          width: 0%;
          transition: width .2s;
        }
        .notes {
          margin-top: 18px;
          color: #374151;
        }
        summary { cursor: pointer; }
      `}</style>
    </div>
  );
}




