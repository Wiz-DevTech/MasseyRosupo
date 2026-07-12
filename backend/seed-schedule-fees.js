// Seed the Schedule A fee schedule (FAA 50-category liability schedule)
// into the `schedule_fees` table. Idempotent: INSERT OR REPLACE by `code`.
const D = require('better-sqlite3');
const path = require('path');
const db = new D(path.join(__dirname, 'masseyrosupo.db'));
const { v4: uuid } = require('uuid');

const FEES = [
  ['FS-01','trespass','Unsolicited interference / trespass in private matters',100000,'per occurrence'],
  ['FS-02','fraud','Offense committed against entities (Massey)',300000,'per violation'],
  ['FS-03','rights','RICO Act violation / color of law misuse',1000000,'per occurrence'],
  ['FS-04','court','Courts refuse to file documents',10000,'per page'],
  ['FS-05','harassment','Unsolicited / solicited phone call',7000,'per call'],
  ['FS-06','harassment','Solicited letter of harassment',7000,'per letter'],
  ['FS-07','harassment','Correspondence involving meetings',2000,'per meeting'],
  ['FS-08','harassment','Unlawful letters of harassment to office',5000,'per letter'],
  ['FS-09','trespass','Correspondence to Fair Trading without consent',2000,'per occurrence'],
  ['FS-10','court','Write to court services / agents',2000,'per correspondence'],
  ['FS-11','court','Write to Trading Standards',2000,'per occurrence'],
  ['FS-12','process','Write to police / sheriff after first notice',2000,'per correspondence'],
  ['FS-13','court','Court special / general appearance',30000,'per appearance'],
  ['FS-14','harassment','Phone call to relevant bodies / agents',2000,'per call + $5/min'],
  ['FS-15','process','Failure to provide certified docs / oaths',5000,'per individual'],
  ['FS-16','process','Failure to perform directive by Sovereign Beneficiary',10000,'per occurrence'],
  ['FS-17','court','False statements from Trustees / agents',20000,'per statement'],
  ['FS-18','rights','Unlawful Arrest / Illegal Restraint — 4th Amend.',1000000,'plus additional'],
  ['FS-19','rights','Fraudulent Bond / Speedy Trial / Conspiracy',1000000,'per occurrence + land'],
  ['FS-20','rights','Assault (with or without weapon)',1000000,'per occurrence + land'],
  ['FS-21','court','Unfounded accusations by officer / sheriff',3000,'per occurrence'],
  ['FS-22','rights','Unlawful detention or incarceration',200000,'per day + land'],
  ['FS-23','court','Court without lawful reason / contempt',200000,'per occurrence'],
  ['FS-24','fraud','Coercion, deception, or attempted deception',5000,'per occurrence'],
  ['FS-25','court','Refusal of lawful bailment — Bill of Rights',100000,'per occurrence'],
  ['FS-26','rights','Coercion during unlawful detainment',200000,'per occurrence'],
  ['FS-27','property','Unlawful recording of lien / garnishment',300000,'per occurrence'],
  ['FS-28','property','Theft / destruction / concealment of property',6000,'per day + cost'],
  ['FS-29','process','Denial / abuse of due process',200000,'per occurrence'],
  ['FS-30','process','Obstruction of justice',100000,'per occurrence'],
  ['FS-31','process','Reckless credentials / failure to identify',300000,'per occurrence'],
  ['FS-32','fraud','Counterfeit staple security instrument',20000,'per occurrence'],
  ['FS-33','trespass','Every trespass on property including trust',100000,'per occurrence'],
  ['FS-34','court','Commercial liability signed affidavit perjury',5000,'per page'],
  ['FS-35','fraud','Repossession / coercion via Cestui Que Trust',200000,'per occurrence'],
  ['FS-36','rights','Human trafficking / assault / kidnapping',1000000,'per occurrence'],
  ['FS-37','harassment','Harassment after notice',100000,'per occurrence'],
  ['FS-38','court','Breach of fiduciary duty / perjury / oath',200000,'per occurrence'],
  ['FS-39','fraud','False statements from Trustees / jurisdiction',20000,'per statement'],
  ['FS-40','process','Impairment of contract by Trustees / agents',30000,'per occurrence'],
  ['FS-41','rights','Violation of unalienable rights',50000,'per occurrence'],
  ['FS-42','fraud','Harm done to family pets without cause',100000,'per occurrence'],
  ['FS-43','fraud','Request disclosure without autograph',15000,'per occurrence'],
  ['FS-44','process','Taking of fingerprints per person',4000,'per occurrence'],
  ['FS-45','process','Field test during unlawful detainment',2000,'per occurrence'],
  ['FS-46','rights','Coercion during unlawful detainment (force)',200000,'per occurrence'],
  ['FS-47','property','Fraudulent foreclosures / liens / auctions',500000,'per occurrence'],
  ['FS-48','fraud','Fraud against secured party property / Will',500000,'per violation'],
  ['FS-49','fraud','Failure to fully disclose contract under fraud',50000,'per occurrence'],
  ['FS-50','property','Impounding / towing / forced removal',7000,'per day'],
];

const existing = new Set(db.prepare('SELECT code FROM schedule_fees').all().map(r => r.code));
const ins = db.prepare('INSERT OR REPLACE INTO schedule_fees (id, code, category, name, amount, per) VALUES (?,?,?,?,?,?)');
let added = 0;
for (const [code, category, name, amount, per] of FEES) {
  const isNew = !existing.has(code);
  ins.run(uuid(), code, category, name, amount, per);
  if (isNew) added++;
}
console.log(`Schedule A: ${added} new + ${FEES.length - added} existing upserted. Total now ${db.prepare('SELECT COUNT(*) c FROM schedule_fees').get().c}.`);
