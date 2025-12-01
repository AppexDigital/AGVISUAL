// functions/update-sheet-data.js
// v10.0 - ESTABILIDAD MÁXIMA Y FILTRADO DE DATOS
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { google } = require('googleapis');
const { validateGoogleToken } = require('./google-auth-helper');

exports.handler = async (event, context) => {
  // 1. Seguridad
  if (!(await validateGoogleToken(event))) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Token inválido o expirado.' }) };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  try {
    const { sheet: sheetTitle, action, data, criteria } = JSON.parse(event.body);

    // 2. Autenticación Robusta
    const auth = new JWT({
      email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive'],
    });

    const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, auth);
    await doc.loadInfo();

    const sheet = doc.sheetsByTitle[sheetTitle];
    if (!sheet) throw new Error(`Hoja "${sheetTitle}" no encontrada.`);
    
    await sheet.loadHeaderRow();
    const headers = sheet.headerValues; // Obtener headers reales

    // 3. Lógica CRUD
    if (action === 'add') {
        if (!data.id) data.id = `${sheetTitle.toLowerCase().slice(0, 5)}_${Date.now()}`;

        // Limpieza de datos: Solo guardar campos que existen en los headers del Sheet
        const cleanData = {};
        headers.forEach(h => {
            if (data[h] !== undefined) cleanData[h] = data[h];
        });
        // Asegurar que el ID siempre vaya
        cleanData['id'] = data.id; 

        // Lógica Portada Única (Solo para imágenes)
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

    if (!row) return { statusCode: 404, body: JSON.stringify({ error: 'Registro no encontrado.' }) };

    if (action === 'update') {
        // Lógica Portada Única en Update
        if ((sheetTitle === 'ProjectImages' || sheetTitle === 'RentalItemImages') && data.isCover === 'Si') {
             const parentKey = sheetTitle === 'ProjectImages' ? 'projectId' : 'itemId';
             const parentId = row.get(parentKey);
             // Recorrer rows ya cargados
             for (const r of rows) {
                 if (r.get(parentKey) === parentId && r.get('id') !== row.get('id') && r.get('isCover') === 'Si') {
                     r.set('isCover', 'No'); await r.save();
                 }
             }
        }

        Object.keys(data).forEach(k => { 
            if (headers.includes(k)) row.set(k, data[k]); 
        });
        await row.save();
        return { statusCode: 200, body: JSON.stringify({ message: 'OK' }) };
    }

    if (action === 'delete') {
        // Lógica de Drive (Eliminación física)
        const drive = google.drive({ version: 'v3', auth });

        // A. Borrar Archivo (Si tiene fileId)
        const fileId = row.get('fileId');
        if (fileId) {
            try { await drive.files.delete({ fileId, supportsAllDrives: true }); } catch (e) { console.warn('Error borrando archivo Drive:', e.message); }
        }

        // B. Borrar Carpeta (Si es Proyecto/Item)
        const folderId = row.get('driveFolderId');
        if (folderId) {
            try { await drive.files.delete({ fileId: folderId, supportsAllDrives: true }); } catch (e) { console.warn('Error borrando carpeta Drive:', e.message); }
        }

        await row.delete();
        return { statusCode: 200, body: JSON.stringify({ message: 'OK' }) };
    }

    return { statusCode: 400, body: JSON.stringify({ error: 'Acción desconocida' }) };

  } catch (error) {
    console.error('Sheet Error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message || 'Error interno del servidor' }) };
  }
};
