const fs = require('fs');
const path = require('path');
const db = require('./db');

async function exportDatabase() {
  console.log('======================================================');
  console.log('   STARTING POSTGRESQL / APP DATABASE DUMP BACKUP     ');
  console.log('======================================================\n');

  try {
    // Initialize DB if needed
    if (db.initDatabase) {
      await db.initDatabase();
    }

    const tables = [
      'users',
      'settings',
      'tiffins',
      'orders',
      'payments',
      'referrals',
      'wallet_transactions',
      'notifications',
      'push_subscriptions',
      'support_tickets',
      'support_messages',
      'reviews',
      'tokens',
      'password_resets',
      'counters'
    ];

    const backupData = {
      exported_at: new Date().toISOString(),
      version: '1.0.0',
      tables: {}
    };

    let totalRecords = 0;

    for (const table of tables) {
      try {
        const res = await db.query(`SELECT * FROM ${table};`);
        const rows = res.rows || [];
        backupData.tables[table] = rows;
        totalRecords += rows.length;
        console.log(`[Backup Success] Table '${table}': ${rows.length} records exported.`);
      } catch (err) {
        console.warn(`[Backup Warning] Table '${table}' could not be queried:`, err.message);
        backupData.tables[table] = [];
      }
    }

    // 1. Save main backup to postgres_backup.json
    const backupJsonPath = path.join(__dirname, 'postgres_backup.json');
    fs.writeFileSync(backupJsonPath, JSON.stringify(backupData, null, 2), 'utf8');
    console.log(`\n[Saved JSON Backup] -> ${backupJsonPath}`);

    // 2. Also save to db.json.backup.json for fallback compatibility
    const dbJsonBackupPath = path.join(__dirname, 'db.json.backup.json');
    fs.writeFileSync(dbJsonBackupPath, JSON.stringify(backupData, null, 2), 'utf8');

    // 3. Generate SQL dump file (postgres_backup.sql)
    let sqlDump = `-- PostgreSQL Database Backup\n-- Exported At: ${new Date().toISOString()}\n\n`;
    for (const [table, rows] of Object.entries(backupData.tables)) {
      if (rows && rows.length > 0) {
        sqlDump += `-- Table: ${table}\n`;
        for (const row of rows) {
          const keys = Object.keys(row);
          const values = keys.map(k => {
            const val = row[k];
            if (val === null || val === undefined) return 'NULL';
            if (typeof val === 'number' || typeof val === 'boolean') return val;
            if (typeof val === 'object') return `'${JSON.stringify(val).replace(/'/g, "''")}'`;
            return `'${String(val).replace(/'/g, "''")}'`;
          });
          sqlDump += `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${values.join(', ')}) ON CONFLICT DO NOTHING;\n`;
        }
        sqlDump += `\n`;
      }
    }

    const backupSqlPath = path.join(__dirname, 'postgres_backup.sql');
    fs.writeFileSync(backupSqlPath, sqlDump, 'utf8');
    console.log(`[Saved SQL Dump]    -> ${backupSqlPath}`);

    console.log('\n======================================================');
    console.log(` DATABASE BACKUP COMPLETE! (${totalRecords} records across 15 tables) `);
    console.log('======================================================\n');

    return { success: true, totalRecords, jsonPath: backupJsonPath, sqlPath: backupSqlPath, data: backupData };
  } catch (err) {
    console.error('[Backup Error] Failed to export database:', err);
    throw err;
  }
}

if (require.main === module) {
  exportDatabase()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

module.exports = { exportDatabase };
