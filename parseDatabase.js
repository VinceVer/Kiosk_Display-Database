/* Module dependencies. */
const fs = require('fs');
const sqlite3 = require('sqlite3');
const util = require('util');

const Database = new sqlite3.Database('./bin/main-database.db');

// Open "output.txt" for writing
const outputFilePath = './output.txt';
const outputFileStream = fs.createWriteStream(outputFilePath, { flags: 'w' });


Database.run('CREATE TABLE IF NOT EXISTS devicetimeline (time INTEGER, type TEXT, device_name TEXT, kiosk_name TEXT, conn_status INTEGER, comm_status INTEGER, coupons_printed INTEGER, execution_status TEXT, fault_status INTEGER, paper_jams INTEGER, mediabin1_status INTEGER, last_seen TEXT, last_update TEXT, service_connection INTEGER, tags_printed INTEGER, target_status TEXT, status_message TEXT, from_urgency_level INTEGER, to_urgency_level INTEGER)');
Database.run('CREATE TABLE IF NOT EXISTS apptimeline (time INTEGER, type TEXT, kiosk_name TEXT, app_status INTEGER, last_seen TEXT, status_message TEXT, from_urgency_level INTEGER, to_urgency_level INTEGER)');


const sql = `ALTER TABLE devicetimeline ADD COLUMN tags_printed INTEGER`;
Database.run(sql, (err) => {
  if (err) {
      console.error(err.message);
  } else {
      console.log('New column added successfully');
  }
});

// Query the database and write the data to the text file
Database.all('SELECT time, type, device_name FROM devicetimeline WHERE type = "GPP"', (err, rows) => {
  if (err) {
    console.error('Error querying the database:', err.message);
  } else {
    // Loop through the rows and write them to the file
    rows.forEach((row) => {
      // Convert the row to a JSON string
      const rowData = JSON.stringify(row);

      // Write the row to the file, followed by a new line
      outputFileStream.write(rowData + '\n');
    });

    // Close the output file
    outputFileStream.end();

    console.log(`Data has been written to "${outputFilePath}".`);
  }
});

// Close the database connection
Database.close((err) => {
  if (err) {
    console.error('Error closing the database:', err.message);
  } else {
    console.log('Database closed.');
  }
});