import { DatabaseSync } from "node:sqlite";
import path from "node:path";

// Task-owned process with two live SQLite WAL inventories; never opens native user storage.
const databases = ["native", "plugin"].map((name) => {
  const database = new DatabaseSync(path.join(process.argv[2], name));
  database.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE fixture (value INTEGER); INSERT INTO fixture VALUES (1)",
  );
  return database;
});
process.send?.("ready");
process.on("message", (message) => {
  if (message === "close") {
    for (const database of databases) database.close();
    process.disconnect();
  }
});
