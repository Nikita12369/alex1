const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const http = require('http');
const socketIO = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

const port = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://db_circus_user:3eQjdQwejW92UBLMa8Uhz1cR6FAtX2P2@dpg-d475ehmmcj7s73d5sru0-a.oregon-postgres.render.com/db_circus',
  ssl: { rejectUnauthorized: false }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS days (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS seats (
      id SERIAL PRIMARY KEY,
      day_id INTEGER REFERENCES days(id) ON DELETE CASCADE,
      seat_number INTEGER,
      taken BOOLEAN DEFAULT false
    );
  `);

  const daysCount = await pool.query(`SELECT COUNT(*) FROM days`);
  if (parseInt(daysCount.rows[0].count, 10) === 0) {
    await pool.query(`
      INSERT INTO days (name)
      SELECT 'Tag ' || generate_series(1, 26);
    `);
  }

  const { rows } = await pool.query(`SELECT COUNT(*) FROM seats`);
  if (parseInt(rows[0].count, 10) === 0) {
    const daysRes = await pool.query(`SELECT id FROM days ORDER BY id`);
    for (const d of daysRes.rows) {
      const dayId = d.id;
      const values = Array.from({ length: 1506 }, (_, i) => `(${dayId}, ${i + 1}, false)`).join(',');
      await pool.query(`INSERT INTO seats (day_id, seat_number, taken) VALUES ${values}`);
    }
  }

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


app.get('/api/days', async (req, res) => {
  const result = await pool.query(`SELECT * FROM days ORDER BY id`);
  res.json(result.rows);
});

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

app.post('/api/book/:dayId/:seatNumber', async (req, res) => {
  const dayId = parseInt(req.params.dayId);
  const seatNumber = parseInt(req.params.seatNumber);

  try {
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

    const update = await pool.query(`
      UPDATE seats
      SET taken = $1
      WHERE id = $2
      RETURNING id, day_id, seat_number, taken
    `, [newTaken, seat.id]);

    const updated = update.rows[0];

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