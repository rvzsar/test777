import { useState } from "react";

export default function Home() {
  const [fio, setFio] = useState("");
  const [city, setCity] = useState("samara");
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

  async function createSession() {
    const body = {
      fio: fio.trim(),
      city,
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
      // xhr.setRequestHeader("Authorization", `Bearer ${accessToken}`);
      xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");

      xhr.upload.addEventListener("progress", (evt) => {
        if (evt.lengthComputable) {
          const pct = Math.round((evt.loaded / evt.total) * 100);
          setProgress(pct);
        }
      });

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(xhr.responseText ? JSON.parse(xhr.responseText) : {});
        } else {
          reject(new Error(`Upload failed: ${xhr.status} ${xhr.responseText}`));
        }
      };
      xhr.onerror = () => reject(new Error("Network error during upload"));

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
    <div style={{ maxWidth: 560, margin: "40px auto", fontFamily: "system-ui, sans-serif" }}>
      <h1>Загрузка видео в Google Drive</h1>
      <form onSubmit={onSubmit}>
        <div style={{ marginBottom: 12 }}>
          <label>ФИО</label>
          <input
            type="text"
            value={fio}
            onChange={(e) => setFio(e.target.value)}
            placeholder="Иванов Иван Иванович"
            required
            pattern="[A-Za-zА-Яа-яЁё\s]+"
            title="Только буквы и пробелы"
            style={{ width: "100%", padding: 8, marginTop: 4 }}
          />
        </div>

        <div style={{ marginBottom: 12 }}>
          <label>Город</label>
          <select
            value={city}
            onChange={(e) => setCity(e.target.value)}
            style={{ width: "100%", padding: 8, marginTop: 4 }}
          >
            <option value="samara">Самара</option>
            <option value="saratov">Саратов</option>
          </select>
        </div>

        <div style={{ marginBottom: 12 }}>
          <label>Видео</label>
          <input
            type="file"
            accept="video/*"
            onChange={onFileChange}
            style={{ display: "block", marginTop: 4 }}
          />
          {file && (
            <small>
              К загрузке: {file.name} ({Math.round(file.size / (1024 * 1024))} МБ)
            </small>
          )}
        </div>

        <button type="submit" disabled={isUploading || !file}>
          {isUploading ? "Загружаем..." : "Загрузить видео"}
        </button>
      </form>

      {status && <p style={{ marginTop: 16 }}>{status}</p>}
      {isUploading && (
        <div style={{ marginTop: 8 }}>
          <div style={{ height: 10, background: "#eee", borderRadius: 6 }}>
            <div
              style={{
                width: `${progress}%`,
                height: 10,
                background: "#4caf50",
                borderRadius: 6,
                transition: "width .2s",
              }}
            />
          </div>
          <small>{progress}%</small>
        </div>
      )}

      <hr style={{ margin: "24px 0" }} />
      <details>
        <summary>Примечания</summary>
        <ul>
          <li>Если папка с ФИО уже существует — файл будет загружен в неё.</li>
          <li>Токен действительно ~1 час; загрузку лучше начинать сразу.</li>
          <li>Для очень больших файлов стоит реализовать загрузку частями (Content-Range). Здесь показана полная загрузка одним запросом.</li>
        </ul>
      </details>
    </div>
  );

}
