const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const http = require('http');
const socketIO = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

const port = process.env.PORT || 3000;

// Подключение к PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://db_circus_user:3eQjdQwejW92UBLMa8Uhz1cR6FAtX2P2@dpg-d475ehmmcj7s73d5sru0-a.oregon-postgres.render.com/db_circus',
  ssl: { rejectUnauthorized: false }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/*
  initDatabase:
  - создаёт таблицы days и seats (если их нет)
  - вставляет 15 дней (День 1..День 15) при отсутствии
  - если seats пустая — создаёт по 300 мест на каждый день (seat_number 1..300)
  - создаёт уникальный индекс (day_id, seat_number)
*/
async function initDatabase() {
  // 1) Создаём таблицу days
  await pool.query(`
    CREATE TABLE IF NOT EXISTS days (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL
    );
  `);

  // 2) Создаём таблицу seats (с колонкой seat_number)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS seats (
      id SERIAL PRIMARY KEY,
      day_id INTEGER REFERENCES days(id) ON DELETE CASCADE,
      seat_number INTEGER,
      taken BOOLEAN DEFAULT false
    );
  `);

  // Создать только один раз 15 дней 
  const daysCount = await pool.query(`SELECT COUNT(*) FROM days`);
  if (parseInt(daysCount.rows[0].count, 10) === 0) {
    await pool.query(`
      INSERT INTO days (name)
      SELECT 'День ' || generate_series(1, 15);
    `);
  }

  // 4) Если таблица seats пуста — создаём по 300 мест на каждый день
  const { rows } = await pool.query(`SELECT COUNT(*) FROM seats`);
  if (parseInt(rows[0].count, 10) === 0) {
    const daysRes = await pool.query(`SELECT id FROM days ORDER BY id`);
    for (const d of daysRes.rows) {
      const dayId = d.id;
      // создаём VALUES вида: (dayId, 1, false), (dayId, 2, false), ... (dayId, 300, false)
      const values = Array.from({ length: 300 }, (_, i) => `(${dayId}, ${i + 1}, false)`).join(',');
      await pool.query(`INSERT INTO seats (day_id, seat_number, taken) VALUES ${values}`);
    }
  }

  // 5) Создаём уникальный индекс на (day_id, seat_number) если его нет
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = 'seats_day_seat_idx'
      ) THEN
        CREATE UNIQUE INDEX seats_day_seat_idx ON seats(day_id, seat_number);
      END IF;
    END
    $$;
  `);

  console.log('✅ DB initialized: days & seats (with seat_number)');
}

initDatabase().catch(console.error);

/*
===============================================================
  API: получить список дней
===============================================================
*/
app.get('/api/days', async (req, res) => {
  const result = await pool.query(`SELECT * FROM days ORDER BY id`);
  res.json(result.rows);
});

/*===============================================================
  API: получить все места для дня
===============================================================
*/
app.get('/api/seats/:dayId', async (req, res) => {
  const dayId = parseInt(req.params.dayId);

  const result = await pool.query(`
    SELECT id, seat_number, taken
    FROM seats
    WHERE day_id = $1
    ORDER BY seat_number
  `, [dayId]);

  res.json(result.rows);
});

// Забронировать/разбронировать место
app.post('/api/book/:dayId/:seatNumber', async (req, res) => {
  const dayId = parseInt(req.params.dayId);
  const seatNumber = parseInt(req.params.seatNumber);

  try {
    // Ищем место по day_id + seat_number
    const result = await pool.query(`
      SELECT id, taken
      FROM seats
      WHERE day_id = $1 AND seat_number = $2
    `, [dayId, seatNumber]);

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Место не найдено" });
    }

    const seat = result.rows[0];
    const newTaken = !seat.taken;

    // Обновляем статус
    const update = await pool.query(`
      UPDATE seats
      SET taken = $1
      WHERE id = $2
      RETURNING id, day_id, seat_number, taken
    `, [newTaken, seat.id]);

    const updated = update.rows[0];

    // Сообщаем всем клиентам
    io.emit("seat-updated", {
      dayId: updated.day_id,
      seatNumber: updated.seat_number,
      taken: updated.taken
    });

    res.json({ success: true, seat: updated });

  } catch (err) {
    console.error("Ошибка бронирования:", err);
    res.status(500).json({ message: "Ошибка сервера" });
  }
});

/*
===============================================================
  API: сбросить все места дня
===============================================================
*/
app.post('/api/reset/:dayId', async (req, res) => {
  const dayId = parseInt(req.params.dayId);

  await pool.query(`
    UPDATE seats
    SET taken = false
    WHERE day_id = $1
  `, [dayId]);

  io.emit('seats-reset', { dayId });

  res.json({ message: "Все брони сняты" });
});

/*
===============================================================
  API: переименовать день
===============================================================
*/
app.post('/api/rename-day/:id', async (req, res) => {
  const dayId = parseInt(req.params.id);
  const { name } = req.body;

  await pool.query(`
    UPDATE days
    SET name = $1
    WHERE id = $2
  `, [name, dayId]);

  res.json({ success: true });
});

/*
===============================================================
  WebSocket
===============================================================
*/
io.on("connection", (socket) => {
  console.log("Подключился клиент:", socket.id);

  socket.on('get-seats', async (dayId) => {
    const result = await pool.query(`
      SELECT id, seat_number, taken
      FROM seats
      WHERE day_id = $1
      ORDER BY seat_number
    `, [dayId]);

    socket.emit('seats-data', {
      dayId,
      seats: result.rows
    });
  });
});

server.listen(port, () => {
  console.log(`🚀 Сервер запущен: http://localhost:${port}`);
});