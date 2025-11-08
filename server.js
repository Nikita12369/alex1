const express = import('express');
const path = import('path');
const { Pool } = import('pg');
const http = import('http');
const socketIO = import('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

const port = process.env.PORT || 3000;

// Подключение к PostgreSQL (укажи свой или Render URL)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://db_circus_user:3eQjdQwejW92UBLMa8Uhz1cR6FAtX2P2@dpg-d475ehmmcj7s73d5sru0-a.oregon-postgres.render.com/db_circus',
  ssl: { rejectUnauthorized: false }
});

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
      day_id INTEGER REFERENCES days(id),
      taken BOOLEAN DEFAULT false
    );
  `);

  // Вставляем 15 дней, если ещё не вставлены
  await pool.query(`
    INSERT INTO days (name)
    SELECT 'День ' || generate_series(1, 15)
    ON CONFLICT DO NOTHING;
  `);

  // Проверим — есть ли уже места
  const { rows } = await pool.query(`SELECT COUNT(*) FROM seats`);
  if (parseInt(rows[0].count) === 0) {
    for (let day = 1; day <= 15; day++) {
      const values = Array.from({ length: 300 }, () => `(${day}, false)`).join(',');
      await pool.query(`INSERT INTO seats (day_id, taken) VALUES ${values}`);
    }
  }

  console.log('✅ Таблицы и данные инициализированы');
}

initDatabase().catch(console.error);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Получить все места
app.get('/api/seats/:dayId', async (req, res) => {
  const dayId = parseInt(req.params.dayId);
  const result = await pool.query(
    'SELECT * FROM seats WHERE day_id = $1 ORDER BY id',
    [dayId]
  );
  res.json(result.rows);
});


// Забронировать/разбронировать место
app.post('/api/book/:dayId/:id', async (req, res) => {
  const dayId = parseInt(req.params.dayId);
  const seatId = parseInt(req.params.id);

  const result = await pool.query(
    'SELECT taken FROM seats WHERE id = $1 AND day_id = $2',
    [seatId, dayId]
  );
  if (result.rows.length === 0)
    return res.status(404).json({ message: 'Место не найдено' });

  const isTaken = result.rows[0].taken;
  const update = await pool.query(
    'UPDATE seats SET taken = $1 WHERE id = $2 AND day_id = $3 RETURNING *',
    [!isTaken, seatId, dayId]
  );

  io.emit('seat-updated', { id: seatId, taken: !isTaken, dayId });
  res.json({ success: true });
});

app.get('/api/days', async (req, res) => {
  const result = await pool.query('SELECT * FROM days ORDER BY id');
  res.json(result.rows);
});

app.post('/api/rename-day/:id', async (req, res) => {
  const dayId = parseInt(req.params.id);
  const { name } = req.body;
  await pool.query('UPDATE days SET name = $1 WHERE id = $2', [name, dayId]);
  res.json({ success: true });
});

app.get('/api/seats/:dayId', async (req, res) => {
  const dayId = parseInt(req.params.dayId);
  const result = await pool.query('SELECT * FROM bookings WHERE day_id = $1 AND taken = true', [dayId]);
  res.json(result.rows);
});

// Сброс брони
app.post('/api/reset/:dayId', async (req, res) => {
  const dayId = parseInt(req.params.dayId);
  await pool.query('UPDATE seats SET taken = false WHERE day_id = $1', [dayId]);
  io.emit('seats-reset', { dayId });
  res.json({ message: `Все брони на день ${dayId} сняты` });
});


// WebSocket соединение
io.on('connection', async (socket) => {
  // Клиент должен сообщить день
  socket.on('get-seats', async (dayId) => {
    const result = await pool.query(
      'SELECT * FROM seats WHERE day_id = $1 ORDER BY id',
      [dayId]
    );
    socket.emit('seats-data', { dayId, seats: result.rows });
  });
});


server.listen(port, () => {
  console.log(`Сервер запущен на http://localhost:${port}`);
});

