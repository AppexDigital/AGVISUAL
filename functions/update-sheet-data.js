// functions/update-sheet-data.js
// v203.0 - FIX REFERENCE ERROR (Orden de Declaración Corregido)

const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { google } = require('googleapis');
const { validateGoogleToken } = require('./google-auth-helper');

// --- HELPERS ---
async function getServices() {
  const auth = new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive'],
  });
  const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, auth);
  await doc.loadInfo();
  return { doc, drive: google.drive({ version: 'v3', auth }) };
}

function getRealHeader(sheet, name) {
    if (!sheet || !sheet.headerValues) return undefined;
    const headers = sheet.headerValues;
    const target = String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    return headers.find(h => String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '') === target);
}

function getDataVal(dataObj, keyName) {
    if (!dataObj) return undefined;
    const target = keyName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const key = Object.keys(dataObj).find(k => k.toLowerCase().replace(/[^a-z0-9]/g, '') === target);
    return key ? dataObj[key] : undefined;
}

async function deleteChildRows(doc, childSheetName, parentIdHeader, parentIdValue) {
    try {
        const childSheet = doc.sheetsByTitle[childSheetName];
        if (!childSheet) return;
        await childSheet.loadHeaderRow();
        const rows = await childSheet.getRows();
        const header = getRealHeader(childSheet, parentIdHeader);
        if (!header) return;
        const rowsToDelete = rows.filter(r => String(r.get(header)).trim() === String(parentIdValue).trim());
        for (const row of rowsToDelete) { await row.delete(); }
    } catch (e) { console.warn(`Error cascada ${childSheetName}:`, e.message); }
}
// --- FIN HELPERS ---


