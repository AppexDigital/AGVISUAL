// functions/update-sheet-data.js
// v13.0 - BORRADO EN ORDEN CORRECTO (Drive -> Sheet)
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { google } = require('googleapis');
const { validateGoogleToken } = require('./google-auth-helper');

exports.handler = async (event, context) => {
  // 1. Seguridad
  if (!(await validateGoogleToken(event))) {
    return { statusCode: 401, body: JSON.stringify({ error: 'No autorizado.' }) };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  try {
    const { sheet: sheetTitle, action, data, criteria } = JSON.parse(event.body);

    // 2. Conexión
    const auth = new JWT({
      email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive'],
    });

    const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, auth);
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle[sheetTitle];
    if (!sheet) return { statusCode: 404, body: JSON.stringify({ error: 'Hoja no encontrada' }) };
    
    await sheet.loadHeaderRow();
    const headers = sheet.headerValues;

    // --- ADD ---
    if (action === 'add') {
        if (!data.id) data.id = `${sheetTitle.toLowerCase().slice(0, 5)}_${Date.now()}`;
        
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
        
        const cleanData = {};
        headers.forEach(h => { if (data[h] !== undefined) cleanData[h] = data[h]; });
        cleanData['id'] = data.id;
        await sheet.addRow(cleanData);
        
        return { statusCode: 200, body: JSON.stringify({ message: 'OK', newId: data.id }) };
    }

    // --- BUSCAR FILA (Para Update y Delete) ---
    const rows = await sheet.getRows();
    const key = Object.keys(criteria)[0];
    const row = rows.find(r => String(r.get(key)) === String(criteria[key]));

    if (!row) return { statusCode: 404, body: JSON.stringify({ error: 'Registro no encontrado.' }) };

    // --- UPDATE ---
    if (action === 'update') {
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

    // --- DELETE (La parte crítica corregida) ---
    if (action === 'delete') {
        const drive = google.drive({ version: 'v3', auth });

        // 1. CAPTURAR IDs ANTES DE BORRAR LA FILA
        const fileId = row.get('fileId'); 
        const folderId = row.get('driveFolderId');

        // 2. BORRAR DE DRIVE (Intento)
        if (fileId) {
            try {
                await drive.files.delete({ fileId: fileId, supportsAllDrives: true });
                console.log(`Archivo ${fileId} eliminado de Drive.`);
            } catch (e) {
                console.warn(`No se pudo borrar archivo ${fileId} (posiblemente ya no existe):`, e.message);
            }
        }

        // Borrar Carpeta (Si es Proyecto/Item)
        if ((sheetTitle === 'Projects' || sheetTitle === 'RentalItems') && folderId) {
            try {
                await drive.files.delete({ fileId: folderId, supportsAllDrives: true });
                console.log(`Carpeta ${folderId} eliminada de Drive.`);
            } catch (e) {
                console.warn(`No se pudo borrar carpeta ${folderId}:`, e.message);
            }
        }

        // 3. BORRAR DE SHEETS (Finalización)
        await row.delete();
        
        return { statusCode: 200, body: JSON.stringify({ message: 'OK' }) };
    }

    return { statusCode: 400, body: JSON.stringify({ error: 'Acción desconocida' }) };

  } catch (error) {
    console.error('Backend Error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};
