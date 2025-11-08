// Подключаем нужные библиотеки
import express from "express";
import path from "path";
import { fileURLToPath } from "url";

// Создаём сервер
const app = express();

// Настраиваем путь к папке public (где лежит HTML)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, "public")));

// Главная страница
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Порт (Render задаёт автоматически)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Сервер работает на порту ${PORT}`);
});
