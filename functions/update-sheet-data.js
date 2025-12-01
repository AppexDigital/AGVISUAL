// functions/update-sheet-data.js
// v10.1 - CORRECCIÓN DE SEGURIDAD Y VALIDACIÓN
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { google } = require('googleapis');
const { validateGoogleToken } = require('./google-auth-helper');

exports.handler = async (event, context) => {
  // 1. Seguridad Básica
  if (!(await validateGoogleToken(event))) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Token inválido o expirado.' }) };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  try {
    // 2. Parseo y Validación del Cuerpo
    let body;
    try {
        body = JSON.parse(event.body);
    } catch (e) {
        return { statusCode: 400, body: JSON.stringify({ error: 'JSON del cuerpo inválido.' }) };
    }

    const { sheet: sheetTitle, action, data, criteria } = body;

    // ---> VALIDACIÓN CRÍTICA <---
    if (!sheetTitle || sheetTitle === 'undefined' || sheetTitle === 'null') {
        return { statusCode: 400, body: JSON.stringify({ error: 'Falta el parámetro obligatorio "sheet" (nombre de la hoja).' }) };
    }
    // ---------------------------

    // 3. Autenticación con Google
    const auth = new JWT({
      email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive'],
    });

    const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, auth);
    await doc.loadInfo();

    const sheet = doc.sheetsByTitle[sheetTitle];
    if (!sheet) {
        // Si el nombre de la hoja no existe en el Sheet
        return { statusCode: 404, body: JSON.stringify({ error: `La hoja "${sheetTitle}" no se encontró en el documento.` }) };
    }
    
    await sheet.loadHeaderRow();
    const headers = sheet.headerValues;

    // 4. Lógica de Acciones (CRUD)
    if (action === 'add') {
        if (!data.id) data.id = `${sheetTitle.toLowerCase().slice(0, 5)}_${Date.now()}`;

        const cleanData = {};
        headers.forEach(h => { if (data[h] !== undefined) cleanData[h] = data[h]; });
        cleanData['id'] = data.id; 

        // Lógica Portada Única
        if ((sheetTitle === 'ProjectImages' || sheetTitle === 'RentalItemImages') && data.isCover === 'Si') {
           const rows = await sheet.getRows();
           const parentKey = sheetTitle === 'ProjectImages' ? 'projectId' : 'itemId';
           for (const r of rows) { 
               if (r.get(parentKey) === data[parentKey] && r.get('isCover') === 'Si') { 
                   r.set('isCover', 'No'); await r.save(); 
               } 
           }
        }

        await sheet.addRow(cleanData);
        return { statusCode: 200, body: JSON.stringify({ message: 'OK', newId: data.id }) };
    }

    // Búsqueda de fila para Update/Delete
    const rows = await sheet.getRows();
    const key = Object.keys(criteria)[0];
    const row = rows.find(r => String(r.get(key)) === String(criteria[key]));

    if (!row) return { statusCode: 404, body: JSON.stringify({ error: 'Registro no encontrado para actualizar/borrar.' }) };

    if (action === 'update') {
        // Lógica Portada Única
        if ((sheetTitle === 'ProjectImages' || sheetTitle === 'RentalItemImages') && data.isCover === 'Si') {
             const parentKey = sheetTitle === 'ProjectImages' ? 'projectId' : 'itemId';
             const parentId = row.get(parentKey);
             for (const r of rows) {
                 if (r.get(parentKey) === parentId && r.get('id') !== row.get('id') && r.get('isCover') === 'Si') {
                     r.set('isCover', 'No'); await r.save();
                 }
             }
        }

        Object.keys(data).forEach(k => { if (headers.includes(k)) row.set(k, data[k]); });
        await row.save();
        return { statusCode: 200, body: JSON.stringify({ message: 'OK' }) };
    }

    if (action === 'delete') {
        const drive = google.drive({ version: 'v3', auth });

        // A. Borrar Archivo
        const fileId = row.get('fileId');
        if (fileId) {
            try { await drive.files.delete({ fileId, supportsAllDrives: true }); } catch (e) { console.warn('Error borrando archivo Drive:', e.message); }
        }

        // B. Borrar Carpeta
        const folderId = row.get('driveFolderId');
        if (folderId) {
            try { await drive.files.delete({ fileId: folderId, supportsAllDrives: true }); } catch (e) { console.warn('Error borrando carpeta Drive:', e.message); }
        }

        await row.delete();
        return { statusCode: 200, body: JSON.stringify({ message: 'OK' }) };
    }

    return { statusCode: 400, body: JSON.stringify({ error: `Acción "${action}" desconocida.` }) };

  } catch (error) {
    console.error('Critical Backend Error:', error);
    // Devolver el mensaje de error exacto para depuración
    return { statusCode: 500, body: JSON.stringify({ error: error.message || 'Error interno crítico.' }) };
  }
};
