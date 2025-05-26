const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = newFunction();
const path = require('path');
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public'))); // مسیردهی صحیح به پوشه public

const dbPath = path.resolve(__dirname, '..', 'database', 'accounting.db');

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening database:', err.message);
  } else {
    console.log('Connected to SQLite database.');
  }
});

// ورود کاربر
app.post('/login', (req, res) => {
  const { username, password } = req.body;
  db.get('SELECT * FROM users WHERE username = ? AND password = ?', [username, password], (err, row) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    if (!row) {
      res.status(401).json({ error: 'Invalid username or password' });
      return;
    }
    // Return only necessary user info, avoid sending password back
    res.json({ user: { id: row.id, username: row.username, sharePercentage: row.sharePercentage } });
  });
});

// --- Transaction Endpoints (New Structure) ---

// دریافت تمام تراکنش‌ها (همراه با آیتم‌هایشان)
app.get('/transactions/:userId', async (req, res) => {
  const userId = req.params.userId;
  // const { partName, date } // Filters need to be re-evaluated for the new structure

  try {
    const transactions = await new Promise((resolve, reject) => {
      db.all('SELECT * FROM transactions WHERE user_id = ? ORDER BY date DESC, id DESC', [userId], (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });

    const results = [];
    for (const t of transactions) {
      const items = await new Promise((resolve, reject) => {
        db.all('SELECT ti.*, da.name as detailed_account_name, da.code as detailed_account_code FROM transaction_items ti JOIN detailed_accounts da ON ti.detailed_account_id = da.id WHERE ti.transaction_id = ?', [t.id], (err, itemRows) => {
          if (err) reject(err);
          else resolve(itemRows);
        });
      });
      results.push({ ...t, items });
    }
    res.json(results);
  } catch (err) {
    console.error('SQL Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ثبت تراکنش جدید
app.post('/transactions', (req, res) => {
  const { user_id, document_number, date, description, document_type, items } = req.body;

  if (!user_id || !date || !items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Missing required fields or items for transaction.' });
  }

  db.serialize(() => {
    db.run('BEGIN TRANSACTION;');
    const stmtHeader = db.prepare(
      `INSERT INTO transactions (user_id, document_number, date, description, document_type) 
       VALUES (?, ?, ?, ?, ?)`
    );

    stmtHeader.run(user_id, document_number, date, description, document_type, function(err) {
      if (err) {
        db.run('ROLLBACK;');
        console.error('Error inserting transaction header:', err.message);
        return res.status(500).json({ error: 'Failed to create transaction header: ' + err.message });
      }
      const transactionId = this.lastID;
      const stmtItem = db.prepare(
        `INSERT INTO transaction_items (transaction_id, detailed_account_id, debit, credit, party_id, quantity, unit_price, item_description) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );

      let itemError = null;
      items.forEach(item => {
        if (itemError) return; // Stop if an error occurred
        stmtItem.run(
          transactionId,
          item.detailed_account_id,
          item.debit || 0,
          item.credit || 0,
          item.party_id || null,
          item.quantity || null,
          item.unit_price || null,
          item.item_description || null,
          (itemErr) => {
            if (itemErr) {
              itemError = itemErr; 
            }
          }
        );
      });

      stmtItem.finalize(finalizeItemErr => {
        if (finalizeItemErr) itemError = itemError || finalizeItemErr; // Capture finalize error if no other error
        if (itemError) {
          db.run('ROLLBACK;');
          console.error('Error inserting transaction item(s):', itemError.message);
          return res.status(500).json({ error: 'Failed to create transaction item(s): ' + itemError.message });
        }
        db.run('COMMIT;', (commitErr) => {
          if (commitErr) {
            // Attempt rollback if commit fails, though it might be too late
            db.run('ROLLBACK;'); 
            console.error('Error committing transaction:', commitErr.message);
            return res.status(500).json({ error: 'Failed to commit transaction: ' + commitErr.message });
          }
          res.status(201).json({ id: transactionId, message: 'Transaction created successfully' });
        });
      });
    });
    stmtHeader.finalize();
  });
});

// به‌روزرسانی تراکنش
app.put('/transactions/:id', (req, res) => {
  const transactionId = req.params.id;
  const { user_id, document_number, date, description, document_type, items } = req.body; // user_id might not be updatable or needed here if tied to original creator

  if (!date || !items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Missing required fields or items for transaction update.' });
  }

  db.serialize(() => {
    db.run('BEGIN TRANSACTION;');
    const stmtUpdateHeader = db.prepare(
      `UPDATE transactions SET document_number = ?, date = ?, description = ?, document_type = ? 
       WHERE id = ? AND user_id = ?` // Ensure user owns the transaction
    );

    stmtUpdateHeader.run(document_number, date, description, document_type, transactionId, user_id, function(err) {
      if (err) {
        db.run('ROLLBACK;');
        console.error('Error updating transaction header:', err.message);
        return res.status(500).json({ error: 'Failed to update transaction header: ' + err.message });
      }
      if (this.changes === 0) {
        db.run('ROLLBACK;');
        return res.status(404).json({ error: 'Transaction not found or user mismatch.' });
      }

      // Delete old items
      db.run('DELETE FROM transaction_items WHERE transaction_id = ?', [transactionId], (deleteErr) => {
        if (deleteErr) {
          db.run('ROLLBACK;');
          console.error('Error deleting old transaction items:', deleteErr.message);
          return res.status(500).json({ error: 'Failed to delete old items: ' + deleteErr.message });
        }

        const stmtItem = db.prepare(
          `INSERT INTO transaction_items (transaction_id, detailed_account_id, debit, credit, party_id, quantity, unit_price, item_description) 
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        );
        let itemError = null;
        items.forEach(item => {
          if (itemError) return;
          stmtItem.run(
            transactionId,
            item.detailed_account_id,
            item.debit || 0,
            item.credit || 0,
            item.party_id || null,
            item.quantity || null,
            item.unit_price || null,
            item.item_description || null,
            (itemErr) => {
              if (itemErr) itemError = itemErr;
            }
          );
        });

        stmtItem.finalize(finalizeItemErr => {
          if (finalizeItemErr) itemError = itemError || finalizeItemErr;
          if (itemError) {
            db.run('ROLLBACK;');
            console.error('Error inserting new transaction item(s):', itemError.message);
            return res.status(500).json({ error: 'Failed to insert new item(s): ' + itemError.message });
          }
          db.run('COMMIT;', (commitErr) => {
            if (commitErr) {
              db.run('ROLLBACK;');
              console.error('Error committing updated transaction:', commitErr.message);
              return res.status(500).json({ error: 'Failed to commit updated transaction: ' + commitErr.message });
            }
            res.json({ id: transactionId, message: 'Transaction updated successfully' });
          });
        });
      });
    });
    stmtUpdateHeader.finalize();
  });
});

// حذف تراکنش
app.delete('/transactions/:id', (req, res) => {
  const transactionId = req.params.id;
  // user_id check can be added here if needed, e.g. from JWT or session
  db.run(`DELETE FROM transactions WHERE id = ?`, [transactionId], function (err) {
    // ON DELETE CASCADE will handle transaction_items
    if (err) {
      console.error('Error deleting transaction:', err.message);
      res.status(500).json({ error: err.message });
      return;
    }
    if (this.changes === 0) {
        return res.status(404).json({ error: 'Transaction not found.' });
    }
    res.json({ message: 'Transaction deleted successfully', id: transactionId });
  });
});

// --- End Transaction Endpoints ---

// دریافت موجودی انبار با فیلتر (No changes needed for this specific request)
app.get('/inventory', (req, res) => {
  const { partName } = req.query;
  let query = 'SELECT * FROM inventory';
  let params = [];

  if (partName) {
    query += ' WHERE partName LIKE ?';
    params.push(`%${partName}%`);
  }

  db.all(query, params, (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json(rows);
  });
});

// ثبت قطعه در انبار (No changes needed)
app.post('/inventory', (req, res) => {
  const { partName, quantity } = req.body;
  db.run(`INSERT INTO inventory (partName, quantity) VALUES (?, ?)`, [partName, quantity], function (err) {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json({ id: this.lastID });
  });
});

// به‌روزرسانی موجودی انبار (No changes needed)
app.put('/inventory/:id', (req, res) => {
  const id = req.params.id;
  const { partName, quantity } = req.body;
  db.run(
    `UPDATE inventory SET partName = ?, quantity = ? WHERE id = ?`,
    [partName, quantity, id],
    function (err) {
      if (err) {
        res.status(500).json({ error: err.message });
        return;
      }
      res.json({ message: 'Inventory updated', id });
    }
  );
});

// حذف موجودی انبار (No changes needed)
app.delete('/inventory/:id', (req, res) => {
  const id = req.params.id;
  db.run(`DELETE FROM inventory WHERE id = ?`, [id], function (err) {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json({ message: 'Inventory deleted', id });
  });
});

// دریافت طرف حساب‌ها (No changes needed)
app.get('/parties', (req, res) => {
  db.all('SELECT * FROM parties', [], (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json(rows);
  });
});

// ثبت طرف حساب (No changes needed)
app.post('/parties', (req, res) => {
  const { name, type, phone, address } = req.body;
  db.run(
    `INSERT INTO parties (name, type, phone, address) VALUES (?, ?, ?, ?)`, // Added type
    [name, type, phone, address],
    function (err) {
      if (err) {
        res.status(500).json({ error: err.message });
        return;
      }
      res.json({ id: this.lastID });
    }
  );
});

// به‌روزرسانی طرف حساب (No changes needed)
app.put('/parties/:id', (req, res) => {
  const id = req.params.id;
  const { name, type, phone, address } = req.body;
  db.run(
    `UPDATE parties SET name = ?, type = ?, phone = ?, address = ? WHERE id = ?`, // Added type
    [name, type, phone, address, id],
    function (err) {
      if (err) {
        res.status(500).json({ error: err.message });
        return;
      }
      res.json({ message: 'Party updated', id });
    }
  );
});

// حذف طرف حساب (No changes needed)
app.delete('/parties/:id', (req, res) => {
  const id = req.params.id;
  db.run(`DELETE FROM parties WHERE id = ?`, [id], function (err) {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json({ message: 'Party deleted', id });
  });
});

// --- Report Endpoints (Temporarily Commented Out) ---
/*
// گزارش شریک
app.get('/partner-report/:userId', (req, res) => {
  // This report needs to be updated to calculate profit from the new transaction_items table structure.
  res.status(510).json({ error: 'Partner report endpoint is temporarily disabled and needs an update for the new data structure.' });
});

// دریافت فروش ماهانه
app.get('/monthly-sales/:userId', (req, res) => {
  // This report needs to be updated to calculate sales from the new transaction_items table structure.
  res.status(510).json({ error: 'Monthly sales report endpoint is temporarily disabled and needs an update for the new data structure.' });
});
*/

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});

function newFunction() {
  return require('cors');
}