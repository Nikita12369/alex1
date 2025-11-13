const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const http = require('http');
const socketIO = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

const port = process.env.PORT || 3000;

// Połączenie z PostgreSQL (Render lub lokalnie)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://db_circus_user:3eQjdQwejW92UBLMa8Uhz1cR6FAtX2P2@dpg-d475ehmmcj7s73d5sru0-a.oregon-postgres.render.com/db_circus',
  ssl: { rejectUnauthorized: false }
});

// Inicjalizacja bazy danych
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

  // Dodaj 15 dni, jeśli jeszcze nie ma
  await pool.query(`
    INSERT INTO days (name)
    SELECT 'Dzień ' || generate_series(1, 15)
    ON CONFLICT DO NOTHING;
  `);

  // Dodaj miejsca, jeśli brak
  const { rows } = await pool.query('SELECT COUNT(*) FROM seats');
  if (parseInt(rows[0].count) === 0) {
    for (let day = 1; day <= 15; day++) {
      const values = Array.from({ length: 300 }, () => `(${day}, false)`).join(',');
      await pool.query(`INSERT INTO seats (day_id, taken) VALUES ${values}`);
    }
  }

  console.log('✅ Baza danych gotowa');
}

initDatabase().catch(console.error);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Pobierz wszystkie miejsca dla dnia
app.get('/api/seats/:dayId', async (req, res) => {
  const dayId = parseInt(req.params.dayId);
  try {
    const result = await pool.query(
      'SELECT * FROM seats WHERE day_id = $1 ORDER BY id',
      [dayId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Błąd serwera' });
  }
});

// Rezerwacja / zwolnienie miejsca
app.post('/api/book/:dayId/:seatId', async (req, res) => {
  const dayId = parseInt(req.params.dayId);
  const seatId = parseInt(req.params.seatId);

  try {
    const { rows } = await pool.query(
      'SELECT taken FROM seats WHERE id = $1 AND day_id = $2',
      [seatId, dayId]
    );
    if (rows.length === 0) return res.status(404).json({ message: 'Miejsce nie znalezione' });

    const newStatus = !rows[0].taken;

    await pool.query(
      'UPDATE seats SET taken = $1 WHERE id = $2 AND day_id = $3',
      [newStatus, seatId, dayId]
    );

    io.emit('seat-updated', { id: seatId, taken: newStatus, dayId });

    res.json({ success: true, taken: newStatus });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Błąd serwera' });
  }
});

// Pobierz wszystkie dni
app.get('/api/days', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM days ORDER BY id');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Błąd serwera' });
  }
});

// Zmień nazwę dnia
app.post('/api/rename-day/:id', async (req, res) => {
  const dayId = parseInt(req.params.id);
  const { name } = req.body;

  try {
    await pool.query('UPDATE days SET name = $1 WHERE id = $2', [name, dayId]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Błąd serwera' });
  }
});

// Reset wszystkich miejsc dla dnia
app.post('/api/reset/:dayId', async (req, res) => {
  const dayId = parseInt(req.params.dayId);
  try {
    await pool.query('UPDATE seats SET taken = false WHERE day_id = $1', [dayId]);
    io.emit('seats-reset', { dayId });
    res.json({ message: `Wszystkie miejsca na dzień ${dayId} zostały zwolnione` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Błąd serwera' });
  }
});

// WebSocket
io.on('connection', (socket) => {
  socket.on('get-seats', async (dayId) => {
    try {
      const result = await pool.query(
        'SELECT * FROM seats WHERE day_id = $1 ORDER BY id',
        [dayId]
      );
      socket.emit('seats-data', { dayId, seats: result.rows });
    } catch (err) {
      console.error(err);
    }
  });
});

server.listen(port, () => {
  console.log(`Serwer uruchomiony na http://localhost:${port}`);
});
