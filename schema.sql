-- One row per CO2 reading. ts is Unix seconds (server time when the reading arrived).
CREATE TABLE IF NOT EXISTS readings (
  ts  INTEGER PRIMARY KEY,
  ppm INTEGER NOT NULL
);
