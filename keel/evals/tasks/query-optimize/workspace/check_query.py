import sqlite3
from pathlib import Path

query = Path("my-sql-query.sql").read_text()

db = sqlite3.connect(":memory:")
db.executescript(
    """
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      active INTEGER NOT NULL
    );
    CREATE TABLE orders (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      total REAL NOT NULL
    );

    INSERT INTO users VALUES
      (1, 'Ada', 1),
      (2, 'Grace', 1),
      (3, 'Linus', 0),
      (4, 'Barbara', 1);

    INSERT INTO orders VALUES
      (101, 1, 12.5),
      (102, 1, 27.5),
      (103, 2, 7.5),
      (104, 3, 99.0);
    """
)

rows = db.execute(query).fetchall()
expected = [
    (1, "Ada", 2, 40.0),
    (2, "Grace", 1, 7.5),
    (4, "Barbara", 0, 0),
]
if rows != expected:
    raise SystemExit(f"unexpected rows: {rows!r}")

plan = "\n".join(
    " ".join(str(part) for part in row).upper()
    for row in db.execute(f"EXPLAIN QUERY PLAN {query}").fetchall()
)
if "CORRELATED" in plan:
    raise SystemExit(f"query still uses a correlated subquery:\n{plan}")
