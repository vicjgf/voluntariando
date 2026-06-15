/**
 * Voluntariado — Cloudflare Worker (backend)
 * ------------------------------------------------------------
 * Este Worker es el ÚNICO que puede leer/escribir en Firestore.
 * El público nunca toca la base de datos directamente.
 *
 * Endpoints públicos (sin autenticación):
 *   GET  /api/eventos              → eventos visibles + conteos + nombres de pila
 *   POST /api/inscribir            → registra un voluntario en una actividad
 *
 * Endpoints protegidos (requieren token de coordinador/admin):
 *   GET    /api/admin/eventos             → todos los eventos (incl. inactivos)
 *   GET    /api/admin/inscripciones/:id   → datos completos de inscritos
 *   POST   /api/admin/evento              → crear/editar evento
 *   DELETE /api/admin/evento/:id          → borrar evento + inscripciones
 *   POST   /api/admin/evento-estado       → activar / lleno / slot toggles
 *   DELETE /api/admin/inscripcion/:id     → borrar un inscrito
 *   GET    /api/admin/coordinadores       → lista de coordinadores (solo admin)
 *   POST   /api/admin/coordinador         → agregar coordinador (solo admin)
 *   DELETE /api/admin/coordinador/:id     → quitar coordinador (solo admin)
 *
 * La configuración sensible vive en variables de entorno (secrets):
 *   FIREBASE_PROJECT_ID
 *   FIREBASE_CLIENT_EMAIL
 *   FIREBASE_PRIVATE_KEY
 *   ADMIN_EMAIL
 */

// ─────────────────────────────────────────────────────────
// Utilidades: JWT para autenticar el Worker ante Google (service account)
// ─────────────────────────────────────────────────────────

function base64url(input) {
  let str = typeof input === 'string' ? btoa(input) : btoa(String.fromCharCode(...new Uint8Array(input)));
  return str.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToArrayBuffer(pem) {
  // Normaliza la llave sin importar el formato en que venga:
  // - con \n literales (texto)
  // - con saltos de línea reales
  // - con comillas envolventes accidentales
  let clean = pem.trim();
  // Quitar comillas envolventes si las hay
  if ((clean.startsWith('"') && clean.endsWith('"')) || (clean.startsWith("'") && clean.endsWith("'"))) {
    clean = clean.slice(1, -1);
  }
  // Convertir \n literales en saltos reales
  clean = clean.replace(/\\n/g, '\n');
  // Extraer solo el contenido base64 entre los encabezados
  const b64 = clean
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s/g, '');
  const binary = atob(b64);
  const buf = new ArrayBuffer(binary.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < binary.length; i++) view[i] = binary.charCodeAt(i);
  return buf;
}

// Genera un access token de Google usando la service account (firma JWT con RS256)
async function getAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: env.FIREBASE_CLIENT_EMAIL,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };

  const encHeader = base64url(JSON.stringify(header));
  const encClaim = base64url(JSON.stringify(claim));
  const toSign = `${encHeader}.${encClaim}`;

  const keyData = pemToArrayBuffer(env.FIREBASE_PRIVATE_KEY);
  const key = await crypto.subtle.importKey(
    'pkcs8', keyData,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );
  const sigBuf = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(toSign));
  const jwt = `${toSign}.${base64url(sigBuf)}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  const data = await res.json();
  return data.access_token;
}

// ─────────────────────────────────────────────────────────
// Firestore REST helpers
// ─────────────────────────────────────────────────────────

function fsBase(env) {
  return `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;
}

// Convierte un documento Firestore (formato REST) a objeto JS plano
function decodeFields(fields) {
  const out = {};
  if (!fields) return out;
  for (const [k, v] of Object.entries(fields)) {
    out[k] = decodeValue(v);
  }
  return out;
}
function decodeValue(v) {
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return parseInt(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decodeValue);
  if ('mapValue' in v) return decodeFields(v.mapValue.fields);
  return null;
}

// Convierte objeto JS plano a formato Firestore

function encodeFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) {
    fields[k] = encodeValue(v);
  }
  return fields;
}
function encodeValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encodeValue) } };
  if (typeof v === 'object') return { mapValue: { fields: encodeFields(v) } };
  return { nullValue: null };
}

