// Seed a realistic M&R forms catalog into the `forms` table.
// Idempotent: skips any title already present.
const D = require('better-sqlite3');
const path = require('path');
const db = new D(path.join(__dirname, 'masseyrosupo.db'));
const { v4: uuid } = require('uuid');

const CATALOG = [
  // ── UCC / Article 9 (Delaware & general) ──
  ['ucc', 'UCC-1 Financing Statement', 'Initial financing statement evidencing a security interest under UCC Article 9 (Delaware and foreign jurisdictions).'],
  ['ucc', 'UCC-1Ad Addendum', 'Additional party / collateral detail for a UCC-1 filing.'],
  ['ucc', 'UCC-3 Amendment', 'Amend, assign, continue, or terminate a previously filed financing statement.'],
  ['ucc', 'UCC-3AP Assignment', 'Assign collateral under an existing UCC-3 filing.'],
  ['ucc', 'UCC-5 Correction Statement', 'Correct a previously filed record that is inaccurate or wrongfully filed.'],
  ['ucc', 'UCC-11 Information Request', 'Request a certified search / filed-record copy from the filing office.'],
  ['ucc', 'UCC-1 National Form', 'Model UCC-1 adopted by non-Delaware filing offices.'],

  // ── Delaware State (Division of Corporations) ──
  ['state', 'Delaware Certificate of Formation (LLC)', 'File a new Delaware limited liability company with the Division of Corporations.'],
  ['state', 'Delaware Certificate of Incorporation', '_charter_ formation document for a Delaware corporation (DGCL § 102).'],
  ['state', 'Delaware Annual Report & Franchise Tax', 'Yearly report + franchise tax for Delaware entities (due June 1).'],
  ['state', 'Delaware Certificate of Good Standing', 'Proof of active status issued by the Division of Corporations.'],
  ['state', 'Delaware Amendment of Certificate', 'Amend the certificate of incorporation / formation.'],
  ['state', 'Delaware MERCorp / FBE Certification', 'Foreign Qualification (Registration to Transact Business) in Delaware.'],
  ['state', 'Delaware Registered Agent Change', 'Designate or replace the statutory agent (per your agent-address change flow).'],

  // ── Federal ──
  ['federal', 'IRS Form SS-4 (EIN Application)', 'Apply for an Employer Identification Number with the IRS.'],
  ['federal', 'IRS Form 8832 (Entity Classification)', 'Elect federal tax classification for an eligible entity.'],
  ['federal', 'FinCEN BOIR (Beneficial Ownership)', 'Beneficial Ownership Information Report per the Corporate Transparency Act.'],
  ['federal', 'SEC Form D (Regulation D)', 'Notice of exempt offering of securities under Reg D.'],
  ['federal', 'USPTO Trademark Application (TEAS)', 'Federal trademark registration with the USPTO.'],

  // ── International ──
  ['international', 'UK Companies House IN01', 'Incorporate a private limited company in the United Kingdom.'],
  ['international', 'EU Article 9 Cross-Border Statement', 'Cross-border securities filing aligned to UCC Article 9 principles (EU member states).'],
  ['international', 'BVI BCA Registration', 'British Virgin Islands business company formation.'],
  ['international', 'Cayman Exempted Company Registration', 'Cayman Islands exempted company formation under the Companies Act.'],
  ['international', 'Apostille (Hague Convention)', 'Document authentication for international recognition under the Hague Apostille Convention.'],
];

const existing = new Set(db.prepare('SELECT title FROM forms').all().map(r => r.title));
let added = 0;
const ins = db.prepare('INSERT INTO forms (id, category, title, description, created_at) VALUES (?,?,?,?,datetime(\'now\'))');
for (const [category, title, description] of CATALOG) {
  if (existing.has(title)) continue;
  ins.run(uuid(), category, title, description);
  added++;
}
console.log(`Seeded ${added} new forms; total now ${db.prepare('SELECT COUNT(*) c FROM forms').get().c.c}.`);
