const express = require("express");
const { Pool } = require("pg");

const app = express();
app.use(express.json());

// PostgreSQL connection via environment variables
const pool = new Pool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  port: 5432,
});

// Creates the table if it does not exist; retries because the database
// may start slower than the API
async function initDb(retries = 10) {
  for (let i = 1; i <= retries; i++) {
    try {
      await pool.query(
        "CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, name TEXT NOT NULL)"
      );
      console.log("database ready");
      return;
    } catch (err) {
      console.log(`database not ready (attempt ${i}/${retries}): ${err.message}`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  throw new Error("could not connect to database");
}

// GET /users - returns all users
app.get("/users", async (req, res) => {
  const result = await pool.query("SELECT * FROM users");
  res.json(result.rows);
});

// POST /users - adds a new user
app.post("/users", async (req, res) => {
  const { name } = req.body;
  if (!name) {
    return res.status(400).json({ error: "name is required" });
  }
  await pool.query("INSERT INTO users(name) VALUES($1)", [name]);
  res.json({ status: "ok" });
});

// DELETE /users - deletes all users (tests use it to reset state)
app.delete("/users", async (req, res) => {
  await pool.query("DELETE FROM users");
  res.json({ status: "ok" });
});

initDb().then(() => {
  app.listen(3000, () => {
    console.log("server running on port 3000");
  });
});