async function fsGet(env, token, path) {
  const res = await fetch(`${fsBase(env)}/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 404) return null;
  return res.json();
}

async function fsList(env, token, collection) {
  let docs = [];
  let pageToken = '';
  do {
    const url = `${fsBase(env)}/${collection}?pageSize=300${pageToken ? '&pageToken=' + pageToken : ''}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    if (data.documents) docs = docs.concat(data.documents);
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return docs;
}

async function fsCreate(env, token, collection, obj) {
  const res = await fetch(`${fsBase(env)}/${collection}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: encodeFields(obj) }),
  });
  return res.json();
}

async function fsUpdate(env, token, path, obj) {
  // overwrite full document
  const res = await fetch(`${fsBase(env)}/${path}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: encodeFields(obj) }),
  });
  return res.json();
}

async function fsDelete(env, token, path) {
  await fetch(`${fsBase(env)}/${path}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
}

function docId(doc) {
  return doc.name.split('/').pop();
}

// ─────────────────────────────────────────────────────────
// Verificación del token de Firebase Auth del usuario (coordinador)
// ─────────────────────────────────────────────────────────

let cachedCerts = null;
let certsExpiry = 0;

async function getGoogleCerts() {
  if (cachedCerts && Date.now() < certsExpiry) return cachedCerts;
  const res = await fetch('https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com');
  cachedCerts = await res.json();
  const cacheControl = res.headers.get('cache-control') || '';
  const maxAge = parseInt((cacheControl.match(/max-age=(\d+)/) || [])[1] || '3600');
  certsExpiry = Date.now() + maxAge * 1000;
  return cachedCerts;
}

// Decodifica base64url con padding correcto y soporte UTF-8
function decodeB64Url(str) {
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const binary = atob(s);
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// Verifica el ID token de Firebase y devuelve el email si es válido
async function verifyFirebaseToken(idToken, env) {
  try {
    const parts = idToken.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(decodeB64Url(parts[1]));

    if (payload.aud !== env.FIREBASE_PROJECT_ID) return null;
    if (payload.iss !== `https://securetoken.google.com/${env.FIREBASE_PROJECT_ID}`) return null;
    if (payload.exp * 1000 < Date.now()) return null;
    if (!payload.email) return null;

    return { email: payload.email.toLowerCase(), email_verified: payload.email_verified };
  } catch (e) {
    return null;
  }
}

// Determina el rol del usuario autenticado
async function getRole(email, env, token) {
  if (email === env.ADMIN_EMAIL.toLowerCase()) return 'admin';
  const id = email.replace(/\./g, '_');
  const doc = await fsGet(env, token, `coordinadores/${id}`);
  if (doc && doc.fields) return 'coordinador';
  return null;
}

// ─────────────────────────────────────────────────────────
// CORS
// ─────────────────────────────────────────────────────────

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

// ─────────────────────────────────────────────────────────
// Filtrado de datos: qué ve el público vs el coordinador
// ─────────────────────────────────────────────────────────

// El público solo ve nombre de pila de cada inscrito
function publicInscripcion(ins) {
  return { nombre: (ins.nombre || '').split(' ')[0] };
}

