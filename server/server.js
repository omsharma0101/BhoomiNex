/**
 * BhoomiNex — Express Server (AI-Powered)
 * Handles OCR processing, validation, verification workflows,
 * and standard CRUD operations using simulated PostgreSQL structure.
 */

require('dotenv').config();
const express  = require('express');
const session  = require('express-session');
const bcrypt   = require('bcryptjs');
const path     = require('path');
const fs       = require('fs');
const os       = require('os');
const multer   = require('multer');

const db         = require('./db');
const ocr        = require('./ocr');
const validation = require('./validation');
const app        = express();
const PORT       = process.env.PORT || 3000;

function getNetworkIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'bhoominex-secret-2026',
  resave: false, saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax' }
}));

const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename:    (req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_')}`)
});
const upload = multer({
  storage, limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /\.(pdf|jpg|jpeg|png)$/i.test(file.originalname);
    if (!ok) return cb(new Error('Only PDF, JPG, JPEG, PNG formats are allowed.'));
    cb(null, true);
  }
});

app.use(express.static(path.join(__dirname, 'public')));

function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  res.status(401).json({ error: 'Not authenticated' });
}

function requireVerifier(req, res, next) {
  if (req.session && req.session.userId) {
    const u = db.findUserById(req.session.userId);
    if (u && (u.role === 'Verifier' || u.role === 'Administrator')) return next();
  }
  res.status(403).json({ error: 'Forbidden: Requires Verifier or Administrator role' });
}

// ── PAGES ─────────────────────────────────────────────────────────────────────

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, 'public', 'register.html')));

// ── API: AUTH ─────────────────────────────────────────────────────────────────

app.get('/api/me', (req, res) => {
  if (!req.session.userId) return res.json({ loggedIn: false });
  const user = db.findUserById(req.session.userId);
  if (!user) return res.json({ loggedIn: false });
  const { password, ...safe } = user;
  res.json({ loggedIn: true, user: safe });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.findUserByUsername(username?.trim());
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }
  req.session.userId   = user.id;
  req.session.username = user.username;
  const { password: _, ...safe } = user;
  res.json({ success: true, user: safe });
});

app.post('/api/logout', (req, res) => { req.session.destroy(() => res.json({ success: true })); });

// ── API: DOCUMENTS & OCR ──────────────────────────────────────────────────────

app.post('/api/documents/upload', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'A file is required.' });

  const filePath = path.join(uploadsDir, req.file.filename);
  const relativePath = `/uploads/${req.file.filename}`;
  
  // Create dummy record immediately for status tracking
  const tempId = db.createRecordWithFields(req.file.originalname, relativePath, req.session.userId, 'PROCESSING', {}, { qualityScore: 0, qualityGrade: 'N/A', warnings: [], errors: [], actions: [] });

  res.json({ success: true, message: 'File uploaded, OCR processing started...', record_id: tempId });

  // Run OCR async
  (async () => {
    try {
      const result = await ocr.runOCR(filePath);
      if (!result.success) {
        db.updateRecordStatus(tempId, req.session.userId, 'FAILED', result.error);
        return;
      }
      
      const valReport = validation.validateExtraction(result.fields, db.getAllRecords());
      
      // Update the temp record with actual data
      // For simplicity in JSON DB, we'll rewrite it or just update the arrays directly in db.js.
      // A better way is to provide an update method in db.js:
      
      const d = require('./db');
      // Hacky direct update for JSON DB to overwrite temp record:
      const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'data.json'), 'utf8'));
      
      const rec = raw.land_records.find(r => r.id === tempId);
      rec.status = valReport.suggestedStatus;

      const ext = raw.extracted_fields.find(f => f.record_id === tempId);
      for (const k of Object.keys(result.fields)) {
        ext[k] = result.fields[k].value;
        ext[`${k}_conf`] = result.fields[k].confidence;
      }
      
      const val = raw.validation_results.find(v => v.record_id === tempId);
      val.quality_score = valReport.qualityScore;
      val.quality_grade = valReport.qualityGrade;
      val.warnings = valReport.warnings;
      val.errors = valReport.errors;
      val.actions = valReport.actions;
      
      raw.audit_logs.push({ id: raw._next.audit_logs++, record_id: tempId, action: 'OCR_COMPLETED', user_id: req.session.userId, created_at: new Date().toISOString() });
      fs.writeFileSync(path.join(__dirname, 'data.json'), JSON.stringify(raw, null, 2));

    } catch(err) {
      db.updateRecordStatus(tempId, req.session.userId, 'FAILED', err.message);
    }
  })();
});

// ── API: RECORDS & VERIFICATION ───────────────────────────────────────────────

app.get('/api/records', requireAuth, (req, res) => {
  res.json(db.getAllRecords());
});

app.get('/api/records/:id', requireAuth, (req, res) => {
  const rec = db.getRecordById(Number(req.params.id));
  if (!rec) return res.status(404).json({ error: 'Record not found' });
  res.json(rec);
});

app.put('/api/records/:id/corrections', requireVerifier, (req, res) => {
  const id = Number(req.params.id);
  const { fields, comment } = req.body;
  if (!db.updateExtractedFields(id, req.session.userId, fields, comment)) {
    return res.status(404).json({ error: 'Record not found' });
  }
  res.json({ success: true });
});

app.post('/api/records/:id/approve', requireVerifier, (req, res) => {
  const { comment } = req.body;
  if (!db.updateRecordStatus(Number(req.params.id), req.session.userId, 'APPROVED', comment)) {
    return res.status(404).json({ error: 'Record not found' });
  }
  res.json({ success: true });
});

app.post('/api/records/:id/reject', requireVerifier, (req, res) => {
  const { comment } = req.body;
  if (!db.updateRecordStatus(Number(req.params.id), req.session.userId, 'REJECTED', comment)) {
    return res.status(404).json({ error: 'Record not found' });
  }
  res.json({ success: true });
});

// ── API: SYSTEM ───────────────────────────────────────────────────────────────

app.get('/api/stats', requireAuth, (req, res) => res.json(db.getStats()));
app.get('/api/notifications', requireAuth, (req, res) => res.json(db.getNotifications(req.session.userId)));
app.get('/api/network-info', (req, res) => {
  const ip = getNetworkIP();
  res.json({ ip, port: PORT, url: `http://${ip}:${PORT}` });
});

// ── CATCH-ALL ─────────────────────────────────────────────────────────────────

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'API endpoint not found.' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  const ip = getNetworkIP();
  console.log(`\n✅ BhoomiNex API Server running on port ${PORT}`);
  console.log(`🌐 Access across LAN at: http://${ip}:${PORT}`);
});