exports.handler = async (event, context) => {
  if (!(await validateGoogleToken(event))) return { statusCode: 401, body: JSON.stringify({ error: 'No autorizado.' }) };
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  try {
    let body;
    try { body = JSON.parse(event.body); if (typeof body === 'string') body = JSON.parse(body); } catch (e) { throw new Error('JSON inválido.'); }
    const operations = Array.isArray(body) ? body : [body];
    const { doc, drive } = await getServices();

    // 1. Pre-procesar borrado de archivos (Drive)
    for (const op of operations) {
        if (op.action === 'delete_file_only' && op.data && op.data.fileId) {
            try {
                await drive.files.update({ fileId: op.data.fileId, requestBody: { trashed: true }, supportsAllDrives: true });
            } catch (e) { console.warn(`[Drive Warning] ${e.message}`); }
            op._processed = true; 
        }
    }

    // 2. Agrupar por hoja
    const opsBySheet = {};
    operations.forEach(op => {
        if (op._processed) return;
        if (!opsBySheet[op.sheet]) opsBySheet[op.sheet] = [];
        opsBySheet[op.sheet].push(op);
    });

    // 3. Procesar por hoja
    for (const sheetName of Object.keys(opsBySheet)) {
        const sheet = doc.sheetsByTitle[sheetName];
        if (!sheet) {
            console.warn(`Hoja '${sheetName}' no encontrada. Saltando operaciones.`);
            continue;
        }
        
        await sheet.loadHeaderRow();
        
        // --- CORRECCIÓN CRÍTICA: Declarar sheetOps AQUÍ, antes de usarlo ---
        const sheetOps = opsBySheet[sheetName];
        // ------------------------------------------------------------------
        
        // --- VALIDACIÓN ANTI-COLISIÓN (SOLO RESERVAS) ---
        if (sheetName === 'Bookings') {
            const bookingsToAddOrUpdate = sheetOps.filter(op => op.action === 'add' || op.action === 'update');
            
            if (bookingsToAddOrUpdate.length > 0) {
                const blockedSheet = doc.sheetsByTitle['BlockedDates'];
                
                if (blockedSheet) {
                    await blockedSheet.loadHeaderRow();
                    const blockedRows = await blockedSheet.getRows();
                    
                    const hStart = getRealHeader(blockedSheet, 'startDate');
                    const hEnd = getRealHeader(blockedSheet, 'endDate');
                    const hItem = getRealHeader(blockedSheet, 'itemId');
                    const hBook = getRealHeader(blockedSheet, 'bookingId');

                    if(hStart && hEnd && hItem) {
                        const blocks = blockedRows.map(r => ({
                            start: new Date(r.get(hStart)),
                            end: new Date(r.get(hEnd)),
                            itemId: r.get(hItem),
                            bookingId: hBook ? r.get(hBook) : null
                        }));

                        for (const op of bookingsToAddOrUpdate) {
                            if (op.data.status === 'Cancelado') continue;

                            const reqStart = new Date(op.data.startDate);
                            const reqEnd = new Date(op.data.endDate);
                            const reqItem = op.data.itemId;
                            const currentBookingId = op.criteria ? op.criteria.id : null;

                            const conflict = blocks.find(b => {
                                if (b.itemId !== reqItem) return false;
                                if (currentBookingId && b.bookingId && String(b.bookingId) === String(currentBookingId)) return false;
                                return reqStart <= b.end && reqEnd >= b.start;
                            });

                            if (conflict) {
                                throw new Error(`CONFLICTO: El equipo ya está reservado o bloqueado en esas fechas.`);
                            }
                        }
                    }
                } else {
                    console.warn("Aviso: Hoja 'BlockedDates' no detectada. Saltando validación anti-colisión.");
                }
            }
        }
        // --- FIN VALIDACIÓN ---

        const adds = sheetOps.filter(op => op.action === 'add');
        const updates = sheetOps.filter(op => op.action === 'update');
        const deletes = sheetOps.filter(op => op.action === 'delete');

        // --- A. ADDS ---
        for (const op of adds) {
            if (!op.data.id && !['Settings', 'About'].includes(sheetName)) {
                 op.data.id = `${sheetName.toLowerCase().slice(0, 5)}_${Date.now()}_${Math.floor(Math.random()*1000)}`;
            }
            const rowData = {};
            Object.keys(op.data).forEach(k => {
                const h = getRealHeader(sheet, k);
                if (h) rowData[h] = op.data[k];
            });
            await sheet.addRow(rowData); 
        }

        // --- B. UPDATES ---
        if (updates.length > 0) {
            const rows = await sheet.getRows(); 
            for (const op of updates) {
                const criteriaKey = Object.keys(op.criteria)[0];
                const criteriaVal = String(op.criteria[criteriaKey]).trim();
                const realHeaderKey = getRealHeader(sheet, criteriaKey);

                if (!realHeaderKey && ['Settings', 'About'].includes(sheetName)) {
                    await sheet.addRow({ ...op.criteria, ...op.data }); continue;
                }
                const targetRow = rows.find(r => String(r.get(realHeaderKey)).trim() === criteriaVal);

                if (targetRow) {
                    // Renombrado Drive
                    if (['Projects', 'RentalItems', 'Services'].includes(sheetName)) {
                        const titleKey = sheetName === 'RentalItems' ? 'name' : 'title';
                        const newTitle = getDataVal(op.data, titleKey);
                        if (newTitle) {
                            const hTitle = getRealHeader(sheet, titleKey);
                            const hFolder = getRealHeader(sheet, 'driveFolderId');
                            const currentTitle = hTitle ? targetRow.get(hTitle) : '';
                            const folderId = hFolder ? targetRow.get(hFolder) : null;
                            if (folderId && currentTitle !== newTitle) {
                                try { await drive.files.update({ fileId: folderId, requestBody: { name: newTitle }, supportsAllDrives: true }); } catch(e){}
                            }
                        }
                    }
                    // Portada Única
                    if ((sheetName === 'ProjectImages' || sheetName === 'RentalItemImages') && String(op.data.isCover).toLowerCase() === 'si') {
                        const pKey = sheetName === 'ProjectImages' ? 'projectId' : 'itemId';
                        const pHeader = getRealHeader(sheet, pKey);
                        const cHeader = getRealHeader(sheet, 'isCover');
                        if (pHeader && cHeader) {
                            const currentPId = targetRow.get(pHeader);
                            for (const r of rows) {
                                if (r !== targetRow && String(r.get(pHeader)) === String(currentPId) && String(r.get(cHeader)).toLowerCase() === 'si') {
                                    r.set(cHeader, 'No'); await r.save();
                                }
                            }
                        }
                    }
                    // Aplicar Cambios
                    let hasChanges = false;
                    Object.keys(op.data).forEach(key => {
                        const h = getRealHeader(sheet, key);
                        if (h) { targetRow.set(h, op.data[key]); hasChanges = true; }
                    });
                    if (hasChanges) await targetRow.save();
                }
            }
        }

        // --- C. DELETES ---
        if (deletes.length > 0) {
            const currentRows = await sheet.getRows(); 
            for (const op of deletes) {
                const criteriaKey = Object.keys(op.criteria)[0];
                const criteriaVal = String(op.criteria[criteriaKey]).trim();
                const realKeyHeader = getRealHeader(sheet, criteriaKey);
                if (!realKeyHeader) continue;

                if (sheetName === 'RentalCategories') {
                    const itemsSheet = doc.sheetsByTitle['RentalItems'];
                    if (itemsSheet) {
                        await itemsSheet.loadHeaderRow();
                        const allItems = await itemsSheet.getRows();
                        const catHeader = getRealHeader(itemsSheet, 'categoryId');
                        if (allItems.some(i => String(i.get(catHeader)).trim() === String(criteriaVal))) throw new Error(`⚠️ Categoría con equipos asociados.`);
                    }
                }

                const row = currentRows.find(r => String(r.get(realKeyHeader)).trim() === criteriaVal);
                if (row) {
                    let fileId = getDataVal(op.data, 'fileId');
                    if (!fileId) { const hFile = getRealHeader(sheet, 'fileId'); if (hFile) fileId = row.get(hFile); }
                    if (fileId) { try { await drive.files.update({ fileId: fileId, requestBody: { trashed: true }, supportsAllDrives: true }); } catch(e){} }

                    if (['Projects', 'RentalItems', 'Services'].includes(sheetName)) {
                        const hFolder = getRealHeader(sheet, 'driveFolderId');
                        const folderId = hFolder ? row.get(hFolder) : null;
                        if (folderId) { try { await drive.files.update({ fileId: folderId, requestBody: { trashed: true }, supportsAllDrives: true }); } catch(e){} }

                        if (sheetName === 'Projects') await deleteChildRows(doc, 'ProjectImages', 'projectId', criteriaVal);
                        if (sheetName === 'RentalItems') {
                            await deleteChildRows(doc, 'RentalItemImages', 'itemId', criteriaVal);
                            await deleteChildRows(doc, 'BlockedDates', 'itemId', criteriaVal);
                            await deleteChildRows(doc, 'Bookings', 'itemId', criteriaVal);
                        }
                        if (sheetName === 'Services') {
                            await deleteChildRows(doc, 'ServiceImages', 'serviceId', criteriaVal);
                            await deleteChildRows(doc, 'ServiceContentBlocks', 'serviceId', criteriaVal);
                        }
                    }
                    await row.delete();
                }
            }
        }
    }
    return { statusCode: 200, body: JSON.stringify({ message: 'OK' }) };
  } catch (error) {
    console.error('Error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};
