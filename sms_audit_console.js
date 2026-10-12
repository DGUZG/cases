/*
 * SMS audit: crash edits, investigations, and crash reports without an investigation
 * ==================================================================================
 *
 * HOW TO RUN
 *   1. Log in to the SMS test site: https://smst.nts.scdot.net/SMS/  (any page, e.g. Manage Logs).
 *   2. Press F12 -> Console. (Edge/Chrome may ask you to type "allow pasting" first.)
 *   3. Paste this whole file and press Enter.
 *
 *   Re-run with other options without pasting again, e.g.
 *     SMSAudit.run({ START_DATE: '06/01/2026', MATCH_WINDOW_DAYS: 30 })
 *
 * WHAT IT ANSWERS
 *   1. Which crashes were edited: who, when, what changed, and what the user was working on.
 *      SMS does NOT store a reason for crash edits (the save request only sends CRASH_ID,
 *      USER_ID and the changed columns). The script therefore reports WHAT changed and the
 *      CONTEXT (the query/report the user ran just before the edit, and any investigation
 *      covering the crash location with its "Reason for Investigation").
 *   2. Which investigations exist (name, creator, creation date, reason, location).
 *   3. Which crash report PDFs generated in REPORT_YEAR have no investigation saved for the
 *      same location (route + milepoints).
 *
 * WHERE THE DATA COMES FROM (same endpoints the SMS web app uses, read-only GET calls)
 *   SMS_SERVICE/query/logQuery                      Manage Logs entries (edits, logins, queries, reports)
 *   SMS_Service/investigation/getAllInvestigations  Investigations list
 *   SMS_SERVICE/admin/getUsers                      User id -> user name (needs admin rights; optional)
 *   SMS_Service/query/getCodedList                  Code -> description (e.g. MANNER_OF_COLLISION 80)
 *   SMS_Service/query/getCrashData                  Location of crashes whose edit had no location in it
 *   Nothing is saved or changed in SMS.
 *
 * OUTPUT
 *   Console tables, CSV downloads, and window.SMS_AUDIT (all parsed data) for further digging.
 */
