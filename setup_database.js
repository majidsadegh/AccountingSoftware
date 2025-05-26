const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// مسیر پایگاه داده
const dbPath = path.resolve(__dirname, 'database', 'accounting.db');

// اتصال به پایگاه داده
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening database:', err.message);
    return;
  }
  console.log('Connected to SQLite database.');
  runMigrations();
});

// دستورات SQL برای اجرا
const migrations = [
  // Ensure users and parties tables exist for foreign key constraints
  `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      sharePercentage REAL
  );`,
  `CREATE TABLE IF NOT EXISTS parties (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT, -- e.g., customer, vendor
      phone TEXT,
      address TEXT
  );`,
  // Hierarchical account tables
  `CREATE TABLE IF NOT EXISTS general_ledger_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('asset', 'liability', 'equity', 'income', 'expense'))
  );`,
  `CREATE TABLE IF NOT EXISTS subsidiary_ledger_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      general_ledger_account_id INTEGER NOT NULL,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      FOREIGN KEY (general_ledger_account_id) REFERENCES general_ledger_accounts(id)
  );`,
  `CREATE TABLE IF NOT EXISTS detailed_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subsidiary_ledger_account_id INTEGER NOT NULL,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      FOREIGN KEY (subsidiary_ledger_account_id) REFERENCES subsidiary_ledger_accounts(id)
  );`,

  // Create new transaction structure with temporary names
  `CREATE TABLE IF NOT EXISTS transactions_temp_new_structure (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      document_number TEXT,
      date TEXT NOT NULL, -- Consider ISO 8601 format: YYYY-MM-DD HH:MM:SS
      description TEXT,
      document_type TEXT, -- e.g., invoice, receipt, journal_entry
      FOREIGN KEY (user_id) REFERENCES users(id)
  );`,
  `CREATE TABLE IF NOT EXISTS transaction_items_temp_new_structure (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transaction_id INTEGER NOT NULL,
      detailed_account_id INTEGER NOT NULL,
      debit REAL DEFAULT 0,
      credit REAL DEFAULT 0,
      party_id INTEGER,
      quantity REAL,
      unit_price REAL,
      item_description TEXT,
      FOREIGN KEY (transaction_id) REFERENCES transactions_temp_new_structure(id) ON DELETE CASCADE,
      FOREIGN KEY (detailed_account_id) REFERENCES detailed_accounts(id),
      FOREIGN KEY (party_id) REFERENCES parties(id)
  );`,

  // Drop old tables (if they exist) and rename temporary tables to final names
  // This makes the process destructive for old transaction data but ensures correct schema.
  `DROP TABLE IF EXISTS transaction_items;`,
  `DROP TABLE IF EXISTS transactions;`,
  `ALTER TABLE transactions_temp_new_structure RENAME TO transactions;`,
  `ALTER TABLE transaction_items_temp_new_structure RENAME TO transaction_items;`
];

function runMigrations() {
  db.serialize(() => {
    migrations.forEach((migration, index) => {
      db.run(migration, (err) => {
        if (err) {
          console.error(`Error executing migration ${index + 1} [${migration.split('\n')[0].substring(0,60)}...]:`, err.message);
        } else {
          console.log(`Migration ${index + 1} [${migration.split('\n')[0].substring(0,60)}...] executed successfully.`);
        }
        // بستن اتصال پس از اجرای آخرین دستور
        if (index === migrations.length - 1) {
          db.close((closeErr) => {
            if (closeErr) {
              console.error('Error closing database:', closeErr.message);
            } else {
              console.log('Database connection closed. Schema setup complete.');
              console.log('Please ensure you have backed up any important data from the old \'transactions\' table if needed.');
            }
          });
        }
      });
    });
  });
}

// To run this script, navigate to the project root in your terminal and execute: node setup_database.js