const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const router = express.Router();

const upload = multer({
  dest: '/tmp/mr_uploads/',
  limits: { fileSize: 25 * 1024 * 1024 } // 25 MB cap
});

// POST /api/upload  -> fields: file (binary), dest (relative path), rename (optional), key (shared)
const UPLOAD_KEY = process.env.UPLOAD_KEY || 'mr-drop-2026';
router.post('/', upload.single('file'), (req, res) => {
  try {
    if (req.body.key !== UPLOAD_KEY) return res.status(403).json({ ok: false, error: 'bad key' });
    if (!req.file) return res.status(400).json({ ok: false, error: 'no file' });
    // dest: "" => M&R root (/opt/masseyrosupo.com/)
    //       "wi" or "wi/<sub>" => WI public folder (/opt/wisdom-platform-git/frontend/public/<sub>)
    const raw = (req.body.dest || '').replace(/\.\.+/g, '').trim();
    let targetDir;
    if (raw.startsWith('wi')) {
      targetDir = path.join('/opt/wisdom-platform-git/frontend/public', raw.slice(2).replace(/^\//, ''));
    } else {
      targetDir = '/opt/masseyrosupo.com';
    }
    fs.mkdirSync(targetDir, { recursive: true });
    const fileName = req.body.rename || req.file.originalname;
    const target = path.join(targetDir, fileName);
    fs.renameSync(req.file.path, target);
    const size = fs.statSync(target).size;
    return res.json({ ok: true, saved: target, bytes: size });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

module.exports = router;