(function () {
  'use strict';

  const CONFIG = {
    START_DATE: '01/01/2026', // MM/DD/YYYY: first day of logs to read
    END_DATE: null, // MM/DD/YYYY, null = today
    CHUNK_DAYS: 7, // days of logs per request (the Manage Logs page uses 1 week)
    REPORT_YEAR: 2026, // only look at crash reports generated in this year
    MATCH_WINDOW_DAYS: null, // null = any investigation at the location counts; 30 = must be created within +/-30 days of the report
    MP_TOLERANCE: 0.05, // miles of slack when comparing milepoints (SMS uses 0.05 for intersections)
    CONTEXT_MINUTES: 60, // how far back to look for the query/report a user was working on before an edit
    EDIT_GROUP_SECONDS: 120, // log lines for the same crash within this many seconds = one edit
    USER_HINT_MINUTES: 30, // for session 0 entries: suggest the user of the nearest Advanced Query within this window
    LOOKUP_CODES: true, // translate coded values via getCodedList
    FETCH_CRASH_DETAILS: true, // look up the location of crashes whose edit SQL had no location
    MAX_CRASH_DETAILS: 300,
    DOWNLOAD_CSV: true,
  };

  // ---------------------------------------------------------------- helpers

  const DAY_MS = 864e5;
  const pad2 = (n) => String(n).padStart(2, '0');
  const fmtMDY = (d) => `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}/${d.getFullYear()}`;
  const fmtTs = (d) =>
    d
      ? `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
      : '';
  const fmtDay = (d) => (d ? fmtTs(d).slice(0, 10) : '');
  const fmtHM = (d) => (d ? fmtTs(d).slice(11, 16) : '');
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const uniq = (a) => [...new Set(a)];
  const num = (v) => (v === null || v === undefined || String(v).trim() === '' || isNaN(Number(v)) ? null : Number(v));

  function parseMDY(s) {
    const m = String(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!m) throw new Error(`Date must be MM/DD/YYYY, got "${s}"`);
    return new Date(+m[3], +m[1] - 1, +m[2]);
  }

  // Server dates come as "2026-10-05T12:50:52.565" (local, no zone), "10/05/2026", or "/Date(…)/".
  function parseAnyDate(v) {
    if (v === null || v === undefined || v === '') return null;
    if (v instanceof Date) return v;
    const s = String(v).trim();
    let m = s.match(/\/Date\((-?\d+)/);
    if (m) return new Date(+m[1]);
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?/);
    if (m) {
      const ms = m[7] ? Math.round(Number('0.' + m[7]) * 1000) : 0;
      return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0), ms);
    }
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]M)?)?/i);
    if (m) {
      let h = +(m[4] || 0);
      if (m[7]) h = (h % 12) + (/p/i.test(m[7]) ? 12 : 0);
      return new Date(+m[3], +m[1] - 1, +m[2], h, +(m[5] || 0), +(m[6] || 0));
    }
    const d = new Date(s);
    return isNaN(d) ? null : d;
  }

  function pick(obj, keys) {
    if (!obj) return undefined;
    for (const k of keys) if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
    const lower = Object.fromEntries(Object.keys(obj).map((k) => [k.toLowerCase(), k]));
    for (const k of keys) {
      const real = lower[k.toLowerCase()];
      if (real && obj[real] !== undefined && obj[real] !== null && obj[real] !== '') return obj[real];
    }
    return undefined;
  }

  // SCDOT LRS key: CC TT NNNNN AA D  (county, route type, route number, auxiliary, direction)
  const LRS_RE = /\b(\d{11}[NSEW])\b/;
  function parseLrs(lrs) {
    if (!/^\d{11}[NSEW]$/.test(lrs || '')) return null;
    return {
      lrs,
      county: +lrs.slice(0, 2),
      routeType: +lrs.slice(2, 4),
      routeNumber: +lrs.slice(4, 9),
      aux: +lrs.slice(9, 11),
      dir: lrs[11],
    };
  }

  // ---------------------------------------------------------------- log rows

  const EDIT_COMPONENT = /^(Edit\b|Add New (Unit|Occupant)|Delete (Unit|Occupant))/i;
  const NOISE_COMPONENT = /^(ETL|P2S\b|Database - |Load Service\.)/i;

  function normRow(r) {
    return {
      id: Number(r.ID),
      sid: Number(r.I_SESSION_ID) || 0,
      sev: r.LOG_SEVERITY || '',
      comp: String(r.APPLICATION_COMPONENT || '').trim(),
      msg: String(r.MESSAGE === null || r.MESSAGE === undefined ? '' : r.MESSAGE),
      t: parseAnyDate(r.LOG_DATE),
    };
  }

  // Drop the bulky rows the audit never uses (ETL/imports, P2S, most Advanced Query chatter).
  function keepRow(r) {
    if (NOISE_COMPONENT.test(r.comp)) return false;
    if (r.comp === 'Advanced Query') return /user id:|Where Clause:/i.test(r.msg);
    return true;
  }

  // ---------------------------------------------------------------- users / sessions

  function buildPeople(rows, users, cfg) {
    const userById = new Map();
    for (const u of Array.isArray(users) ? users : []) {
      const id = pick(u, ['USER_ID', 'USERID', 'ID', 'user_id']);
      const uname = pick(u, ['USER_NAME', 'USERNAME', 'LOGIN_NAME', 'LOGIN', 'NT_ID']);
      const full =
        pick(u, ['FULL_NAME']) || [pick(u, ['FIRST_NAME']), pick(u, ['LAST_NAME'])].filter(Boolean).join(' ');
      if (id !== undefined) userById.set(String(id), uname || full || '');
    }

    // Sessions with a login line know their user name; Advanced Query lines carry the numeric user id.
    const sessionLogin = new Map();
    const sessionUserId = new Map();
    const advHints = [];
    for (const r of rows) {
      let m;
      if (r.comp === 'Home Service.LoginUser' && (m = r.msg.match(/Login Successful:\s*(\S+)/i))) {
        if (r.sid) sessionLogin.set(r.sid, m[1]);
      } else if ((m = r.msg.match(/user id:\s*(\d+)/i))) {
        if (r.sid && !sessionUserId.has(r.sid)) sessionUserId.set(r.sid, m[1]);
        advHints.push({ t: r.t, id: m[1] });
      }
    }
    // Learn id -> login name from sessions that have both, so hints work without admin/getUsers.
    for (const [sid, id] of sessionUserId) {
      if (sessionLogin.has(sid) && !userById.get(id)) userById.set(id, sessionLogin.get(sid));
    }
    const nameForId = (id) => userById.get(String(id)) || `user #${id}`;

    function who(sid) {
      if (!sid) return '';
      if (sessionLogin.has(sid)) return sessionLogin.get(sid);
      if (sessionUserId.has(sid)) return nameForId(sessionUserId.get(sid));
      return '';
    }
    // Only a guess: session 0 is shared, so name whoever ran an Advanced Query closest in time.
    function hint(t, sid) {
      if (who(sid) || !t) return '';
      let best = null;
      for (const h of advHints) {
        const d = Math.abs(h.t - t);
        if (d <= cfg.USER_HINT_MINUTES * 60000 && (!best || d < best.d)) best = { d, id: h.id };
      }
      return best ? `${nameForId(best.id)}?` : '';
    }
    return { who, hint, nameForId };
  }

  // ---------------------------------------------------------------- SQL parsing (Edit Crash log lines)

  function splitTopLevel(s) {
    const out = [];
    let depth = 0;
    let inQuote = false;
    let cur = '';
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === "'") {
        if (inQuote && s[i + 1] === "'") {
          cur += "''";
          i++;
          continue;
        }
        inQuote = !inQuote;
      } else if (!inQuote) {
        if (c === '(') depth++;
        else if (c === ')') depth--;
        else if (c === ',' && depth === 0) {
          out.push(cur);
          cur = '';
          continue;
        }
      }
      cur += c;
    }
    if (cur.trim()) out.push(cur);
    return out;
  }

  const unquote = (v) => {
    v = v.trim();
    return /^'[\s\S]*'$/.test(v) ? v.slice(1, -1).replace(/''/g, "'") : v;
  };

  function whereKeys(w) {
    const keys = {};
    for (const m of w.matchAll(/(\w+)\s*=\s*'?(\d+)'?/g)) keys[m[1].toUpperCase()] = m[2];
    return keys;
  }

  function parseSql(msg) {
    let m = msg.match(/\bUPDATE\s+([\w.]+)\s+SET\s+([\s\S]*?)\s+WHERE\s+([\s\S]*)$/i);
    if (m) {
      const set = {};
      for (const part of splitTopLevel(m[2])) {
        const i = part.indexOf('=');
        if (i > 0) set[part.slice(0, i).trim().toUpperCase()] = unquote(part.slice(i + 1));
      }
      return { op: 'UPDATE', table: m[1].toUpperCase(), set, keys: whereKeys(m[3]) };
    }
    m = msg.match(/\bINSERT\s+INTO\s+([\w.]+)\s*\(([^)]*)\)\s*VALUES\s*\(([\s\S]*)\)\s*;?\s*$/i);
    if (m) {
      const cols = m[2].split(',').map((c) => c.trim().toUpperCase());
      const vals = splitTopLevel(m[3]).map(unquote);
      const set = Object.fromEntries(cols.map((c, i) => [c, vals[i]]));
      const keys = Object.fromEntries(Object.entries(set).filter(([k, v]) => /_ID$/.test(k) && /^\d+$/.test(v || '')));
      return { op: 'INSERT', table: m[1].toUpperCase(), set, keys };
    }
    m = msg.match(/\bDELETE\s+FROM\s+([\w.]+)\s+WHERE\s+([\s\S]*)$/i);
    if (m) return { op: 'DELETE', table: m[1].toUpperCase(), set: {}, keys: whereKeys(m[2]) };
    return null;
  }

  const LOCATION_COLS = new Set([
    'IS_INTERSECTION',
    'MILEPOINT',
    'CRASH_LOCATION_STATUS',
    'ETL_PLACEMENT_METHOD',
    'LATITUDE_PROJECTED',
    'LONGITUDE_PROJECTED',
    'COUNTY',
    'DISTRICT',
    'GEOMETRY',
  ]);
  const isLocationCol = (c) => LOCATION_COLS.has(c) || /^(MAIN|BASE|SEC)_(LRS_KEY_ID|ROUTE_)/.test(c);
  const isCrashTable = (t) => /^SMS\.CRASH(_LOCATION)?$/.test(t);

  function buildEditEvents(rows, cfg) {
    const events = [];
    const lastByCrash = new Map();
    const lastBySid = new Map();
    for (const r of rows) {
      if (!EDIT_COMPONENT.test(r.comp)) continue;
      const sql = parseSql(r.msg);
      const crashId =
        (sql && (sql.keys.CRASH_ID || sql.set.CRASH_ID)) || (r.msg.match(/crash[ _]?id\D{0,4}(\d{5,})/i) || [])[1] || '';
      let ev = crashId ? lastByCrash.get(crashId) : lastBySid.get(r.sid);
      if (ev && (ev.sid !== r.sid || r.t - ev.last > cfg.EDIT_GROUP_SECONDS * 1000)) ev = null;
      if (!ev) {
        ev = { crashId, sid: r.sid, first: r.t, last: r.t, rows: [], stmts: [] };
        events.push(ev);
      }
      if (!ev.crashId && crashId) ev.crashId = crashId;
      ev.last = r.t;
      ev.rows.push(r);
      if (sql) ev.stmts.push(sql);
      if (ev.crashId) lastByCrash.set(ev.crashId, ev);
      lastBySid.set(r.sid, ev);
    }

    for (const ev of events) {
      const crashSet = {};
      const other = [];
      for (const s of ev.stmts) {
        if (isCrashTable(s.table) && s.op === 'UPDATE') Object.assign(crashSet, s.set);
        else other.push(s);
      }
      delete crashSet.GEOMETRY;
      ev.crashSet = crashSet;
      ev.other = other;
      ev.attributeCols = Object.keys(crashSet).filter((c) => !isLocationCol(c));
      ev.relocated = ['MAIN_LRS_KEY_ID', 'MILEPOINT', 'LATITUDE_PROJECTED', 'LONGITUDE_PROJECTED'].some((c) => c in crashSet);
      ev.unlocatable = String(crashSet.CRASH_LOCATION_STATUS).trim() === '2';
      ev.failed = ev.rows.some((r) => r.sev === 'E');
      if (ev.relocated && parseLrs(crashSet.MAIN_LRS_KEY_ID)) {
        ev.location = { lrs: crashSet.MAIN_LRS_KEY_ID, mp: num(crashSet.MILEPOINT), source: 'edit' };
      }
    }
    return events;
  }

  // ---------------------------------------------------------------- work context (queries, reports)

  function parseBasicQuery(msg) {
    const q = {};
    let m;
    if ((m = msg.match(/CRASH_DATE BETWEEN TO_DATE\('([\d/]+)'[^)]*\)\s*AND\s*TO_DATE\('([\d/]+)'/i))) {
      q.from = m[1];
      q.to = m[2];
    }
    if ((m = msg.match(/DOM_RTE_LRS\s*=\s*'(\w+)'/i))) {
      q.lrs = m[1];
      q.intersection = true;
    } else if ((m = msg.match(/MAIN_LRS_KEY_ID\s*=\s*'(\w+)'/i))) q.lrs = m[1];
    if (!q.intersection && (m = msg.match(/MILEPOINT BETWEEN ([\d.]+) AND ([\d.]+)/i))) {
      q.bmp = +m[1];
      q.emp = +m[2];
    }
    if ((m = msg.match(/DOM_MP IN \(([^)]*)\)/i))) q.mps = uniq(m[1].split(',').map(Number));
    if ((m = msg.match(/DOM_RTE_XED_LRS IN \(([^)]*)\)/i))) q.cross = m[1].replace(/'/g, '').split(',').map((s) => s.trim());
    if (/NUMBER_FATALITY\s*>\s*0/i.test(msg)) q.fatalOnly = true;
    return q;
  }

  function describeQuery(q) {
    let s = q.lrs ? q.lrs : 'no route';
    if (q.bmp !== undefined) s += ` MP ${q.bmp}-${q.emp}`;
    if (q.mps) s += ` @ MP ${q.mps.join('/')}`;
    if (q.cross) s += ` x ${q.cross.join(',')}`;
    if (q.from) s += `, crashes ${q.from}-${q.to}`;
    if (q.fatalOnly) s += ', fatal only';
    return s;
  }

  function buildQueryContext(rows) {
    const items = [];
    for (const r of rows) {
      let m;
      if (r.comp === 'Basic Query' && /Record Count SQL/i.test(r.msg)) {
        const q = parseBasicQuery(r.msg);
        items.push({ t: r.t, sid: r.sid, kind: 'query', q, text: `Basic query ${describeQuery(q)}` });
      } else if (r.comp === 'Basic Query' && (m = r.msg.match(/Query restricted to a single crash \((\d+)\)/i))) {
        items.push({ t: r.t, sid: r.sid, kind: 'single', crashId: m[1], text: `Single-crash query ${m[1]}` });
      } else if (r.comp === 'Advanced Query' && (m = r.msg.match(/Where Clause:\s*([\s\S]*)/i))) {
        items.push({ t: r.t, sid: r.sid, kind: 'advanced', text: `Advanced query ${m[1].slice(0, 160)}` });
      }
    }
    return items;
  }

  // Each PDF crash report saves its crash list ("newCrashList") and then logs header info
  // ("Report Service.getHeaderInformation"); area reports log "No Main Route LRS designated".
  function buildReports(rows) {
    const events = [];
    const open = new Map();
    for (const r of rows) {
      const isList = r.comp === 'newCrashList';
      const isReport = /^Report Service/i.test(r.comp) || /^stackBy/i.test(r.comp);
      const isNoMain = r.comp === 'Basic Query' && /No Main Route LRS designated/i.test(r.msg);
      if (!isList && !isReport && !isNoMain) continue;
      let ev = open.get(r.sid);
      if (isList || !ev || r.t - ev.last > 30000) {
        ev = { sid: r.sid, first: r.t, last: r.t, rows: [], mps: [], crossings: [], hasList: false };
        events.push(ev);
        open.set(r.sid, ev);
      }
      ev.last = r.t;
      ev.rows.push(r);
      if (isList) ev.hasList = true;
    }

    for (const ev of events) {
      for (const r of ev.rows) {
        let m;
        if ((m = r.msg.match(/Using Weighted AADT for LRS:\s*\((\w+)\)\s*from BMP\s*\(([-\d.]+)\)\s*to EMP\s*\(([-\d.]+)\)/i))) {
          ev.kind = 'segment';
          ev.lrs = m[1];
          ev.bmp = +m[2];
          ev.emp = +m[3];
        } else if ((m = r.msg.match(/Getting AADT for Main LRS\s*\((\w+)\)/i))) {
          if (ev.kind !== 'segment') ev.kind = 'intersection';
          ev.lrs = ev.lrs || m[1];
        } else if ((m = r.msg.match(/Intersection MP on Main LRS\s*\(([-\d.]+)\)/i))) {
          ev.mps.push(+m[1]);
        } else if ((m = r.msg.match(/Crossing LRS\s*\((\w+)\)\s*Intersection MP\s*\(([-\d.]+)\)/i))) {
          ev.crossings.push({ lrs: m[1], mp: +m[2] });
        } else if (/No Main Route LRS designated/i.test(r.msg)) {
          ev.noMain = true;
        } else if ((m = r.msg.match(LRS_RE)) && !ev.lrs) {
          ev.lrs = m[1];
        }
      }
      ev.mps = uniq(ev.mps);
      ev.crossings = uniq(ev.crossings.map((c) => `${c.lrs}@${c.mp}`)).map((s) => {
        const [lrs, mp] = s.split('@');
        return { lrs, mp: +mp };
      });
      if (!ev.kind) {
        if (ev.noMain) ev.kind = 'no main route';
        else if (ev.lrs) ev.kind = 'other';
        else ev.kind = ev.rows.every((r) => r.comp === 'newCrashList') ? 'crash list only' : 'other';
      }
    }
    return events;
  }

  function findContext(items, t, sid, cfg, prefer) {
    const from = t - cfg.CONTEXT_MINUTES * 60000;
    const cands = items.filter((c) => c.t <= t && c.t >= from && c.sid === sid);
    if (!cands.length) return null;
    const preferred = prefer ? cands.filter(prefer) : [];
    return (preferred.length ? preferred : cands).reduce((a, b) => (b.t > a.t ? b : a));
  }

  // ---------------------------------------------------------------- investigations

  function normInvestigation(raw) {
    const aux = raw.ROUTE_AUX;
    const auxText = aux === null || aux === undefined ? '' : String(aux).trim();
    let bmp = num(raw.BMP);
    let emp = num(raw.EMP);
    if (bmp !== null && emp !== null && bmp > emp) [bmp, emp] = [emp, bmp];
    const lrs = Object.values(raw).find((v) => typeof v === 'string' && /^\d{11}[NSEW]$/.test(v)) || null;
    return {
      raw,
      id: pick(raw, ['INVEST_ID', 'INVESTIGATION_ID', 'ID']),
      name: raw.NAME || '',
      reason: raw.REASON || '',
      created: parseAnyDate(pick(raw, ['CREATION_DATE', 'CREATED_DATE', 'REQUEST_DATE'])),
      createdBy: pick(raw, ['CREATED_BY_USERNAME', 'CREATED_BY']) || '',
      fullName: pick(raw, ['FULL_NAME', 'CREATED_BY_NAME']) || '',
      county: num(pick(raw, ['COUNTY', 'COUNTY_ID'])),
      routeType: num(raw.ROUTE_TYPE),
      routeNumber: num(raw.ROUTE_NUMBER),
      // The app stores ROUTE_AUX as text and shows empty as "MAINLINE"; LRS aux code 00 = mainline.
      auxMain: auxText === '' || /^(mainline|0+)$/i.test(auxText),
      auxText,
      bmp,
      emp,
      lrs,
    };
  }

  function sameRoute(inv, L) {
    if (!L) return false;
    if (inv.lrs) return inv.lrs.slice(0, 11) === L.lrs.slice(0, 11);
    if (inv.county === null || inv.routeType === null || inv.routeNumber === null) return false;
    return (
      inv.county === L.county &&
      inv.routeType === L.routeType &&
      inv.routeNumber === L.routeNumber &&
      inv.auxMain === (L.aux === 0)
    );
  }

  function invCoversPoint(inv, lrs, mp, tol) {
    if (!sameRoute(inv, parseLrs(lrs))) return false;
    if (inv.bmp === null || inv.emp === null || mp === null || mp === undefined) return true;
    return mp >= inv.bmp - tol && mp <= inv.emp + tol;
  }

  function invOverlaps(inv, lrs, bmp, emp, tol) {
    if (!sameRoute(inv, parseLrs(lrs))) return false;
    if (inv.bmp === null || inv.emp === null) return true;
    return Math.min(bmp, emp) <= inv.emp + tol && Math.max(bmp, emp) >= inv.bmp - tol;
  }

  const invLabel = (inv) =>
    `#${inv.id} ${inv.name}${inv.created ? ` (${fmtDay(inv.created)})` : ''}${inv.reason ? ` - reason: ${inv.reason}` : ''}`;

  // ---------------------------------------------------------------- analysis

  function analyze(input, cfgOverrides) {
    const cfg = { ...CONFIG, ...(cfgOverrides || {}) };
    const rows = input.rows.slice().sort((a, b) => a.id - b.id);
    const codes = input.codes || {};
    const crashDetails = input.crashDetails || {};
    const people = buildPeople(rows, input.users, cfg);
    const invs = (input.investigations || []).map(normInvestigation);
    const ctxItems = buildQueryContext(rows);
    const tol = cfg.MP_TOLERANCE;

    // 1. crash edits
    const editEvents = buildEditEvents(rows, cfg);
    for (const ev of editEvents) {
      if (!ev.location && crashDetails[ev.crashId]) {
        const d = crashDetails[ev.crashId];
        if (parseLrs(d.MAIN_LRS_KEY_ID)) ev.location = { lrs: d.MAIN_LRS_KEY_ID, mp: num(d.MILEPOINT), source: 'crash record' };
      }
    }
    const editRows = editEvents.map((ev) => {
      const s = ev.crashSet;
      const types = [];
      const changed = [];
      if (ev.unlocatable) {
        types.push('Marked UNLOCATABLE');
        changed.push('CRASH_LOCATION_STATUS=2 (unlocatable)');
      }
      if (ev.relocated) {
        types.push('Relocated');
        let txt = `Moved to ${s.MAIN_ROUTE_NAME || '?'} ${s.MAIN_LRS_KEY_ID || ''} MP ${s.MILEPOINT || '?'}`;
        if (String(s.IS_INTERSECTION) === '1' && s.BASE_ROUTE_NAME) txt += ` at ${s.BASE_ROUTE_NAME}`;
        if (s.LATITUDE_PROJECTED) txt += ` (${s.LATITUDE_PROJECTED}, ${s.LONGITUDE_PROJECTED})`;
        changed.push(txt);
      }
      if (ev.attributeCols.length) {
        types.push('Crash attributes');
        for (const c of ev.attributeCols) {
          const label = codes[c] && codes[c][String(s[c])];
          changed.push(`${c}=${s[c]}${label ? ` (${label})` : ''}`);
        }
      }
      for (const st of ev.other) {
        const tbl = st.table.split('.').pop();
        types.push(/PERSON|OCCUPANT/.test(tbl) ? 'Person/occupant' : /UNIT|VEHICLE/.test(tbl) ? 'Unit/vehicle' : tbl);
        const cols = Object.entries(st.set)
          .filter(([k]) => k !== 'GEOMETRY')
          .map(([k, v]) => {
            const label = codes[k] && codes[k][String(v)];
            return `${k}=${v}${label ? ` (${label})` : ''}`;
          });
        const keys = Object.entries(st.keys)
          .map(([k, v]) => `${k}=${v}`)
          .join(' ');
        changed.push(`${st.op} ${tbl}${keys ? ` [${keys}]` : ''}${cols.length ? ': ' + cols.join(', ') : ''}`);
      }
      if (!ev.stmts.length) {
        types.push(uniq(ev.rows.map((r) => r.comp)).join('/'));
        changed.push(ev.rows.map((r) => r.msg).join(' | ').slice(0, 300));
      }
      if (ev.failed) types.unshift('FAILED');

      const loc = ev.location;
      const ctx = findContext(ctxItems, ev.first, ev.sid, cfg, (c) =>
        c.kind === 'single' ? c.crashId === ev.crashId : !!(loc && c.q && c.q.lrs === loc.lrs),
      );
      const invHere = loc ? invs.filter((i) => invCoversPoint(i, loc.lrs, loc.mp, tol)) : [];
      const details = crashDetails[ev.crashId] || {};
      const dbAudit = Object.entries(details)
        .filter(([k, v]) => /MODIF|UPDATED|EDIT/i.test(k) && v !== null && v !== '')
        .map(([k, v]) => `${k}=${v}`)
        .join('; ');
      return {
        EDIT_TIME: fmtTs(ev.first),
        CRASH_ID: ev.crashId,
        USER: people.who(ev.sid),
        USER_HINT: people.hint(ev.first, ev.sid),
        SESSION_ID: ev.sid,
        EDIT_TYPE: uniq(types).join(' + '),
        WHAT_CHANGED: changed.join(' | '),
        CRASH_LOCATION: loc ? `${loc.lrs} MP ${loc.mp}${loc.source === 'crash record' ? ' (current)' : ''}` : '',
        WORKING_ON: ctx ? `${ctx.text} (${fmtHM(ctx.t)})` : '',
        INVESTIGATIONS_AT_LOCATION: invHere.map(invLabel).join(' || '),
        DB_AUDIT_FIELDS: dbAudit,
        LOG_IDS: ev.rows.map((r) => r.id).join(' '),
        RAW_LOG: ev.rows
          .filter((r) => !/Geometry:/i.test(r.msg))
          .map((r) => r.msg)
          .join(' | '),
      };
    });

    const byCrash = new Map();
    for (const e of editRows) {
      const key = e.CRASH_ID || `(no crash id) ${e.LOG_IDS}`;
      if (!byCrash.has(key)) byCrash.set(key, []);
      byCrash.get(key).push(e);
    }
    const editedCrashes = [...byCrash.entries()].map(([crashId, list]) => ({
      CRASH_ID: crashId,
      EDITS: list.length,
      FIRST_EDIT: list[0].EDIT_TIME,
      LAST_EDIT: list[list.length - 1].EDIT_TIME,
      USERS: uniq(list.map((e) => e.USER || e.USER_HINT || '(session 0)')).join(', '),
      EDIT_TYPES: uniq(list.flatMap((e) => e.EDIT_TYPE.split(' + '))).join(', '),
      LAST_CHANGE: list[list.length - 1].WHAT_CHANGED,
      CRASH_LOCATION: list.map((e) => e.CRASH_LOCATION).filter(Boolean).pop() || '',
      WORKING_ON: list.map((e) => e.WORKING_ON).filter(Boolean).pop() || '',
      INVESTIGATIONS_AT_LOCATION: list.map((e) => e.INVESTIGATIONS_AT_LOCATION).filter(Boolean).pop() || '',
    }));

    // 2. crash reports
    const reportEvents = buildReports(rows);
    const matchable = (ev) => ev.kind === 'segment' || ev.kind === 'intersection';
    const runs = reportEvents
      .filter((ev) => ev.kind !== 'crash list only' && ev.first && ev.first.getFullYear() === cfg.REPORT_YEAR)
      .map((ev) => {
        let matches = null;
        if (matchable(ev)) {
          if (ev.kind === 'segment') {
            matches = invs.filter((i) => invOverlaps(i, ev.lrs, ev.bmp, ev.emp, tol));
          } else {
            const points = [...(ev.mps.length ? ev.mps : [null]).map((mp) => ({ lrs: ev.lrs, mp })), ...ev.crossings];
            matches = invs.filter((i) => points.some((p) => invCoversPoint(i, p.lrs, p.mp, tol)));
          }
          if (cfg.MATCH_WINDOW_DAYS !== null && cfg.MATCH_WINDOW_DAYS !== undefined) {
            matches = matches.filter((i) => i.created && Math.abs(i.created - ev.first) <= cfg.MATCH_WINDOW_DAYS * DAY_MS);
          }
        }
        const ctx = findContext(ctxItems, ev.first, ev.sid, cfg, (c) => !!(c.q && ev.lrs && c.q.lrs === ev.lrs));
        return { ev, matches, ctx };
      });

    // Users often regenerate the same report several times in a row: collapse those.
    const groups = new Map();
    for (const run of runs) {
      const ev = run.ev;
      const user = people.who(ev.sid) || people.hint(ev.first, ev.sid);
      const key = [
        user || ev.sid,
        fmtDay(ev.first),
        ev.kind,
        ev.lrs,
        ev.bmp,
        ev.emp,
        ev.mps.join('/'),
        ev.crossings.map((c) => c.lrs + '@' + c.mp).join(','),
      ].join('|');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(run);
    }
    const reports = [...groups.values()].map((list) => {
      const { ev, matches } = list[0];
      const ctx = list.map((r) => r.ctx).find(Boolean);
      const L = parseLrs(ev.lrs);
      let has = 'n/a (no main route)';
      if (matches) has = matches.length ? 'YES' : 'NO';
      else if (ev.kind === 'other') has = 'n/a (unrecognised report log)';
      const nearest = (matches || [])
        .filter((i) => i.created)
        .sort((a, b) => Math.abs(a.created - ev.first) - Math.abs(b.created - ev.first))[0];
      return {
        FIRST_RUN: fmtTs(ev.first),
        LAST_RUN: fmtTs(list[list.length - 1].ev.first),
        RUNS: list.length,
        USER: people.who(ev.sid),
        USER_HINT: people.hint(ev.first, ev.sid),
        SESSION_ID: ev.sid,
        REPORT_TYPE: ev.kind,
        LRS: ev.lrs || '',
        COUNTY: L ? L.county : '',
        ROUTE_TYPE: L ? L.routeType : '',
        ROUTE_NUMBER: L ? L.routeNumber : '',
        ROUTE_AUX_CODE: L ? pad2(L.aux) : '',
        BMP: ev.bmp ?? '',
        EMP: ev.emp ?? '',
        INTERSECTION_MP: ev.mps.join('/'),
        CROSSING_ROUTES: ev.crossings.map((c) => `${c.lrs} MP ${c.mp}`).join(', '),
        QUERY: ctx ? `${ctx.text} (${fmtHM(ctx.t)})` : '',
        QUERY_CRASH_DATES: ctx && ctx.q && ctx.q.from ? `${ctx.q.from}-${ctx.q.to}` : '',
        HAS_INVESTIGATION: has,
        MATCHED_INVESTIGATIONS: (matches || []).map(invLabel).join(' || '),
        NEAREST_INVESTIGATION_CREATED: nearest ? fmtDay(nearest.created) : '',
        DAYS_REPORT_TO_INVESTIGATION: nearest ? Math.round((nearest.created - ev.first) / DAY_MS) : '',
        LOG_IDS: list.flatMap((r) => r.ev.rows.map((x) => x.id)).join(' '),
      };
    });
    const reportsWithoutInvestigation = reports.filter((r) => r.HAS_INVESTIGATION === 'NO');

    // 3. investigations
    const start = parseMDY(cfg.START_DATE);
    const end = cfg.END_DATE ? addDays(parseMDY(cfg.END_DATE), 1) : new Date(8.64e15);
    const investigations = invs
      .slice()
      .sort((a, b) => (b.created || 0) - (a.created || 0))
      .map((inv) => {
        const r = inv.raw;
        const reportHits = reports.filter((rep) => rep.MATCHED_INVESTIGATIONS.split(' || ').some((s) => s.startsWith(`#${inv.id} `)));
        const editHits = editRows.filter((e) => e.INVESTIGATIONS_AT_LOCATION.split(' || ').some((s) => s.startsWith(`#${inv.id} `)));
        return {
          INVEST_ID: inv.id,
          NAME: inv.name,
          CREATION_DATE: inv.created ? fmtTs(inv.created) : r.CREATION_DATE || '',
          IN_AUDIT_RANGE: inv.created && inv.created >= start && inv.created < end ? 'YES' : 'NO',
          CREATED_BY: inv.createdBy,
          FULL_NAME: inv.fullName,
          REASON: inv.reason,
          STATUS: r.STATUS_TEXT || r.STATUS || '',
          OUTCOME: r.OUTCOME_TEXT || r.OUTCOME || '',
          COUNTY: r.COUNTY ?? '',
          ROUTE_TYPE: r.ROUTE_TYPE ?? '',
          ROUTE_NUMBER: r.ROUTE_NUMBER ?? '',
          ROUTE_AUX: inv.auxText || 'MAINLINE',
          BMP: r.BMP ?? '',
          EMP: r.EMP ?? '',
          INTERSECTION_ID: r.INTERSECTION_ID ?? '',
          CRASH_DATES: r.START_DATE || r.END_DATE ? `${r.START_DATE || ''}-${r.END_DATE || ''}` : '',
          REQUEST_DATE: r.REQUEST_DATE || '',
          TAGS: r.TAG_NAMES || (Array.isArray(r.TAGS) ? r.TAGS.join('|') : r.TAGS || ''),
          COMMENTS: r.COMMENT_COUNT ?? '',
          ATTACHMENTS: r.FILE_COUNT ?? '',
          LINKED_PROJECTS: r.LINKED_PROJECT_COUNT ?? '',
          REPORT_GROUPS_MATCHED: reportHits.length,
          CRASH_EDITS_AT_LOCATION: editHits.length,
        };
      });

    const unparsedInvestigations = invs.filter((i) => !i.lrs && (i.county === null || i.routeType === null || i.routeNumber === null));

    return {
      cfg,
      rows,
      people,
      editEvents,
      edits: editRows,
      editedCrashes,
      reportEvents,
      reports,
      reportsWithoutInvestigation,
      crashListOnlyEvents: reportEvents.filter((e) => e.kind === 'crash list only'),
      investigations,
      investigationsInRange: investigations.filter((i) => i.IN_AUDIT_RANGE === 'YES'),
      unparsedInvestigations,
    };
  }

  // Which coded columns / crash ids need extra lookups before the final analysis.
  function lookupNeeds(rows, cfg) {
    const events = buildEditEvents(rows.slice().sort((a, b) => a.id - b.id), { ...CONFIG, ...(cfg || {}) });
    const cols = new Set();
    for (const ev of events) {
      ev.attributeCols.forEach((c) => cols.add(c));
      for (const st of ev.other) Object.keys(st.set).forEach((c) => !/_ID$|GEOMETRY/.test(c) && cols.add(c));
    }
    const crashIds = uniq(events.filter((ev) => ev.crashId && !ev.location).map((ev) => ev.crashId));
    return { columns: [...cols], crashIds };
  }

  // ---------------------------------------------------------------- browser side

  function flattenRecord(x) {
    const out = {};
    const visit = (v, depth) => {
      if (v === null || v === undefined || depth > 4) return;
      if (Array.isArray(v)) {
        const pairs = v.length && v.every((e) => e && typeof e === 'object' && ('COLUMN_NAME' in e || 'SHORT_NAME' in e) && 'VALUE' in e);
        if (pairs) {
          for (const e of v) {
            const k = String(e.COLUMN_NAME || e.SHORT_NAME).toUpperCase();
            if (!(k in out)) out[k] = e.VALUE;
          }
          return;
        }
        v.slice(0, 5).forEach((e) => visit(e, depth + 1));
        return;
      }
      if (typeof v === 'object') {
        for (const [k, val] of Object.entries(v)) {
          if (val !== null && typeof val === 'object') visit(val, depth + 1);
          else if (!(k.toUpperCase() in out)) out[k.toUpperCase()] = val;
        }
      }
    };
    visit(x, 0);
    return out;
  }

  function codeMap(list) {
    const map = {};
    for (const e of Array.isArray(list) ? list : []) {
      if (!e || typeof e !== 'object') continue;
      const keys = Object.keys(e);
      const code = pick(e, ['CODE_NUM', 'CODE', 'ID', 'VALUE']) ?? e[keys[0]];
      const label = pick(e, ['CODE_VAL', 'DESCRIPTION', 'DESC', 'NAME', 'TEXT']) ?? e[keys[1]];
      if (code !== undefined) map[String(code)] = label;
    }
    return map;
  }

  function makeClient(token) {
    const base = location.origin + '/';
    return async function get(path, params) {
      const url = new URL(path, base);
      for (const [k, v] of Object.entries(params || {})) url.searchParams.append(k, v === null || v === undefined ? '' : v);
      const res = await fetch(url, { headers: { Authorization: token, Accept: 'application/json, text/plain, */*' } });
      if (res.status === 401) throw new Error('401 Unauthorized: your SMS session expired. Log in again and re-run.');
      if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url.pathname}`);
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch (e) {
        return text;
      }
    };
  }

  async function fetchLogs(get, start, end, cfg) {
    const byId = new Map();
    let fetched = 0;
    async function fetchWindow(a, b) {
      const data = await get('SMS_SERVICE/query/logQuery', { severity: '', component: '', startdate: fmtMDY(a), enddate: fmtMDY(b) });
      if (!Array.isArray(data)) throw new Error('Unexpected logQuery response: ' + JSON.stringify(data).slice(0, 300));
      const days = Math.round((b - a) / DAY_MS) + 1;
      // A suspiciously round row count may mean the server capped the result: split the window.
      if (data.length >= 1000 && data.length % 500 === 0 && days > 1) {
        const mid = addDays(a, Math.floor(days / 2) - 1);
        await fetchWindow(a, mid);
        await fetchWindow(addDays(mid, 1), b);
        return;
      }
      fetched += data.length;
      for (const raw of data) {
        const r = normRow(raw);
        if (keepRow(r)) byId.set(r.id, r);
      }
    }
    const windows = [];
    for (let d = new Date(start); d <= end; d = addDays(d, cfg.CHUNK_DAYS)) {
      const b = addDays(d, cfg.CHUNK_DAYS - 1);
      windows.push([d, b > end ? end : b]);
    }
    for (let i = 0; i < windows.length; i++) {
      const [a, b] = windows[i];
      console.log(`  logs ${fmtMDY(a)} - ${fmtMDY(b)}  (${i + 1}/${windows.length})`);
      await fetchWindow(a, b);
    }
    console.log(`  ${fetched} log rows read, ${byId.size} kept after dropping ETL/import/P2S noise`);
    return [...byId.values()];
  }

  async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
  }

  function toCsv(rows, cols) {
    const esc = (v) => {
      if (v === null || v === undefined) return '';
      const s = v instanceof Date ? fmtTs(v) : String(v);
      return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\r\n');
  }

  function downloadCsv(name, rows) {
    if (!rows.length) return;
    const blob = new Blob(['﻿' + toCsv(rows, Object.keys(rows[0]))], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 2000);
  }

  function downloadAll(result) {
    const tag = `${result.cfg.START_DATE.replace(/\//g, '-')}_to_${(result.cfg.END_DATE || fmtMDY(new Date())).replace(/\//g, '-')}`;
    const files = [
      [`sms_edited_crashes_${tag}.csv`, result.editedCrashes],
      [`sms_crash_edit_events_${tag}.csv`, result.edits],
      [`sms_investigations_all.csv`, result.investigations],
      [`sms_reports_${result.cfg.REPORT_YEAR}.csv`, result.reports],
      [`sms_reports_without_investigation_${result.cfg.REPORT_YEAR}.csv`, result.reportsWithoutInvestigation],
    ];
    files.forEach(([name, rows], i) => setTimeout(() => downloadCsv(name, rows), i * 700));
  }

  function printSummary(res) {
    const h = (t) => console.log(`%c${t}`, 'font-weight:bold;font-size:13px;color:#0a58ca');
    const cols = (rows, keys) => rows.map((r) => Object.fromEntries(keys.map((k) => [k, r[k]])));

    h(`1) Crash edits: ${res.edits.length} edit(s) on ${res.editedCrashes.length} crash(es)`);
    console.log('   SMS keeps no "reason" for crash edits; WHAT_CHANGED + WORKING_ON + INVESTIGATIONS_AT_LOCATION show the context.');
    if (res.editedCrashes.length) {
      console.table(
        cols(res.editedCrashes, ['CRASH_ID', 'EDITS', 'LAST_EDIT', 'USERS', 'EDIT_TYPES', 'LAST_CHANGE', 'WORKING_ON', 'INVESTIGATIONS_AT_LOCATION']),
      );
    }

    h(`2) Investigations: ${res.investigations.length} total, ${res.investigationsInRange.length} created since ${res.cfg.START_DATE}`);
    if (res.investigationsInRange.length) {
      console.table(cols(res.investigationsInRange, ['INVEST_ID', 'NAME', 'CREATION_DATE', 'CREATED_BY', 'REASON', 'STATUS', 'REPORT_GROUPS_MATCHED']));
    }
    if (res.unparsedInvestigations.length) {
      console.warn(
        `   ${res.unparsedInvestigations.length} investigation(s) have no numeric COUNTY/ROUTE_TYPE/ROUTE_NUMBER and cannot be matched to reports. Sample:`,
        res.unparsedInvestigations[0].raw,
      );
    }

    const by = (k) => res.reports.filter((r) => r.HAS_INVESTIGATION === k).length;
    const noRoute = res.reports.filter((r) => r.HAS_INVESTIGATION.startsWith('n/a')).length;
    h(
      `3) Crash report PDFs in ${res.cfg.REPORT_YEAR}: ${res.reports.reduce((a, r) => a + r.RUNS, 0)} run(s) = ${res.reports.length} distinct report(s); ` +
        `${by('YES')} with an investigation, ${by('NO')} WITHOUT, ${noRoute} with no main route (cannot be matched)`,
    );
    if (res.reportsWithoutInvestigation.length) {
      console.table(
        cols(res.reportsWithoutInvestigation, ['FIRST_RUN', 'RUNS', 'USER', 'USER_HINT', 'REPORT_TYPE', 'LRS', 'BMP', 'EMP', 'INTERSECTION_MP', 'CROSSING_ROUTES', 'QUERY_CRASH_DATES']),
      );
    }
    if (res.crashListOnlyEvents.length) {
      console.log(`   (${res.crashListOnlyEvents.length} crash-list save(s) had no report header logged; see SMS_AUDIT.crashListOnlyEvents)`);
    }
    console.log('All data: window.SMS_AUDIT  |  download CSVs again: SMSAudit.download()');
  }

  async function run(overrides) {
    const cfg = { ...CONFIG, ...(overrides || {}) };
    const token = localStorage.getItem('token');
    const userId = localStorage.getItem('userID');
    if (!token) {
      console.error('No SMS login token in localStorage. Open https://smst.nts.scdot.net/SMS/, log in, and run this again on that tab.');
      return null;
    }
    if (!/scdot\.net$/i.test(location.hostname)) console.warn(`Running on ${location.hostname}; expected the SMS site.`);
    const get = makeClient(token);
    const start = parseMDY(cfg.START_DATE);
    const end = cfg.END_DATE ? parseMDY(cfg.END_DATE) : new Date(new Date().setHours(0, 0, 0, 0));
    console.log(`%cSMS audit on ${location.host}: logs ${fmtMDY(start)} - ${fmtMDY(end)}`, 'font-weight:bold');

    const rows = await fetchLogs(get, start, end, cfg);

    console.log('  investigations ...');
    let investigations = await get('SMS_Service/investigation/getAllInvestigations', { userId }).catch((e) => {
      console.warn('  getAllInvestigations failed:', e.message);
      return [];
    });
    if (!Array.isArray(investigations)) investigations = (investigations && investigations.results) || [];

    const users = await get('SMS_SERVICE/admin/getUsers').catch(() => []);

    const needs = lookupNeeds(rows, cfg);
    const codes = {};
    if (cfg.LOOKUP_CODES && needs.columns.length) {
      console.log(`  code lists for ${needs.columns.length} edited column(s) ...`);
      await mapLimit(needs.columns, 4, async (col) => {
        const list = await get('SMS_Service/query/getCodedList', { column_name: col }).catch(() => null);
        const map = codeMap(list);
        if (Object.keys(map).length) codes[col] = map;
      });
    }
    const crashDetails = {};
    if (cfg.FETCH_CRASH_DETAILS && needs.crashIds.length) {
      const ids = needs.crashIds.slice(0, cfg.MAX_CRASH_DETAILS);
      console.log(`  crash records for ${ids.length} edited crash(es) without a location in the edit ...`);
      await mapLimit(ids, 4, async (id) => {
        const data = await get('SMS_Service/query/getCrashData', { crash_id: id }).catch(() => null);
        if (data && typeof data === 'object') crashDetails[id] = flattenRecord(data);
      });
    }

    const result = analyze({ rows, investigations, users, codes, crashDetails }, cfg);
    result.raw = { investigations, users, codes, crashDetails };
    window.SMS_AUDIT = result;
    printSummary(result);
    if (cfg.DOWNLOAD_CSV) downloadAll(result);
    return result;
  }

  const api = {
    CONFIG,
    run,
    analyze,
    normRow,
    keepRow,
    lookupNeeds,
    parseSql,
    parseLrs,
    flattenRecord,
    toCsv,
    download: () => window.SMS_AUDIT && downloadAll(window.SMS_AUDIT),
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    window.SMSAudit = api;
    run().catch((e) => console.error('SMS audit failed:', e));
  }
})();
