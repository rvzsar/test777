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
  const [city, setCity] = useState(""); // ИЗМЕНЕНИЕ: Пустая строка по умолчанию, чтобы заставить выбрать
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
      return
