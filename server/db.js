/**
 * BhoomiNex — JSON Database (PostgreSQL Simulation)
 * Implements the schema requested in the SIH 2026 PPT:
 * tables, foreign keys, and audit trails.
 */
const fs     = require('fs');
const path   = require('path');
const bcrypt = require('bcryptjs');

const DB_FILE = path.join(__dirname, 'data.json');

function defaultData() {
  return {
    users: [
      { id: 1, name: 'Admin',        username: 'admin', email: 'admin@bhoominex.gov.in', role: 'Administrator', status: 'Active', password: bcrypt.hashSync('demo123',  10) },
      { id: 2, name: 'Priya Sharma', username: 'priya', email: 'priya@bhoominex.gov.in', role: 'Verifier',      status: 'Active', password: bcrypt.hashSync('priya123', 10) },
      { id: 3, name: 'Rahul Kumar',  username: 'rahul', email: 'rahul@bhoominex.gov.in', role: 'Operator',      status: 'Active', password: bcrypt.hashSync('rahul123', 10) }
    ],
    land_records: [
      { id: 1, file_name: 'khasra_001.jpg',  file_path: null, uploaded_by: 1, status: 'APPROVED',           created_at: new Date().toISOString() },
      { id: 2, file_name: 'land_record.pdf', file_path: null, uploaded_by: 1, status: 'READY_FOR_APPROVAL', created_at: new Date().toISOString() }
    ],
    extracted_fields: [
      { record_id: 1, owner_name: 'Ramesh Kumar', khasra_number: '123/2', khata_number: null, village: 'Aurangabad', district: 'Palwal', state: 'Haryana', land_area: '2.50 Acres' },
      { record_id: 2, owner_name: 'Suresh Yadav', khasra_number: '45/1',  khata_number: null, village: 'Bichpuri',   district: 'Agra',   state: 'Uttar Pradesh', land_area: '1.75 Acres' }
    ],
    validation_results: [
      { record_id: 1, quality_score: 95, quality_grade: 'Excellent', warnings: [], errors: [] },
      { record_id: 2, quality_score: 88, quality_grade: 'Good',      warnings: [], errors: [] }
    ],
    verification_history: [],
    audit_logs: [],
    notifications: [],
    system_settings: {
      email_notifications: 'true',
      auto_validation:     'true'
    },
    _next: { users: 4, land_records: 3, audit_logs: 1, notifications: 1, verification_history: 1 }
  };
}

function load() {
  if (!fs.existsSync(DB_FILE)) {
    const data = defaultData();
    save(data);
    return data;
  }
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch (e) { const d = defaultData(); save(d); return d; }
}

function save(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
}

const db = {
  findUserById(id) { return load().users.find(u => u.id === id) || null; },
  findUserByUsername(username) { return load().users.find(u => u.username === username || u.email === username) || null; },
  getAllUsers() { return load().users.map(({ password, ...u }) => u); },
  createUser({ name, username, email, phone, role, dept, password }) {
    const d = load();
    if (d.users.find(u => u.username === username)) return { error: 'Username already in use.' };
    const user = { id: d._next.users++, name, username, email, phone, role, dept, status: 'Active', password };
    d.users.push(user);
    save(d);
    return { user };
  },

  getAllRecords() {
    const d = load();
    return d.land_records.map(rec => {
      const ext = d.extracted_fields.find(f => f.record_id === rec.id) || {};
      const val = d.validation_results.find(v => v.record_id === rec.id) || {};
      const usr = d.users.find(u => u.id === rec.uploaded_by);
      return {
        id: rec.id, file_name: rec.file_name, file_path: rec.file_path, status: rec.status, created_at: rec.created_at,
        uploader_name: usr ? usr.name : 'Unknown',
        ...ext,
        quality_score: val.quality_score, quality_grade: val.quality_grade
      };
    }).sort((a,b) => b.id - a.id);
  },

  getRecordById(id) {
    const d = load();
    const rec = d.land_records.find(r => r.id === id);
    if (!rec) return null;
    const ext = d.extracted_fields.find(f => f.record_id === id) || {};
    const val = d.validation_results.find(v => v.record_id === id) || {};
    const hist = d.verification_history.filter(h => h.record_id === id);
    return { ...rec, extracted: ext, validation: val, history: hist };
  },

  createRecordWithFields(file_name, file_path, uploaded_by, status, fields, validationReport) {
    const d = load();
    const id = d._next.land_records++;
    const rec = { id, file_name, file_path, uploaded_by, status, created_at: new Date().toISOString() };
    d.land_records.push(rec);
    
    // Store simple extracted fields (flattened)
    const flatFields = { record_id: id };
    for (const k of Object.keys(fields)) {
      flatFields[k] = fields[k].value;
      flatFields[`${k}_conf`] = fields[k].confidence;
    }
    d.extracted_fields.push(flatFields);

    d.validation_results.push({
      record_id: id,
      quality_score: validationReport.qualityScore,
      quality_grade: validationReport.qualityGrade,
      warnings: validationReport.warnings,
      errors: validationReport.errors,
      actions: validationReport.actions
    });

    d.audit_logs.push({ id: d._next.audit_logs++, record_id: id, action: 'UPLOAD', user_id: uploaded_by, created_at: new Date().toISOString() });
    save(d);
    return id;
  },

  updateExtractedFields(record_id, user_id, updates, comment) {
    const d = load();
    let ext = d.extracted_fields.find(f => f.record_id === record_id);
    if (!ext) return false;
    
    // Create history entry
    const histId = d._next.verification_history++;
    d.verification_history.push({ id: histId, record_id, action: 'CORRECTION', user_id, comment, changes: updates, created_at: new Date().toISOString() });
    
    // Apply updates
    Object.assign(ext, updates);
    save(d);
    return true;
  },

  updateRecordStatus(record_id, user_id, new_status, comment) {
    const d = load();
    const rec = d.land_records.find(r => r.id === record_id);
    if (!rec) return false;
    rec.status = new_status;
    
    d.verification_history.push({ id: d._next.verification_history++, record_id, action: new_status, user_id, comment, created_at: new Date().toISOString() });
    d.audit_logs.push({ id: d._next.audit_logs++, record_id, action: `STATUS_CHANGE_${new_status}`, user_id, created_at: new Date().toISOString() });
    
    // Notify uploader
    d.notifications.push({ id: d._next.notifications++, user_id: rec.uploaded_by, type: new_status === 'APPROVED'?'success':new_status==='REJECTED'?'error':'info', message: `Record #${record_id} status changed to ${new_status}`, created_at: new Date().toISOString(), read: false });

    save(d);
    return true;
  },

  getStats() {
    const d = load();
    return {
      total: d.land_records.length,
      approved: d.land_records.filter(r => r.status === 'APPROVED').length,
      rejected: d.land_records.filter(r => r.status === 'REJECTED').length,
      pending: d.land_records.filter(r => ['NEEDS_REVIEW','READY_FOR_APPROVAL'].includes(r.status)).length
    };
  },
  
  getNotifications(user_id) {
    return load().notifications.filter(n => n.user_id === user_id).sort((a,b)=>b.id-a.id);
  }
};

module.exports = db;
