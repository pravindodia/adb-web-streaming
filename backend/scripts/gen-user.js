const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const USERS_PATH = path.join(__dirname, "..", "users.json");

function usage() {
  console.log("Usage: node scripts/gen-user.js <username> <password> [--add]");
}

function loadUsers() {
  try {
    const raw = fs.readFileSync(USERS_PATH, "utf8");
    const users = JSON.parse(raw);
    return Array.isArray(users) ? users : [];
  } catch {
    return [];
  }
}

function saveUsers(users) {
  fs.writeFileSync(USERS_PATH, JSON.stringify(users, null, 2) + "\n", "utf8");
}

const [username, password, flag] = process.argv.slice(2);
if (!username || !password) {
  usage();
  process.exit(1);
}

const salt = crypto.randomBytes(16).toString("hex");
const hash = crypto.pbkdf2Sync(password, salt, 100000, 32, "sha256").toString("hex");

const record = { username, salt, hash };

if (flag === "--add") {
  const users = loadUsers();
  const filtered = users.filter((user) => user.username !== username);
  filtered.push(record);
  saveUsers(filtered);
  console.log(`Added user '${username}' to users.json`);
} else {
  console.log(JSON.stringify(record, null, 2));
}