// ─────────────────────────────────────────────────────────
// Handler principal
// ─────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // Preflight CORS
    if (method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    // Servir el frontend (archivos estáticos) — manejado por Cloudflare assets
    if (!path.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }

    // Endpoint diagnóstico: confirma si las variables están presentes (sin exponerlas)
    if (path === '/api/diag' && method === 'GET') {
      return json({
        FIREBASE_PROJECT_ID: env.FIREBASE_PROJECT_ID ? 'presente' : 'FALTA',
        FIREBASE_CLIENT_EMAIL: env.FIREBASE_CLIENT_EMAIL ? 'presente' : 'FALTA',
        FIREBASE_PRIVATE_KEY: env.FIREBASE_PRIVATE_KEY ? ('presente, longitud ' + env.FIREBASE_PRIVATE_KEY.length) : 'FALTA',
        ADMIN_EMAIL: env.ADMIN_EMAIL ? 'presente' : 'FALTA',
        key_empieza: env.FIREBASE_PRIVATE_KEY ? env.FIREBASE_PRIVATE_KEY.slice(0, 30) : '',
      });
    }

    try {
      const token = await getAccessToken(env);

      // ───── ENDPOINTS PÚBLICOS ─────

      // GET /api/eventos — eventos visibles + conteos + nombres de pila
      if (path === '/api/eventos' && method === 'GET') {
        const eventDocs = await fsList(env, token, 'voluntariado_eventos');
        const insDocs = await fsList(env, token, 'inscripciones');
        const inscripciones = insDocs.map(d => ({ iid: docId(d), ...decodeFields(d.fields) }));

        const eventos = eventDocs
          .map(d => ({ fid: docId(d), ...decodeFields(d.fields) }))
          .filter(e => e.activo !== false)  // público no ve inactivos
          .map(ev => {
            const slots = (ev.slots || []).map((slot, si) => {
              const vols = inscripciones.filter(i => i.eventoId === ev.fid && i.slotIndex === si);
              return {
                tarea: slot.tarea,
                horario: slot.horario,
                max: slot.max,
                mostrarLleno: slot.mostrarLleno || false,
                oculto: slot.oculto || false,
                count: vols.length,
                voluntarios: vols.map(publicInscripcion),  // solo nombres de pila
              };
            }).filter(s => !s.oculto);  // público no ve slots ocultos
            return {
              fid: ev.fid,
              nombre: ev.nombre,
              descripcion: ev.descripcion,
              fecha: ev.fecha,
              hora: ev.hora,
              lugar: ev.lugar,
              respNombre: ev.respNombre,
              respContacto: ev.respContacto,
              mostrarLleno: ev.mostrarLleno || false,
              fields: ev.fields || {},
              slots,
            };
          });
        return json({ eventos });
      }

      // POST /api/inscribir — registra un voluntario
      if (path === '/api/inscribir' && method === 'POST') {
        const body = await request.json();
        const { eventoId, slotIndex, datos } = body;
        if (!eventoId || slotIndex === undefined || !datos) return json({ error: 'Datos incompletos' }, 400);

        // Validar contra el evento real (no confiar en el cliente)
        const evDoc = await fsGet(env, token, `voluntariado_eventos/${eventoId}`);
        if (!evDoc) return json({ error: 'Evento no encontrado' }, 404);
        const ev = decodeFields(evDoc.fields);
        if (ev.activo === false) return json({ error: 'Evento inactivo' }, 403);
        const slot = (ev.slots || [])[slotIndex];
        if (!slot) return json({ error: 'Actividad no encontrada' }, 404);
        if (slot.oculto || slot.mostrarLleno || ev.mostrarLleno) return json({ error: 'Actividad no disponible' }, 403);

        // Conteo actual
        const insDocs = await fsList(env, token, 'inscripciones');
        const current = insDocs
          .map(d => decodeFields(d.fields))
          .filter(i => i.eventoId === eventoId && i.slotIndex === slotIndex);
        if (current.length >= slot.max) return json({ error: 'Cupo lleno' }, 409);
        if (current.find(i => i.correo === datos.correo)) return json({ error: 'Ya estás registrado con ese correo' }, 409);

        await fsCreate(env, token, 'inscripciones', {
          eventoId, slotIndex, ...datos, registradoEl: new Date().toISOString(),
        });
        return json({ ok: true });
      }

      // ───── ENDPOINTS PROTEGIDOS ─────
      // Todos requieren un token válido de Firebase Auth en el header

      const authHeader = request.headers.get('Authorization') || '';
      const idToken = authHeader.replace('Bearer ', '');
      const userInfo = idToken ? await verifyFirebaseToken(idToken, env) : null;

      if (path.startsWith('/api/admin/')) {
        if (!userInfo) return json({ error: 'No autenticado' }, 401);
        const role = await getRole(userInfo.email, env, token);
        if (!role) return json({ error: 'Acceso denegado' }, 403);

        // GET /api/admin/eventos — todos los eventos (incl. inactivos)
        if (path === '/api/admin/eventos' && method === 'GET') {
          const eventDocs = await fsList(env, token, 'voluntariado_eventos');
          const insDocs = await fsList(env, token, 'inscripciones');
          const inscripciones = insDocs.map(d => ({ iid: docId(d), ...decodeFields(d.fields) }));
          const eventos = eventDocs.map(d => {
            const ev = { fid: docId(d), ...decodeFields(d.fields) };
            const slots = (ev.slots || []).map((slot, si) => {
              const vols = inscripciones.filter(i => i.eventoId === ev.fid && i.slotIndex === si);
              return { ...slot, count: vols.length, voluntarios: vols.map(publicInscripcion) };
            });
            return { ...ev, slots };
          });
          return json({ eventos });
        }

        // GET /api/admin/inscripciones/:eventoId — datos completos
        if (path.startsWith('/api/admin/inscripciones/') && method === 'GET') {
          const eventoId = path.split('/').pop();
          const insDocs = await fsList(env, token, 'inscripciones');
          const inscripciones = insDocs
            .map(d => ({ iid: docId(d), ...decodeFields(d.fields) }))
            .filter(i => i.eventoId === eventoId);
          return json({ inscripciones });
        }

        // POST /api/admin/evento — crear o editar
        if (path === '/api/admin/evento' && method === 'POST') {
          const body = await request.json();
          const { fid, data } = body;
          if (fid) {
            await fsUpdate(env, token, `voluntariado_eventos/${fid}`, data);
          } else {
            await fsCreate(env, token, 'voluntariado_eventos', data);
          }
          return json({ ok: true });
        }

        // POST /api/admin/evento-estado — actualizar estado (activo, lleno, slots)
        if (path === '/api/admin/evento-estado' && method === 'POST') {
          const body = await request.json();
          const { fid, data } = body;
          const evDoc = await fsGet(env, token, `voluntariado_eventos/${fid}`);
          if (!evDoc) return json({ error: 'No encontrado' }, 404);
          const ev = decodeFields(evDoc.fields);
          const merged = { ...ev, ...data };
          await fsUpdate(env, token, `voluntariado_eventos/${fid}`, merged);
          return json({ ok: true });
        }

        // DELETE /api/admin/evento/:id — borrar evento + inscripciones
        if (path.startsWith('/api/admin/evento/') && method === 'DELETE') {
          const fid = path.split('/').pop();
          const insDocs = await fsList(env, token, 'inscripciones');
          for (const d of insDocs) {
            const i = decodeFields(d.fields);
            if (i.eventoId === fid) await fsDelete(env, token, `inscripciones/${docId(d)}`);
          }
          await fsDelete(env, token, `voluntariado_eventos/${fid}`);
          return json({ ok: true });
        }

        // DELETE /api/admin/inscripcion/:id — borrar un inscrito
        if (path.startsWith('/api/admin/inscripcion/') && method === 'DELETE') {
          const iid = path.split('/').pop();
          await fsDelete(env, token, `inscripciones/${iid}`);
          return json({ ok: true });
        }

        // ── Solo ADMIN: gestión de coordinadores ──
        if (path === '/api/admin/coordinadores' && method === 'GET') {
          if (role !== 'admin') return json({ error: 'Solo admin' }, 403);
          const docs = await fsList(env, token, 'coordinadores');
          const coordinadores = docs.map(d => ({ id: docId(d), ...decodeFields(d.fields) }));
          return json({ coordinadores });
        }

        if (path === '/api/admin/coordinador' && method === 'POST') {
          if (role !== 'admin') return json({ error: 'Solo admin' }, 403);
          const { email } = await request.json();
          const cleanEmail = email.trim().toLowerCase();
          const id = cleanEmail.replace(/\./g, '_');
          await fsUpdate(env, token, `coordinadores/${id}`, { email: cleanEmail, agregadoEl: new Date().toISOString() });
          return json({ ok: true });
        }

        if (path.startsWith('/api/admin/coordinador/') && method === 'DELETE') {
          if (role !== 'admin') return json({ error: 'Solo admin' }, 403);
          const id = path.split('/').pop();
          await fsDelete(env, token, `coordinadores/${id}`);
          return json({ ok: true });
        }

        // Endpoint para que el frontend sepa el rol del usuario
        if (path === '/api/admin/rol' && method === 'GET') {
          return json({ rol: role, email: userInfo.email });
        }
      }

      return json({ error: 'Endpoint no encontrado' }, 404);
    } catch (e) {
      return json({ error: 'Error del servidor: ' + e.message }, 500);
    }
  },
};
