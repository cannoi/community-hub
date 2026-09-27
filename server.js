const express = require('express');
const http = require('http');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 8080;

// Ensure uploads directory exists
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + '-' + file.originalname);
  }
});
const upload = multer({ storage: storage });

// Database setup
const dbFile = path.join(__dirname, 'data', 'community.db');
const dataDir = path.dirname(dbFile);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new sqlite3.Database(dbFile, (err) => {
  if (err) {
    console.error('Error opening database', err.message);
  } else {
    console.log('Connected to SQLite database.');
    initDb();
  }
});

function initDb() {
  db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE,
      avatar TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      description TEXT,
      owner_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS group_members (
      group_id INTEGER,
      user_id INTEGER,
      role TEXT,
      joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (group_id, user_id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER,
      user_id INTEGER,
      content TEXT,
      file_url TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER,
      user_id INTEGER,
      content TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS reactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER,
      user_id INTEGER,
      type TEXT,
      UNIQUE(post_id, user_id)
    )`);

    // Insert default user if not exists
    db.get(`SELECT COUNT(*) as count FROM users`, (err, row) => {
      if (row.count === 0) {
        db.run(`INSERT INTO users (username, avatar) VALUES ('Alice', 'https://api.dicebear.com/7.x/avataaars/svg?seed=Alice')`);
        db.run(`INSERT INTO users (username, avatar) VALUES ('Bob', 'https://api.dicebear.com/7.x/avataaars/svg?seed=Bob')`);
        db.run(`INSERT INTO groups (name, description, owner_id) VALUES ('Tech Enthusiasts', 'A hub for discussing latest technology trends and code.', 1)`);
        db.run(`INSERT INTO group_members (group_id, user_id, role) VALUES (1, 1, 'admin')`);
        db.run(`INSERT INTO group_members (group_id, user_id, role) VALUES (1, 2, 'member')`);
        db.run(`INSERT INTO posts (group_id, user_id, content) VALUES (1, 1, 'Welcome to the Tech Enthusiasts group! Share your projects here.')`);
      }
    });
  });
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadDir));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API Endpoints
app.get('/api/users', (req, res) => {
  db.all(`SELECT * FROM users`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/users', (req, res) => {
  const { username, avatar } = req.body;
  if (!username) return res.status(400).json({ error: 'Username is required' });
  const avatarUrl = avatar || `https://api.dicebear.com/7.x/avataaars/svg?seed=${username}`;
  db.run(`INSERT INTO users (username, avatar) VALUES (?, ?)`, [username, avatarUrl], function(err) {
    if (err) return res.status(400).json({ error: 'Username may already exist' });
    res.json({ id: this.lastID, username, avatar: avatarUrl });
  });
});

app.get('/api/groups', (req, res) => {
  const sql = `
    SELECT g.*, u.username as owner_name, 
    (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = g.id) as member_count
    FROM groups g
    LEFT JOIN users u ON g.owner_id = u.id
  `;
  db.all(sql, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/groups', (req, res) => {
  const { name, description, user_id } = req.body;
  if (!name || !user_id) return res.status(400).json({ error: 'Name and user_id are required' });
  db.run(`INSERT INTO groups (name, description, owner_id) VALUES (?, ?, ?)`, [name, description, user_id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    const groupId = this.lastID;
    db.run(`INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, 'admin')`, [groupId, user_id], (err2) => {
      if (err2) console.error(err2);
      res.json({ id: groupId, name, description, owner_id: user_id });
    });
  });
});

app.get('/api/groups/:id/members', (req, res) => {
  const groupId = req.params.id;
  const sql = `
    SELECT gm.*, u.username, u.avatar
    FROM group_members gm
    JOIN users u ON gm.user_id = u.id
    WHERE gm.group_id = ?
  `;
  db.all(sql, [groupId], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/groups/:id/join', (req, res) => {
  const groupId = req.params.id;
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id is required' });
  db.run(`INSERT OR IGNORE INTO group_members (group_id, user_id, role) VALUES (?, ?, 'member')`, [groupId, user_id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

app.get('/api/groups/:id/posts', (req, res) => {
  const groupId = req.params.id;
  const sql = `
    SELECT p.*, u.username, u.avatar,
    (SELECT COUNT(*) FROM reactions r WHERE r.post_id = p.id) as reaction_count,
    (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) as comment_count
    FROM posts p
    JOIN users u ON p.user_id = u.id
    WHERE p.group_id = ?
    ORDER BY p.created_at DESC
  `;
  db.all(sql, [groupId], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/groups/:id/posts', upload.single('file'), (req, res) => {
  const groupId = req.params.id;
  const { user_id, content } = req.body;
  if (!user_id || !content) return res.status(400).json({ error: 'user_id and content are required' });
  const fileUrl = req.file ? `/uploads/${req.file.filename}` : null;
  
  db.run(`INSERT INTO posts (group_id, user_id, content, file_url) VALUES (?, ?, ?, ?)`, [groupId, user_id, content, fileUrl], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ id: this.lastID, group_id: groupId, user_id, content, file_url: fileUrl, created_at: new Date().toISOString() });
  });
});

app.get('/api/posts/:id/comments', (req, res) => {
  const postId = req.params.id;
  const sql = `
    SELECT c.*, u.username, u.avatar
    FROM comments c
    JOIN users u ON c.user_id = u.id
    WHERE c.post_id = ?
    ORDER BY c.created_at ASC
  `;
  db.all(sql, [postId], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/posts/:id/comments', (req, res) => {
  const postId = req.params.id;
  const { user_id, content } = req.body;
  if (!user_id || !content) return res.status(400).json({ error: 'user_id and content are required' });
  db.run(`INSERT INTO comments (post_id, user_id, content) VALUES (?, ?, ?)`, [postId, user_id, content], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ id: this.lastID, post_id: postId, user_id, content, created_at: new Date().toISOString() });
  });
});

app.post('/api/posts/:id/react', (req, res) => {
  const postId = req.params.id;
  const { user_id, type } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id is required' });
  
  db.get(`SELECT * FROM reactions WHERE post_id = ? AND user_id = ?`, [postId, user_id], (err, row) => {
    if (row) {
      db.run(`DELETE FROM reactions WHERE post_id = ? AND user_id = ?`, [postId, user_id], (err2) => {
        if (err2) return res.status(500).json({ error: err2.message });
        res.json({ reacted: false });
      });
    } else {
      db.run(`INSERT INTO reactions (post_id, user_id, type) VALUES (?, ?, ?)`, [postId, user_id, type || 'like'], (err2) => {
        if (err2) return res.status(500).json({ error: err2.message });
        res.json({ reacted: true });
      });
    }
  });
});

app.get('/api/groups/:id/files', (req, res) => {
  const groupId = req.params.id;
  const sql = `
    SELECT p.id, p.file_url, p.created_at, u.username 
    FROM posts p 
    JOIN users u ON p.user_id = u.id 
    WHERE p.group_id = ? AND p.file_url IS NOT NULL
  `;
  db.all(sql, [groupId], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Community Hub server running on port ${PORT}`);
});
